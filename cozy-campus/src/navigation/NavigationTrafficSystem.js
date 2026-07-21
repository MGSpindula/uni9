import { AnimationPresets } from "../core/AnimationPresets";
import { Tween } from "../core/Tween";
import { NavigationDepartureQueue } from "./NavigationDepartureQueue";
import { WaitReason, WaitReasonLabel } from "./WaitReason";

// Authority: temporal permission to enter nodes, connections and lanes.
// Traffic may queue, reserve or deny a frame; it never chooses a destination
// and never applies displacement to an actor.
export class NavigationTrafficSystem {

    constructor(owner, { waitTimeout = 4 } = {}) {

        this.owner = owner;
        this.graph = owner.graph;
        this.state = owner.trafficState;
        this.geometry = owner.routeGeometry;
        this.departures = new NavigationDepartureQueue();
        this.arrivals = new NavigationDepartureQueue();
        this.waitReasons = new Map();
        this.waitTimeout = waitTimeout;

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
            {
                rank: 0,
                priority: this.getActorPriority(actor),
                kind: "lookahead"
            }
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

        this.departures.enqueue(originId, actor, {
            rank: 3,
            priority: this.getActorPriority(actor),
            kind: "departure"
        });

        if (!this.departures.isFirst(originId, actor)) {

            this.setWaitReason(actor, originId, WaitReason.QUEUE_HEAD);

        } else {

            this.setWaitReason(actor, originId, WaitReason.QUEUE_FIRST);

        }

        return true;

    }

    preflightInteractionExit(actor, entry) {

        if (!entry) return true;

        const {
            fromId,
            toId,
            originKey,
            anchorId = null,
            preferredLaneIndex: requestedLaneIndex = null
        } = entry;

        if (!this.graph.hasNode(fromId) ||
            !this.graph.hasNode(toId) ||
            !this.graph.areConnected(fromId, toId)) return false;

        const connection = this.graph.requireConnection(fromId, toId);

        if (this.graph.isNodeBlocked(toId) || connection.blocked) {

            this.setWaitReason(actor, originKey, WaitReason.HARD_BLOCKED);
            return false;

        }

        this.departures.enqueue(originKey, actor, {
            rank: 3,
            priority: this.getActorPriority(actor),
            kind: "interaction-exit"
        });
        this.arrivals.enqueue(toId, actor, {
            rank: 2,
            priority: this.getActorPriority(actor),
            kind: "arrival"
        });

        if (!this.departures.isFirst(originKey, actor)) {

            this.setWaitReason(actor, originKey, WaitReason.QUEUE_HEAD);
            return false;

        }

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
        const directionalLaneIndex = Number.isInteger(requestedLaneIndex)
            ? requestedLaneIndex
            : approachLaneIndex;
        const laneIndex = directionalLaneIndex === null
            ? this.state.reserveConnectionLane(fromId, toId, actor)
            : this.state.reserveSpecificConnectionLane(
                fromId,
                toId,
                directionalLaneIndex,
                actor
            );

        if (laneIndex === null) {

            this.setWaitReason(actor, originKey, WaitReason.LANE_FULL, {
                connection: { fromId, toId }
            });
            return false;

        }

        // Claim the endpoint early when possible. Failure is temporary and
        // does not prevent standing up: the lane itself is already guaranteed.
        this.state.reserveNodeForTransit(toId, actor);
        this.clearWaitReason(actor);
        this.owner.refresh();
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
            rank: 3,
            priority: this.getActorPriority(actor),
            kind: "departure"
        });
        this.arrivals.enqueue(toId, actor, {
            rank: 2,
            priority: this.getActorPriority(actor),
            kind: "arrival"
        });

        if (!this.departures.isFirst(fromId, actor)) {

            this.setWaitReason(actor, fromId, WaitReason.QUEUE_HEAD);
            return false;

        }


        // Ordinary routes do not own a lane during planning. A preferred lane
        // is an authored constraint (for example a closed loop), not a claim.
        let laneIndex = Number.isInteger(waypoint?.preferredLaneIndex)
            ? this.state.reserveSpecificConnectionLane(
                fromId,
                toId,
                waypoint.preferredLaneIndex,
                actor
            )
            : this.state.reserveConnectionLane(fromId, toId, actor);

        if (laneIndex === null &&
            !Number.isInteger(waypoint?.preferredLaneIndex) &&
            this.state.getNodeState(fromId).occupants.has(actor)) {

            const evacuation = this.state.reserveNodeEvacuationLane(
                fromId,
                toId,
                actor
            );

            if (evacuation) {

                laneIndex = evacuation.laneIndex;
                actor.onNodeEvacuationStarted?.({
                    fromId,
                    toId,
                    laneIndex,
                    usedOppositeLane: evacuation.usedOppositeLane
                });

                for (const displacedActor of evacuation.displaced) {

                    displacedActor.onTrafficReservationYielded?.({
                        by: actor,
                        fromId,
                        toId,
                        laneIndex
                    });

                }

            }

        }

        if (laneIndex === null) {

            this.setWaitReason(actor, fromId, WaitReason.LANE_FULL, {
                connection: { fromId, toId }
            });
            return false;

        }


        const endpointReserved = this.state.reserveNodeForTransit(toId, actor);
        if (!endpointReserved) {
            this.setWaitReason(actor, toId, WaitReason.ENDPOINT_WAIT);
        }

        const laneStart = this.geometry.getConnectionLaneNodePosition(
            fromId,
            fromId,
            toId,
            laneIndex
        );
        const laneEnd = this.geometry.getConnectionLaneNodePosition(
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
        const storedTangent = context.transitTangent;
        const departureDirection =
            storedTangent?.nodeId === fromId &&
                storedTangent?.nextNodeId === toId
                ? storedTangent.direction
                : null;
        const built = waypoint
            ? this.owner.geometryBuilder.createAuthorizedConnectionGeometry({
                actor,
                fromId,
                toId,
                laneIndex,
                departureDirection
            })
            : null;
        const routeGeometry = built?.geometry ?? null;
        const laneCurve = routeGeometry?.curve ?? null;
        const debugPoints = routeGeometry?.getDebugPoints() ?? [];

        // The arriving and departing curves consume the same tangent at this
        // transit node. The handle arms lie on opposite sides of the join,
        // providing C1 continuity without moving through the node center.
        context.transitTangent = built?.arrivalDirection
            ? {
                nodeId: toId,
                nextNodeId,
                direction: built.arrivalDirection.clone()
            }
            : null;

        if (debugPoints.length > 0) {

            this.geometry.setActiveLaneCurve(actor, debugPoints);

        }

        this.owner.centerActorForDeparture(context);
        context.currentTraversal = connection.metadata.traversal ?? "flat";
        actor.traversalType = context.currentTraversal;
        this.state.occupyConnectionLane(fromId, toId, actor, laneIndex);

        if (waypoint) {

            waypoint.position.copy(laneEnd);
            waypoint.routeGeometry = routeGeometry;
            waypoint.routeSegment = routeGeometry?.segments.at(-1) ?? null;
            waypoint.routeCurve = laneCurve;
            waypoint.routeCurveFinal = true;
            waypoint.curveStartDistance = 0;
            waypoint.curveStopDistance = routeGeometry?.getLength() ?? 0;
            waypoint.authorizedLaneIndex = laneIndex;
            waypoint.routeGeometryPoints = debugPoints;

        }
        this.state.releaseNode(fromId, actor);
        // Every clearance request attached to this actor asked it to vacate
        // fromId. Entering the connection fulfills all of them, including a
        // node swap with the actor at the opposite endpoint.
        this.departures.complete(fromId, actor);
        this.clearWaitReason(actor);
        this.owner.refresh();

        context.traversingLaneCurve = Boolean(laneCurve);

        return true;

    }

    tryLeaveNodeForInteraction(
        actor,
        originId,
        waypoint = null,
        transitionTarget = null
    ) {

        const context = this.owner.requireContext(actor);
        const departureDirection =
            context.transitTangent?.nodeId === originId
                ? context.transitTangent.direction
                : null;

        if (this.graph.isNodeBlocked(originId)) {

            this.departures.cancel(actor);
            this.setWaitReason(actor, originId, WaitReason.HARD_BLOCKED);
            return false;

        }

        this.departures.enqueue(originId, actor, {
            rank: 3,
            priority: this.getActorPriority(actor),
            kind: "interaction-departure"
        });

        if (!this.departures.isFirst(originId, actor)) {

            this.setWaitReason(actor, originId, WaitReason.QUEUE_HEAD);
            return false;

        }

        if (actor.visual && Math.abs(actor.visual.position.x) > 0.01) {

            this.moveVisualToCenter(actor);
            this.setWaitReason(actor, originId, WaitReason.REALIGNING);
            return false;

        }

        const directNodeInteraction = Boolean(
            waypoint?.departureRequest?.originId &&
            !waypoint.laneStartPosition &&
            transitionTarget
        );

        if (directNodeInteraction) {

            // A direct connectTo: "node" has no authored portal. The actor is
            // already standing on the incoming lane endpoint, so node center
            // must remain a semantic traffic location rather than a physical
            // waypoint. Continue directly toward the approach/interaction.
            waypoint.position.copy(transitionTarget);

        }

        if (waypoint && !waypoint.routeGeometry) {

            const geometry = this.owner.geometryBuilder
                .createInteractionApproachGeometry({
                    start: actor.object3D.position,
                    laneStart: waypoint.laneStartPosition,
                    portal: waypoint.position,
                    transitionTarget: directNodeInteraction
                        ? null
                        : transitionTarget,
                    departureDirection
                });

            if (geometry) {

                const debugPoints = geometry.getDebugPoints();

                waypoint.routeGeometry = geometry;
                waypoint.routeSegment = geometry.segments.at(-1);
                waypoint.routeCurve = geometry.curve;
                waypoint.routeCurveFinal = true;
                waypoint.curveStartDistance = 0;
                waypoint.curveStopDistance = geometry.getLength();
                waypoint.routeGeometryPoints = debugPoints;
                this.geometry.setActiveLaneCurve(actor, debugPoints);
                context.traversingInteractionCurve = true;

            }

        }

        // Degenerate geometry keeps the former sampled fallback.
        if (waypoint && !context.traversingInteractionCurve) {

            if (waypoint.laneStartPosition) {

                const laneStart = waypoint.laneStartPosition.clone();
                const portal = waypoint.position.clone();
                const directionThroughJoin = portal.clone()
                    .sub(laneStart)
                    .normalize();
                const toLaneStart = this.createInteractionCurveWaypoints(
                    actor.object3D.position,
                    laneStart,
                    portal,
                    8,
                    departureDirection
                );
                const fromLaneStart = this.createInteractionCurveWaypoints(
                    laneStart,
                    portal,
                    transitionTarget,
                    8,
                    directionThroughJoin
                );

                // This is a geometric join, not a navigation stop. Both
                // Béziers use the same direction here, so the actor crosses
                // the lane start fluidly while still respecting the authored
                // approach-side lane instead of cutting straight to its portal.
                const approachCurve = [
                    ...toLaneStart,
                    {
                        id: null,
                        position: laneStart,
                        laneCurveJoin: true
                    },
                    ...fromLaneStart
                ];

                if (approachCurve.length > 0) {

                    this.geometry.setActiveLaneCurve(actor, [
                        actor.object3D.position,
                        ...approachCurve.map(candidate => candidate.position),
                        portal
                    ]);
                    actor.navigation.insertManyBeforeCurrent(approachCurve);
                    context.traversingInteractionCurve = true;
                    this.owner.refresh();
                    return false;

                }

            }

            const curveWaypoints = this.createInteractionCurveWaypoints(
                actor.object3D.position,
                waypoint.position,
                transitionTarget,
                8,
                departureDirection
            );

            if (curveWaypoints.length > 0) {

                this.geometry.setActiveLaneCurve(actor, [
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
        {
            fromId,
            toId,
            originKey,
            anchorId = null,
            preferredLaneIndex: entryLaneIndex = null
        },
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
            rank: 3,
            priority: this.getActorPriority(actor),
            kind: "interaction-departure"
        });
        this.arrivals.enqueue(toId, actor, {
            rank: 2,
            priority: this.getActorPriority(actor),
            kind: "arrival"
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
        // This value is only a directional preference until this exact call.
        // Geometry is created below from the lane that was actually reserved.
        const requestedLaneIndex = Number.isInteger(entryLaneIndex)
            ? entryLaneIndex
            : approachLaneIndex;
        const laneIndex = requestedLaneIndex === null
            ? this.state.reserveConnectionLane(fromId, toId, actor)
            : this.state.reserveSpecificConnectionLane(
                fromId,
                toId,
                requestedLaneIndex,
                actor
            );

        if (laneIndex === null) {

            this.setWaitReason(actor, originKey, WaitReason.LANE_FULL, {
                connection: { fromId, toId }
            });
            return false;

        }


        if (!this.state.reserveNodeForTransit(toId, actor)) {
            this.setWaitReason(actor, toId, WaitReason.ENDPOINT_WAIT);
        }

        const directNodePortal = !anchor &&
            waypoint?.graphEntryNodeId === fromId
            ? this.geometry.getConnectionLaneNodePosition(
                fromId,
                fromId,
                toId,
                laneIndex
            )
            : null;
        const portal = anchor?.lanePositions[laneIndex]?.clone() ??
            directNodePortal ??
            waypoint?.position.clone();
        const laneEnd = this.geometry.getConnectionLaneNodePosition(
            toId,
            fromId,
            toId,
            laneIndex
        );
        const followingWaypoint = actor.navigation.getFollowingWaypoint();
        const followingNodeId = followingWaypoint?.id &&
            this.graph.hasNode(followingWaypoint.id) &&
            this.graph.areConnected(toId, followingWaypoint.id)
            ? followingWaypoint.id
            : null;
        const laneDirection = laneEnd.clone().sub(portal).normalize();

        const exitGeometry = waypoint && portal
            ? this.owner.geometryBuilder.createInteractionGeometry({
                start: actor.object3D.position,
                portal,
                transitionTarget: laneEnd,
                departureDirection: waypoint.departureDirection,
                type: "interaction-exit"
            })
            : null;
        const laneBuild = waypoint && portal
            ? this.owner.geometryBuilder.createAuthorizedConnectionGeometry({
                actor,
                fromId,
                toId,
                laneIndex,
                startPosition: portal,
                laneStartOverride: portal,
                departureDirection: laneDirection
            })
            : null;

        this.state.occupyConnectionLane(fromId, toId, actor, laneIndex);
        actor.navigation.beginConnection(fromId, toId);

        this.owner.centerActorForDeparture(context);

        if (waypoint && portal) {

            waypoint.position.copy(portal);
            const nextWaypoint = actor.navigation.getNextWaypoint();

            if (exitGeometry) {

                waypoint.routeGeometry = exitGeometry;
                waypoint.routeSegment = exitGeometry.segments.at(-1);
                waypoint.routeCurve = exitGeometry.curve;
                waypoint.routeCurveFinal = true;
                waypoint.curveStartDistance = 0;
                waypoint.curveStopDistance = exitGeometry.getLength();

            }

            if (nextWaypoint?.id === toId) {

                nextWaypoint.position.copy(laneEnd);
                nextWaypoint.routeGeometry = laneBuild?.geometry ?? null;
                nextWaypoint.routeSegment =
                    laneBuild?.geometry.segments.at(-1) ?? null;
                nextWaypoint.routeCurve = laneBuild?.geometry.curve ?? null;
                nextWaypoint.routeCurveFinal = true;
                nextWaypoint.curveStartDistance = 0;
                nextWaypoint.curveStopDistance =
                    laneBuild?.geometry.getLength() ?? 0;
                nextWaypoint.authorizedLaneIndex = laneIndex;
                context.traversingLaneCurve = Boolean(
                    nextWaypoint.routeCurve
                );
                context.transitTangent = laneBuild?.arrivalDirection
                    ? {
                        nodeId: toId,
                        nextNodeId: followingNodeId,
                        direction: laneBuild.arrivalDirection.clone()
                    }
                    : null;

            }

            const debugPoints = [
                ...(exitGeometry?.getDebugPoints() ?? []),
                ...(laneBuild?.geometry.getDebugPoints() ?? []).slice(1)
            ];

            if (debugPoints.length > 0) {

                waypoint.routeGeometryPoints = debugPoints;
                this.geometry.setActiveLaneCurve(actor, debugPoints);

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




    createInteractionCurveWaypoints(
        start,
        portal,
        transitionTarget = null,
        segments = 8,
        departureDirection = null
    ) {

        const distance = start.distanceTo(portal);

        if (distance <= 0.1) return [];

        const towardPortal = portal.clone().sub(start).normalize();
        const towardInteraction = transitionTarget
            ? transitionTarget.clone().sub(portal).normalize()
            : towardPortal;
        const startDirection = departureDirection?.clone().normalize() ??
            towardPortal;
        const handleLength = Math.min(1.2, distance * 0.4);
        const firstControl = start.clone().addScaledVector(
            startDirection,
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
        this.state.releaseReservations(actor);
        this.geometry.clearActiveLaneCurve(actor);
        const context = this.owner.agents.get(actor);

        if (context) {

            context.traversingLaneCurve = false;
            context.traversingInteractionCurve = false;
            context.transitTangent = null;
            context.arrivalFromNodeId = null;

        }

        this.clearWaitReason(actor);

    }

    setWaitReason(actor, resourceId, reason, {
        connection = null
    } = {}) {

        const key = `${reason}@${resourceId}`;

        if (this.waitReasons.get(actor)?.key === key) return;

        const previous = this.waitReasons.get(actor);

        if (previous) actor.onTrafficWaitEnded?.(previous);

        const wait = {
            key,
            resourceId,
            reason,
            connection,
            elapsed: 0,
            timeoutCount: 0,
            blocker: this.getWaitBlocker(
                actor,
                resourceId,
                reason,
                connection
            )
        };

        this.waitReasons.set(actor, wait);
        actor.onTrafficWaitStarted?.(wait);
        console.log(
            `[NavigationQueue] … ${actor.name} waits at ` +
            `"${resourceId}": ${WaitReasonLabel[reason] ?? reason}.`
        );

    }

    clearWaitReason(actor) {

        const wait = this.waitReasons.get(actor);

        if (!wait) return;

        console.log(`[NavigationQueue] → ${actor.name} may proceed.`);
        this.waitReasons.delete(actor);
        actor.onTrafficWaitEnded?.(wait);

    }

    update(delta) {

        for (const [actor, wait] of this.waitReasons) {

            wait.elapsed += delta;

            if (wait.elapsed < this.waitTimeout) continue;

            wait.elapsed = 0;
            wait.timeoutCount++;

            if (wait.reason === WaitReason.LANE_FULL && wait.connection) {

                this.releaseStaleLaneClaims(wait.connection);

            }
            wait.blocker = this.getWaitBlocker(
                actor,
                wait.resourceId,
                wait.reason,
                wait.connection
            );

            const traversal = actor.navigation.getTraversalState();
            const ownsResource =
                traversal.currentNodeId === wait.resourceId;

            // Emergency invariant: an actor already occupying a node must be
            // able to leave before look-ahead entries from approaching actors.
            if (wait.reason === WaitReason.QUEUE_HEAD && ownsResource) {

                const promoted = this.departures.promote(
                    wait.resourceId,
                    actor
                );

                if (promoted) {

                    console.warn(
                        `[NavigationQueue] ${actor.name} promoted to release ` +
                        `occupied node "${wait.resourceId}".`
                    );

                }

            }

            if (this.owner.resolveTrafficWaitTimeout(actor, wait)) {

                continue;

            }

            // Animation/gameplay hook. A future implementation may glance at
            // the blocker, ask for passage or perform one authored step aside.
            // Timeout never deletes intent or invents an off-graph waypoint.
            actor.onTrafficWaitTimeout?.({ ...wait });

        }

    }

    getWaitBlocker(actor, resourceId, reason, connectionHint = null) {

        if (reason === WaitReason.QUEUE_HEAD) {

            const first = this.departures.getFirst(resourceId) ??
                this.arrivals.getFirst(resourceId);

            return first !== actor ? first : null;

        }

        if (reason === WaitReason.ENDPOINT_WAIT &&
            this.graph.hasNode(resourceId)) {

            const node = this.state.getNodeState(resourceId);
            return [
                ...node.occupants,
                ...node.reservations,
                ...node.transitReservations
            ].find(candidate => candidate !== actor) ?? null;

        }

        if (reason === WaitReason.LANE_FULL) {

            const traversal = actor.navigation.getTraversalState();
            const waypoint = actor.navigation.getCurrentWaypoint();
            const entry = waypoint?.connectionEntry;
            const fromId = connectionHint?.fromId ??
                entry?.fromId ?? traversal.currentNodeId;
            const toId = connectionHint?.toId ??
                entry?.toId ?? waypoint?.id;

            if (fromId && toId &&
                this.graph.hasNode(fromId) &&
                this.graph.hasNode(toId) &&
                this.graph.areConnected(fromId, toId)) {

                const connection = this.state.getConnectionState(fromId, toId);

                for (const lane of connection.lanes) {

                    const blocker = [
                        ...lane.occupants,
                        ...lane.reservations
                    ].find(candidate => candidate !== actor);

                    if (blocker) return blocker;

                }

            }

        }

        return null;

    }

    releaseStaleLaneClaims({ fromId, toId }) {

        if (!this.graph.hasNode(fromId) ||
            !this.graph.hasNode(toId) ||
            !this.graph.areConnected(fromId, toId)) return 0;

        const connection = this.state.getConnectionState(fromId, toId);
        let released = 0;

        for (const lane of connection.lanes) {

            for (const actor of [...lane.reservations]) {

                if (actor.navigation.hasPath()) continue;

                this.state.releaseConnection(fromId, toId, actor);
                released++;

            }

            for (const actor of [...lane.occupants]) {

                const traversal = actor.navigation.getTraversalState();
                const active = traversal.currentConnection &&
                    ((traversal.currentConnection.fromId === fromId &&
                        traversal.currentConnection.toId === toId) ||
                    (traversal.currentConnection.fromId === toId &&
                        traversal.currentConnection.toId === fromId));

                if (active) continue;

                this.state.releaseConnection(fromId, toId, actor);
                released++;

            }

        }

        if (released > 0) {

            console.warn(
                `[NavigationQueue] Released ${released} stale lane ` +
                `claim(s) on "${fromId} ↔ ${toId}".`
            );

        }

        return released;

    }

    claimPhysicalArrival(nodeId, actor) {

        // Arrival rank 2 is only look-ahead: it helps plan who is coming.
        // Once an actor is physically at the lane endpoint it must not wait
        // behind a remote reservation. Scene updates actors sequentially, so
        // the first physical claimant occupies the node and the real node
        // availability check safely holds any simultaneous second arrival.
        this.arrivals.enqueue(nodeId, actor, {
            rank: 5,
            priority: this.getActorPriority(actor),
            kind: "physical-arrival"
        });

        const displaced = this.state.yieldTransitReservationsToArrival(
            nodeId,
            actor
        );

        for (const displacedActor of displaced) {

            displacedActor.onTrafficReservationYielded?.({
                by: actor,
                nodeId,
                type: "physical-arrival"
            });

        }

    }

    isQueuedAtNode(nodeId, actor) {

        return this.departures.hasAt(nodeId, actor) ||
            this.arrivals.hasAt(nodeId, actor);

    }

    completeNodeArrival(nodeId, actor) {

        this.arrivals.complete(nodeId, actor);

    }

    getActorPriority(
        actor,
        fallback = 0
    ) {

        return Math.max(
            actor.navigationPriority ??
            0,

            fallback
        );

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

    hasHigherPriority(
        first,
        second
    ) {

        return this.getActorPriority(
            first
        ) >
            this.getActorPriority(
                second
            );

    }

    getDebugState(actor) {

        const departure = this.departures.getActorRequest(actor);
        const arrival = this.arrivals.getActorRequest(actor);
        const wr = this.waitReasons.get(actor);

        return {
            departure,
            arrival,
            waitReason: wr
                ? `${wr.reason} @ ${wr.resourceId} ` +
                    `(${wr.elapsed.toFixed(1)}s, timeout ${wr.timeoutCount})` +
                    (wr.blocker ? ` ← ${wr.blocker.name}` : "")
                : null
        };

    }

    getWaitReason(actor) {

        return this.waitReasons.get(actor)?.reason ?? null;

    }

}
