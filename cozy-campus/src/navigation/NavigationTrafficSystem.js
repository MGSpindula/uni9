import { AnimationPresets } from "../core/AnimationPresets";
import { Tween } from "../core/Tween";
import { NavigationDepartureQueue } from "./NavigationDepartureQueue";
import { NavigationNodeMode } from "./NavigationNodeMode";
import { WaitReason, WaitReasonLabel } from "./WaitReason";

export class NavigationTrafficSystem {

    constructor(owner) {

        this.owner = owner;
        this.graph = owner.graph;
        this.departures = new NavigationDepartureQueue();
        this.arrivals = new NavigationDepartureQueue();
        this.waitReasons = new Map();

    }

    // -----------------------------
    // Connection entry
    // -----------------------------

    prequeueUpcomingTransit(actor) {

        const traversal = actor.navigation.getTraversalState();

        if (!traversal.currentConnection) return;

        const [arrivalId, nextId] = actor.navigation.getUpcomingNodeIds(2);

        if (!arrivalId || !nextId ||
            !this.graph.hasNode(arrivalId) ||
            !this.graph.hasNode(nextId) ||
            !this.graph.areConnected(arrivalId, nextId) ||
            this.graph.isNodeBlocked(arrivalId) ||
            this.graph.isNodeBlocked(nextId) ||
            this.graph.isConnectionBlocked(arrivalId, nextId)) return;

        // This reserves only queue order, not the lane or destination node.
        // Temporary occupancy is rechecked at the actual handoff.
        this.departures.enqueue(
            arrivalId,
            actor,
            { priority: this.getActorPriority(actor, 1) }
        );

    }

    preflightDeparture(actor, originId, toId = null) {

        if (!originId) return false;

        if (this.graph.isNodeBlocked(originId)) {

            this.setWaitReason(actor, originId, WaitReason.HARD_BLOCKED);
            return false;

        }

        if (toId) {

            const connection = this.graph.requireConnection(originId, toId);

            if (this.graph.isNodeBlocked(toId) || connection.blocked) {

                this.setWaitReason(actor, originId, WaitReason.HARD_BLOCKED);
                return false;

            }

        }

        const context = this.owner.requireContext(actor);

        this.departures.enqueue(originId, actor, {
            priority: this.getActorPriority(
                actor,
                context.nodeMode === NavigationNodeMode.TRANSIT ? 1 : 0
            )
        });

        if (!this.departures.isFirst(originId, actor)) {

            this.setWaitReason(actor, originId, WaitReason.QUEUE_HEAD);

        } else {

            this.setWaitReason(actor, originId, WaitReason.QUEUE_FIRST);

        }

        return true;

    }

    tryStartConnection(actor, fromId, toId, waypoint = null) {

        // Routes can become stale after topology/debug changes. Never let one
        // invalid segment stop the entire Scene update loop.
        if (!this.graph.hasNode(fromId) ||
            !this.graph.hasNode(toId) ||
            !this.graph.areConnected(fromId, toId)) {

            this.owner.rejectInvalidSegment(actor, fromId, toId);
            return false;

        }

        const connection = this.graph.requireConnection(fromId, toId);
        const context = this.owner.requireContext(actor);

        // Hard blocks cannot become available by waiting and must never retain
        // the head of a departure queue. Temporary occupancy may be queued.
        if (this.graph.isNodeBlocked(fromId) ||
            this.graph.isNodeBlocked(toId) ||
            connection.blocked) {

            this.departures.cancel(actor);
            this.setWaitReason(actor, fromId, WaitReason.HARD_BLOCKED);
            return false;

        }

        this.departures.enqueue(fromId, actor, {
            priority: this.getActorPriority(
                actor,
                context.nodeMode === NavigationNodeMode.TRANSIT ? 1 : 0
            )
        });
        this.arrivals.enqueue(toId, actor, {
            priority: this.getActorPriority(actor, 1)
        });

        if (!this.departures.isFirst(fromId, actor)) {

            this.setWaitReason(actor, fromId, WaitReason.QUEUE_HEAD);
            return false;

        }


        const laneIndex = this.graph.reserveConnectionLane(
            fromId,
            toId,
            actor
        );

        if (laneIndex === null) {

            this.setWaitReason(actor, fromId, WaitReason.LANE_FULL);
            return false;

        }


        const endpointReserved = this.graph.reserveNodeForTransit(toId, actor);
        if (!endpointReserved) {
            this.setWaitReason(actor, toId, WaitReason.ENDPOINT_WAIT);
        }

        // Dwell exit is prepared only after the lane and destination have been
        // secured. During its animation the actor still owns the spot/node.
        if (!this.owner.prepareDwellExit(context)) return false;

        const laneStart = this.graph.getConnectionLaneNodePosition(
            fromId,
            fromId,
            toId,
            laneIndex
        );
        const laneEnd = this.graph.getConnectionLaneNodePosition(
            toId,
            fromId,
            toId,
            laneIndex
        );
        const nextWaypoint = actor.navigation.getNextWaypoint();
        const nextNodeId = nextWaypoint?.id &&
            this.graph.hasNode(nextWaypoint.id) &&
            this.graph.areConnected(toId, nextWaypoint.id)
            ? nextWaypoint.id
            : null;
        const arrivalDirection = nextNodeId
            ? this.createTransitTangent(fromId, toId, nextNodeId)
            : null;
        const storedTangent = context.transitTangent;
        const departureDirection =
            storedTangent?.nodeId === fromId &&
            storedTangent?.nextNodeId === toId
                ? storedTangent.direction
                : null;
        const curveWaypoints = waypoint
            ? this.createLaneCurveWaypoints(
                actor.object3D.position,
                laneStart,
                laneEnd,
                10,
                { departureDirection, arrivalDirection }
            )
            : [];

        if (connection.metadata.traversal === "slope") {

            // The base floor exists below both test ramps. Slope samples must
            // select the upper raycast hit, otherwise they project back onto
            // the base and visually/semantically remain at Y=0.
            this.owner.projectWaypointsToGround(curveWaypoints, {
                preferHighest: true
            });

        }

        // The arriving and departing curves consume the same tangent at this
        // transit node. The handle arms lie on opposite sides of the join,
        // providing C1 continuity without moving through the node center.
        context.transitTangent = arrivalDirection
            ? {
                nodeId: toId,
                nextNodeId,
                direction: arrivalDirection.clone()
            }
            : null;

        if (curveWaypoints.length > 0) {

            this.graph.setActiveLaneCurve(actor, [
                actor.object3D.position,
                ...curveWaypoints.map(candidate => candidate.position),
                laneEnd
            ]);

        }

        this.owner.centerActorForDeparture(context);
        context.nodeMode = NavigationNodeMode.TRANSIT;
        context.currentTraversal = connection.metadata.traversal ?? "flat";
        actor.traversalType = context.currentTraversal;
        this.graph.occupyConnectionLane(fromId, toId, actor, laneIndex);

        if (waypoint) {

            waypoint.position.copy(laneEnd);

        }
        this.owner.releaseDwellOccupancy(actor);
        this.graph.releaseNode(fromId, actor);
        this.owner.retryFreedDwellSpot(fromId, actor);
        // Every clearance request attached to this actor asked it to vacate
        // fromId. Entering the connection fulfills all of them, including a
        // node swap with the actor at the opposite endpoint.
        this.departures.complete(fromId, actor);
        this.clearWaitReason(actor);
        this.owner.refresh();

        if (curveWaypoints.length > 0) {

            actor.navigation.insertManyBeforeCurrent(curveWaypoints);
            actor.navigation.beginConnection(fromId, toId);
            context.traversingLaneCurve = true;
            return false;

        }

        return true;

    }

    tryLeaveNodeForInteraction(
        actor,
        originId,
        waypoint = null,
        transitionTarget = null
    ) {

        const context = this.owner.requireContext(actor);

        if (this.graph.isNodeBlocked(originId)) {

            this.departures.cancel(actor);
            this.setWaitReason(actor, originId, WaitReason.HARD_BLOCKED);
            return false;

        }

        this.departures.enqueue(originId, actor, {
            priority: this.getActorPriority(
                actor,
                context.nodeMode === NavigationNodeMode.TRANSIT ? 1 : 0
            )
        });

        if (!this.departures.isFirst(originId, actor)) {

            this.setWaitReason(actor, originId, WaitReason.QUEUE_HEAD);
            return false;

        }

        if (!this.owner.prepareDwellExit(context)) return false;

        if (actor.visual && Math.abs(actor.visual.position.x) > 0.01) {

            this.moveVisualToCenter(actor);
            this.setWaitReason(actor, originId, WaitReason.REALIGNING);
            return false;

        }

        if (waypoint && !context.traversingInteractionCurve) {

            const curveWaypoints = this.createInteractionCurveWaypoints(
                actor.object3D.position,
                waypoint.position,
                transitionTarget
            );

            if (curveWaypoints.length > 0) {

                this.graph.setActiveLaneCurve(actor, [
                    actor.object3D.position,
                    ...curveWaypoints.map(candidate => candidate.position),
                    waypoint.position
                ]);
                actor.navigation.insertManyBeforeCurrent(curveWaypoints);
                context.traversingInteractionCurve = true;
                this.owner.refresh();
                return false;

            }

        }

        context.nodeMode = NavigationNodeMode.TRANSIT;
        this.owner.centerActorForDeparture(context);
        this.clearWaitReason(actor);
        return true;

    }

    completeNodeDeparture(actor, originId) {

        this.departures.complete(originId, actor);

    }

    tryExitConnectionForInteraction(actor) {

        if (actor.visual && Math.abs(actor.visual.position.x) > 0.01) {

            this.moveVisualToCenter(actor);
            this.setWaitReason(actor, "connection", WaitReason.REALIGNING);
            return false;

        }

        this.clearWaitReason(actor);
        return true;

    }

    tryEnterFromInteraction(
        actor,
        { fromId, toId, originKey, anchorId = null },
        waypoint = null
    ) {

        if (actor.navigation.getTraversalState().currentConnection) return true;

        const connection = this.graph.requireConnection(fromId, toId);

        if (this.graph.isNodeBlocked(toId) || connection.blocked) {

            this.departures.cancel(actor);
            this.setWaitReason(actor, originKey, WaitReason.HARD_BLOCKED);
            return false;

        }

        this.departures.enqueue(originKey, actor, {
            priority: this.getActorPriority(actor)
        });
        this.arrivals.enqueue(toId, actor, {
            priority: this.getActorPriority(actor, 1)
        });

        if (!this.departures.isFirst(originKey, actor)) {

            this.setWaitReason(actor, originKey, WaitReason.QUEUE_HEAD);
            return false;

        }

        const context = this.owner.requireContext(actor);
        const anchor = anchorId
            ? this.owner.connector.anchors.get(anchorId)
            : null;
        const approachLaneIndex = anchor
            ? anchor.lanePositions.reduce((closestIndex, position, index) =>
                position.distanceToSquared(actor.object3D.position) <
                anchor.lanePositions[closestIndex].distanceToSquared(
                    actor.object3D.position
                ) ? index : closestIndex
            , 0)
            : null;
        const laneIndex = approachLaneIndex === null
            ? this.graph.reserveConnectionLane(fromId, toId, actor)
            : this.graph.reserveSpecificConnectionLane(
                fromId,
                toId,
                approachLaneIndex,
                actor
            );

        if (laneIndex === null) {

            this.setWaitReason(actor, originKey, WaitReason.LANE_FULL);
            return false;

        }


        if (!this.graph.reserveNodeForTransit(toId, actor)) {
            this.setWaitReason(actor, toId, WaitReason.ENDPOINT_WAIT);
        }

        const portal = anchor?.lanePositions[laneIndex]?.clone() ??
            waypoint?.position.clone();
        const laneEnd = this.graph.getConnectionLaneNodePosition(
            toId,
            fromId,
            toId,
            laneIndex
        );

        if (waypoint && portal && !context.traversingInteractionCurve) {

            waypoint.position.copy(portal);
            const interactionCurve = this.createInteractionCurveWaypoints(
                actor.object3D.position,
                portal,
                laneEnd
            );

            if (interactionCurve.length > 0) {

                this.graph.setActiveLaneCurve(actor, [
                    actor.object3D.position,
                    ...interactionCurve.map(candidate => candidate.position),
                    portal
                ]);
                actor.navigation.insertManyBeforeCurrent(interactionCurve);
                context.traversingInteractionCurve = true;
                this.owner.refresh();
                return false;

            }

        }

        this.graph.occupyConnectionLane(fromId, toId, actor, laneIndex);
        actor.navigation.beginConnection(fromId, toId);

        context.nodeMode = NavigationNodeMode.TRANSIT;
        this.owner.centerActorForDeparture(context);

        if (waypoint && portal) {

            waypoint.position.copy(portal);
            const nextWaypoint = actor.navigation.getNextWaypoint();
            const departureControl = portal.clone().lerp(laneEnd, 0.25);
            const laneCurve = this.createLaneCurveWaypoints(
                portal,
                departureControl,
                laneEnd
            );

            if (nextWaypoint?.id === toId) {

                nextWaypoint.position.copy(laneEnd);
                actor.navigation.insertManyAfterCurrent(laneCurve);
                context.traversingLaneCurve = laneCurve.length > 0;
                this.graph.setActiveLaneCurve(actor, [
                    portal,
                    ...laneCurve.map(candidate => candidate.position),
                    laneEnd
                ]);

            }

        }

        this.clearWaitReason(actor);
        this.owner.refresh();

        return true;

    }

    completeInteractionDeparture(actor, originKey) {

        if (originKey) this.departures.complete(originKey, actor);

    }

    // -----------------------------
    // Lane presentation
    // -----------------------------

    moveVisualToCenter(actor) {

        if (!actor.visual || Math.abs(actor.visual.position.x) <= 0.001) return;

        AnimationPresets.to(actor, {
            object: actor.visual.position,
            property: "x",
            to: 0,
            duration: 0.35,
            easing: Tween.easeInOutQuad
        });

    }

    createTransitTangent(previousId, nodeId, nextId) {

        const previous = this.graph.requireNode(previousId).position;
        const node = this.graph.requireNode(nodeId).position;
        const next = this.graph.requireNode(nextId).position;
        return this.createPositionTangent(previous, node, next);

    }

    createPositionTangent(previous, node, next) {

        // Curve tangents are fully spatial. Locomotion projects only the body
        // rotation onto XZ, so following a slope never tilts the character.
        const incoming = node.clone().sub(previous).normalize();
        const outgoing = next.clone().sub(node).normalize();
        const tangent = incoming.add(outgoing);

        // A U-turn has no stable bisector. Following the outgoing direction is
        // predictable and avoids an almost-zero vector producing a sharp flip.
        return tangent.lengthSq() > 0.0001
            ? tangent.normalize()
            : outgoing;

    }

    createLaneCurveWaypoints(
        start,
        laneStart,
        end,
        segments = 10,
        {
            departureDirection = null,
            arrivalDirection = null
        } = {}
    ) {

        const distance = start.distanceTo(end);

        if (distance <= 0.1) return [];

        const defaultDirection = end.clone().sub(laneStart).normalize();
        const startTangent = departureDirection?.clone().normalize() ??
            laneStart.clone().sub(start).normalize();
        const endTangent = arrivalDirection?.clone().normalize() ??
            defaultDirection;
        const handleLength = Math.min(1.5, distance / 3);
        const firstControl = start.clone().addScaledVector(
            startTangent.lengthSq() > 0.0001
                ? startTangent
                : defaultDirection,
            handleLength
        );
        const secondControl = end.clone().addScaledVector(
            endTangent,
            -handleLength
        );
        const waypoints = [];

        for (let index = 1; index < segments; index++) {

            const t = index / segments;
            const inverse = 1 - t;
            const position = start.clone().multiplyScalar(inverse ** 3)
                .add(firstControl.clone().multiplyScalar(
                    3 * inverse ** 2 * t
                ))
                .add(secondControl.clone().multiplyScalar(
                    3 * inverse * t ** 2
                ))
                .add(end.clone().multiplyScalar(t ** 3));

            waypoints.push({
                id: null,
                position,
                laneCurve: true
            });

        }

        return this.owner.projectWaypointsToGround(waypoints);

    }

    createInteractionCurveWaypoints(
        start,
        portal,
        transitionTarget = null,
        segments = 8
    ) {

        const distance = start.distanceTo(portal);

        if (distance <= 0.1) return [];

        const towardPortal = portal.clone().sub(start).normalize();
        const towardInteraction = transitionTarget
            ? transitionTarget.clone().sub(portal).normalize()
            : towardPortal;
        const handleLength = Math.min(1.2, distance * 0.4);
        const firstControl = start.clone().addScaledVector(
            towardPortal,
            handleLength
        );
        const secondControl = portal.clone().addScaledVector(
            towardInteraction,
            -handleLength * 0.65
        );
        const waypoints = [];

        for (let index = 1; index < segments; index++) {

            const t = index / segments;
            const inverse = 1 - t;
            const position = start.clone().multiplyScalar(inverse ** 3)
                .add(firstControl.clone().multiplyScalar(
                    3 * inverse ** 2 * t
                ))
                .add(secondControl.clone().multiplyScalar(
                    3 * inverse * t ** 2
                ))
                .add(portal.clone().multiplyScalar(t ** 3));

            waypoints.push({
                id: null,
                position,
                interactionCurve: true
            });

        }

        return this.owner.projectWaypointsToGround(waypoints);

    }

    unregister(actor) {

        this.cancel(actor);

    }

    cancel(actor) {

        this.departures.cancel(actor);
        this.arrivals.cancel(actor);
        this.graph.releaseReservations(actor);
        this.owner.releaseDwellReservation(actor);
        this.graph.clearActiveLaneCurve(actor);
        const context = this.owner.contexts.get(actor);

        if (context) {

            context.traversingLaneCurve = false;
            context.traversingInteractionCurve = false;
            context.traversingDwellCurve = false;
            context.transitTangent = null;
            context.arrivalFromNodeId = null;

        }

        this.clearWaitReason(actor);

    }

    setWaitReason(actor, resourceId, reason) {

        const key = `${reason}@${resourceId}`;

        if (this.waitReasons.get(actor)?.key === key) return;

        this.waitReasons.set(actor, { key, resourceId, reason });
        console.log(
            `[NavigationQueue] … ${actor.name} waits at ` +
            `"${resourceId}": ${WaitReasonLabel[reason] ?? reason}.`
        );

    }

    clearWaitReason(actor) {

        if (!this.waitReasons.has(actor)) return;

        console.log(`[NavigationQueue] → ${actor.name} may proceed.`);
        this.waitReasons.delete(actor);

    }

    isFirstAtNode(nodeId, actor) {

        if (!this.arrivals.hasAt(nodeId, actor)) return true;
        return this.arrivals.isFirst(nodeId, actor);

    }

    isQueuedAtNode(nodeId, actor) {

        return this.departures.hasAt(nodeId, actor) ||
            this.arrivals.hasAt(nodeId, actor);

    }

    completeNodeArrival(nodeId, actor) {

        this.arrivals.complete(nodeId, actor);

    }

    getActorPriority(actor, fallback = 0) {

        return actor.name === "Player" ? 10 : fallback;

    }

    debugQueues() {

        console.log("-- Departures --");
        this.departures.debug();
        console.log("-- Arrivals --");
        return this.arrivals.debug();

    }

    isQueued(actor) {

        return this.departures.has(actor) || this.arrivals.has(actor);

    }

    isWaitingForQueue(actor) {

        const depRequest = this.departures.getActorRequest(actor);
        if (depRequest && !this.departures.isFirst(depRequest.originId, actor)) {
            return true;
        }

        const arrRequest = this.arrivals.getActorRequest(actor);
        if (arrRequest && !this.arrivals.isFirst(arrRequest.originId, actor)) {
            return true;
        }

        return false;

    }

    getDebugState(actor) {

        const entry = this.departures.getActorRequest(actor) ??
            this.arrivals.getActorRequest(actor);
        const wr = this.waitReasons.get(actor);

        return {
            queue: entry,
            waitReason: wr
                ? `${wr.reason} @ ${wr.resourceId}`
                : null
        };

    }

}
