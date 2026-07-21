import { AnimationPresets } from "../core/AnimationPresets";
import { Tween } from "../core/Tween";
import { NavigationDepartureQueue } from "./NavigationDepartureQueue";
import { WaitReason, WaitReasonLabel } from "./WaitReason";
import * as THREE from "three";

export class NavigationTrafficSystem {

    constructor(owner, { waitTimeout = 4 } = {}) {

        this.owner = owner;
        this.graph = owner.graph;
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
            laneIndex: requestedLaneIndex = null
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
            ? this.graph.reserveConnectionLane(fromId, toId, actor)
            : this.graph.reserveSpecificConnectionLane(
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
        this.graph.reserveNodeForTransit(toId, actor);
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


        let laneIndex = waypoint?.routeSpline &&
            Number.isInteger(waypoint.plannedLaneIndex)
            ? this.graph.reserveSpecificConnectionLane(
                fromId,
                toId,
                waypoint.plannedLaneIndex,
                actor
            )
            : this.graph.reserveConnectionLane(fromId, toId, actor);

        if (laneIndex === null &&
            !waypoint?.routeSpline &&
            this.graph.requireNode(fromId).occupants.has(actor)) {

            const evacuation = this.graph.reserveNodeEvacuationLane(
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


        const endpointReserved = this.graph.reserveNodeForTransit(toId, actor);
        if (!endpointReserved) {
            this.setWaitReason(actor, toId, WaitReason.ENDPOINT_WAIT);
        }

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
        // The curve arriving at `toId` must already know where traversal
        // continues afterwards. That next target may be a graph node, but it
        // may also be the first portal of an interaction route. Keeping this
        // tangent lets the following curve leave the lane endpoint with the
        // same direction instead of creating a visible corner.
        const nextTarget = nextNodeId
            ? this.graph.requireNode(nextNodeId).position
            : nextWaypoint?.laneStartPosition ?? nextWaypoint?.position ?? null;
        const arrivalDirection = nextTarget
            ? this.createPositionTangent(
                this.graph.requireNode(fromId).position,
                this.graph.requireNode(toId).position,
                nextTarget
            )
            : null;
        const storedTangent = context.transitTangent;
        const departureDirection =
            storedTangent?.nodeId === fromId &&
                storedTangent?.nextNodeId === toId
                ? storedTangent.direction
                : null;
        const laneCurve = waypoint?.routeSpline
            ? waypoint.routeCurve
            : waypoint
                ? this.createLaneCurve(
                actor.object3D.position,
                laneStart,
                laneEnd,
                {
                    departureDirection,
                    arrivalDirection
                }
                )
                : null;
        const curveWaypoints = laneCurve
            ? this.createCurveSamples(laneCurve, 10, "laneCurve")
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
                ...(waypoint?.routeSplinePoints ?? laneCurve.getPoints(48))
            ]);

        }

        this.owner.centerActorForDeparture(context);
        context.currentTraversal = connection.metadata.traversal ?? "flat";
        actor.traversalType = context.currentTraversal;
        this.graph.occupyConnectionLane(fromId, toId, actor, laneIndex);

        if (waypoint) {

            waypoint.position.copy(laneEnd);

        }
        this.graph.releaseNode(fromId, actor);
        // Every clearance request attached to this actor asked it to vacate
        // fromId. Entering the connection fulfills all of them, including a
        // node swap with the actor at the opposite endpoint.
        this.departures.complete(fromId, actor);
        this.clearWaitReason(actor);
        this.owner.refresh();

        if (waypoint?.routeSpline) {

            actor.navigation.beginConnection(fromId, toId);
            context.traversingLaneCurve = true;
            return true;

        }

        if (curveWaypoints.length > 0) {

            // The endpoint is an explicit route anchor. Locomotion advances
            // along the stored curve by arc length and cannot cut from one
            // lane into the next without physically reaching this point.
            actor.navigation.insertManyBeforeCurrent([{
                id: null,
                position: laneEnd.clone(),
                routeCurve: laneCurve,
                laneCurve: true,
                laneEndpoint: true
            }]);
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

        if (waypoint?.routeSpline) {

            this.graph.setActiveLaneCurve(
                actor,
                waypoint.routeSplinePoints
            );
            context.traversingInteractionCurve = true;
            this.owner.centerActorForDeparture(context);
            this.clearWaitReason(actor);
            return true;

        }

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

                    this.graph.setActiveLaneCurve(actor, [
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
            laneIndex: entryLaneIndex = null
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
        const requestedLaneIndex = waypoint?.routeSpline &&
            Number.isInteger(waypoint.plannedLaneIndex)
            ? waypoint.plannedLaneIndex
            : Number.isInteger(entryLaneIndex)
                ? entryLaneIndex
                : approachLaneIndex;
        const laneIndex = requestedLaneIndex === null
            ? this.graph.reserveConnectionLane(fromId, toId, actor)
            : this.graph.reserveSpecificConnectionLane(
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
        const followingWaypoint = actor.navigation.getFollowingWaypoint();
        const followingNodeId = followingWaypoint?.id &&
            this.graph.hasNode(followingWaypoint.id) &&
            this.graph.areConnected(toId, followingWaypoint.id)
            ? followingWaypoint.id
            : null;
        const followingTarget = followingNodeId
            ? this.graph.requireNode(followingNodeId).position
            : followingWaypoint?.laneStartPosition ??
                followingWaypoint?.position ?? null;
        const arrivalDirection = followingTarget
            ? this.createPositionTangent(
                this.graph.requireNode(fromId).position,
                this.graph.requireNode(toId).position,
                followingTarget
            )
            : null;

        if (waypoint && portal && !waypoint.routeSpline &&
            !context.traversingInteractionCurve) {

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

        this.owner.centerActorForDeparture(context);

        if (waypoint?.routeSpline) {

            this.graph.setActiveLaneCurve(
                actor,
                waypoint.routeSplinePoints
            );
            context.traversingInteractionCurve = true;

        } else if (waypoint && portal) {

            waypoint.position.copy(portal);
            const nextWaypoint = actor.navigation.getNextWaypoint();
            const departureControl = portal.clone().lerp(laneEnd, 0.25);
            const laneCurve = this.createLaneCurveWaypoints(
                portal,
                departureControl,
                laneEnd,
                10,
                { arrivalDirection }
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

                // The connection begun at an interaction still arrives at a
                // regular graph node. Preserve its outgoing tangent so the
                // next connection starts as a continuation, not a new curve.
                context.transitTangent = arrivalDirection
                    ? {
                        nodeId: toId,
                        nextNodeId: followingNodeId,
                        direction: arrivalDirection.clone()
                    }
                    : null;

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

        const curve = this.createLaneCurve(
            start,
            laneStart,
            end,
            { departureDirection, arrivalDirection }
        );

        return curve
            ? this.createCurveSamples(curve, segments, "laneCurve")
            : [];

    }

    createLaneCurve(
        start,
        laneStart,
        end,
        {
            departureDirection = null,
            arrivalDirection = null
        } = {}
    ) {

        const beforeAnchorDistance = start.distanceTo(laneStart);
        const laneDistance = laneStart.distanceTo(end);

        if (beforeAnchorDistance + laneDistance <= 0.1) return null;

        const laneDirection = end.clone().sub(laneStart).normalize();
        const fallbackDirection = end.clone().sub(start).normalize();
        const startDirection = departureDirection?.clone().normalize() ??
            laneStart.clone().sub(start).normalize();
        const endDirection = arrivalDirection?.clone().normalize() ??
            (laneDirection.lengthSq() > 0.0001
                ? laneDirection
                : fallbackDirection);
        const joinDirection = laneDirection.lengthSq() > 0.0001
            ? laneDirection
            : fallbackDirection;
        const curve = new THREE.CurvePath();

        // Both cubic segments meet at laneStart. Equal handle lengths on
        // opposite sides make their first derivatives equal (C1 continuity),
        // so laneStart is mandatory without becoming a visible corner/stop.
        const joinHandle = beforeAnchorDistance > 0.05
            ? Math.min(1.25, beforeAnchorDistance / 3, laneDistance / 3)
            : Math.min(1.25, laneDistance / 3);

        if (beforeAnchorDistance > 0.05) {

            const startHandle = Math.min(1.5, beforeAnchorDistance / 3);

            curve.add(new THREE.CubicBezierCurve3(
                start.clone(),
                start.clone().addScaledVector(
                    startDirection.lengthSq() > 0.0001
                        ? startDirection
                        : fallbackDirection,
                    startHandle
                ),
                laneStart.clone().addScaledVector(
                    joinDirection,
                    -joinHandle
                ),
                laneStart.clone()
            ));

        }

        if (laneDistance > 0.05) {

            const endHandle = Math.min(1.5, laneDistance / 3);

            curve.add(new THREE.CubicBezierCurve3(
                laneStart.clone(),
                laneStart.clone().addScaledVector(
                    joinDirection,
                    joinHandle
                ),
                end.clone().addScaledVector(endDirection, -endHandle),
                end.clone()
            ));

        }

        return curve.curves.length > 0 ? curve : null;

    }

    createCurveSamples(curve, segments, flag) {

        const samples = curve.getPoints(segments).slice(1, -1).map(position => ({
            id: null,
            position,
            [flag]: true
        }));

        return this.owner.projectWaypointsToGround(samples);

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
        this.graph.releaseReservations(actor);
        this.graph.clearActiveLaneCurve(actor);
        const context = this.owner.contexts.get(actor);

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

            const node = this.graph.requireNode(resourceId);
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

                const connection = this.graph.requireConnection(fromId, toId);

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

        const connection = this.graph.requireConnection(fromId, toId);
        let released = 0;

        for (const lane of connection.lanes) {

            for (const actor of [...lane.reservations]) {

                if (actor.navigation.hasPath()) continue;

                this.graph.releaseConnection(fromId, toId, actor);
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

                this.graph.releaseConnection(fromId, toId, actor);
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

        const displaced = this.graph.yieldTransitReservationsToArrival(
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

}
