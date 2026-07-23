import { NavigationDepartureQueue } from "./NavigationDepartureQueue";
import { WaitReason, WaitReasonLabel } from "./WaitReason";

// Authority: temporal permission to enter nodes, connections and lanes.
// Traffic may queue, reserve or deny a frame; it never chooses a destination
// and never applies displacement to an actor.
export class NavigationTrafficSystem {

    constructor(owner, { waitTimeout = 2.5 } = {}) {

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

        // Junctions are never reserved remotely. Lane ownership is enough
        // while an actor is travelling; the arrival handshake is created only
        // when its body physically reaches the endpoint. Keeping this method
        // as a no-op preserves the phased API without recreating lookahead
        // rows that used to seize busy junctions several seconds in advance.
        void actor;

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

    preflightDirectNodeEntry(
        actor,
        {
            nodeId,
            originKey
        }
    ) {

        if (
            !nodeId ||
            !this.graph.hasNode(
                nodeId
            )
        ) {

            return false;

        }

        if (
            this.graph.isNodeBlocked(
                nodeId
            )
        ) {

            this.setWaitReason(
                actor,
                originKey,
                WaitReason.HARD_BLOCKED
            );

            return false;

        }

        /*
         * A fila do InteractionPoint impede que
         * dois atores abandonem o mesmo ponto ou
         * staging area simultaneamente.
         */
        this.departures.enqueue(
            originKey,
            actor,
            {
                rank:
                    3,

                priority:
                    this.getActorPriority(
                        actor
                    ),

                kind:
                    "interaction-node-exit"
            }
        );

        if (
            !this.departures.isFirst(
                originKey,
                actor
            )
        ) {

            this.setWaitReason(
                actor,
                originKey,
                WaitReason.QUEUE_HEAD
            );

            return false;

        }

        /*
         * O ator está imediatamente ao lado do nó.
         * Diferentemente de uma lane longa, reservar
         * agora não é uma reserva remota.
         */
        this.claimPhysicalArrival(
            nodeId,
            actor
        );

        if (
            !this.hasArrivalGrant(
                nodeId,
                actor
            )
        ) {

            this.setWaitReason(
                actor,
                nodeId,
                WaitReason.ENDPOINT_WAIT
            );

            return false;

        }

        const compatibleCrossing =
            other =>
                !this.geometry
                    .plannedNodePathsConflict(
                        actor,
                        other,
                        nodeId
                    );

        if (
            !this.state
                .reserveNodeForTransit(
                    nodeId,
                    actor,
                    compatibleCrossing
                )
        ) {

            this.setWaitReason(
                actor,
                nodeId,
                WaitReason.NODE_OCCUPIED
            );

            return false;

        }

        this.clearWaitReason(
            actor
        );

        this.owner.refresh();

        return true;

    }

    preflightInteractionExit(
        actor,
        entry
    ) {

        if (!entry) {

            return true;

        }

        /*
         * InteractionPoint ligado diretamente a
         * um nó, sem conexão intermediária.
         */
        if (entry.nodeId) {

            return this
                .preflightDirectNodeEntry(
                    actor,
                    entry
                );

        }

        const {
            fromId,
            toId,
            originKey,
            anchorId = null,

            preferredLaneIndex:
            requestedLaneIndex =
            null
        } = entry;

        if (
            !this.graph.hasNode(fromId) ||
            !this.graph.hasNode(toId) ||
            !this.graph.areConnected(
                fromId,
                toId
            )
        ) {

            return false;

        }

        const connection =
            this.graph.requireConnection(
                fromId,
                toId
            );

        if (
            this.graph.isNodeBlocked(
                toId
            ) ||
            connection.blocked
        ) {

            this.setWaitReason(
                actor,
                originKey,
                WaitReason.HARD_BLOCKED
            );

            return false;

        }

        this.departures.enqueue(
            originKey,
            actor,
            {
                rank: 3,

                priority:
                    this.getActorPriority(
                        actor
                    ),

                kind:
                    "interaction-exit"
            }
        );

        if (
            !this.departures.isFirst(
                originKey,
                actor
            )
        ) {

            this.setWaitReason(
                actor,
                originKey,
                WaitReason.QUEUE_HEAD
            );

            return false;

        }

        const anchor =
            anchorId

                ? this.owner
                    .connector
                    .anchors
                    .get(anchorId)

                : null;

        const approachLaneIndex =
            anchor

                ? anchor.lanePositions
                    .reduce(
                        (
                            closestIndex,
                            position,
                            index
                        ) => {

                            const currentDistance =
                                position
                                    .distanceToSquared(
                                        actor
                                            .object3D
                                            .position
                                    );

                            const closestDistance =
                                anchor
                                    .lanePositions[
                                    closestIndex
                                ]
                                    .distanceToSquared(
                                        actor
                                            .object3D
                                            .position
                                    );

                            return currentDistance <
                                closestDistance

                                ? index
                                : closestIndex;

                        },

                        0
                    )

                : null;

        const directionalLaneIndex =
            Number.isInteger(
                requestedLaneIndex
            )

                ? requestedLaneIndex
                : approachLaneIndex;

        const laneIndex =
            this.reserveLane(
                actor,
                fromId,
                toId,
                directionalLaneIndex
            );

        if (laneIndex === null) {

            this.setWaitReason(
                actor,
                originKey,
                WaitReason.LANE_FULL,
                {
                    connection: {
                        fromId,
                        toId
                    }
                }
            );

            return false;

        }

        /*
         * A lane é reservada agora.
         *
         * O nó de destino somente será
         * negociado quando o ator chegar
         * fisicamente ao endpoint.
         */
        this.clearWaitReason(
            actor
        );

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

        if (!this.departures.isFirst(fromId, actor)) {

            this.setWaitReason(actor, fromId, WaitReason.QUEUE_HEAD);
            return false;

        }


        // Ordinary routes do not own a lane during planning. A preferred lane
        // is an authored constraint (for example a closed loop), not a claim.
        let laneIndex = this.reserveLane(
            actor,
            fromId,
            toId,
            waypoint?.preferredLaneIndex
        );

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
                this.owner.metrics.increment("nodeEvacuations");
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
        const storedTangent = context.traversal.transitTangent;
        const departureDirection =
            storedTangent?.nodeId === fromId
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
        context.traversal.transitTangent = built?.arrivalDirection
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
        context.traversal.kind = connection.metadata.traversal ?? "flat";
        actor.traversalType = context.traversal.kind;
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
            actor.navigation.touchGeometry();

        }
        this.state.releaseNode(fromId, actor);
        // Every clearance request attached to this actor asked it to vacate
        // fromId. Entering the connection fulfills all of them, including a
        // node swap with the actor at the opposite endpoint.
        this.departures.complete(fromId, actor);
        this.clearWaitReason(actor);
        this.owner.refresh();

        context.traversal.laneCurve = Boolean(laneCurve);

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
            context.traversal.transitTangent?.nodeId === originId
                ? context.traversal.transitTangent.direction
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

            actor.centerVisualForNavigation();
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
                    departureDirection,
                    arrivalDirection: directNodeInteraction
                        ? waypoint.interactionDirection
                        : null
                });

            if (geometry) {

                const followingWaypoint = actor.navigation
                    .getNextWaypoint();
                const pointGeometry = followingWaypoint?.interactionPoint &&
                    waypoint.position.distanceToSquared(
                        followingWaypoint.position
                    ) > 0.0025
                    ? this.owner.geometryBuilder.createInteractionGeometry({
                        start: waypoint.position,
                        portal: followingWaypoint.position,
                        departureDirection: followingWaypoint.position
                            .clone()
                            .sub(waypoint.position)
                            .normalize(),
                        arrivalDirection: followingWaypoint.interactionPoint
                            .getWorldDirection(),
                        type: "interaction-approach"
                    })
                    : null;
                const debugPoints = [
                    ...geometry.getDebugPoints(),
                    ...(pointGeometry?.getDebugPoints() ?? []).slice(1)
                ];

                waypoint.routeGeometry = geometry;
                waypoint.routeSegment = geometry.segments.at(-1);
                waypoint.routeCurve = geometry.curve;
                waypoint.routeCurveFinal = true;
                waypoint.curveStartDistance = 0;
                waypoint.curveStopDistance = geometry.getLength();
                waypoint.routeGeometryPoints = debugPoints;
                this.geometry.setActiveLaneCurve(actor, debugPoints);
                context.traversal.interactionCurve = true;

                if (pointGeometry) {

                    followingWaypoint.routeGeometry = pointGeometry;
                    followingWaypoint.routeSegment =
                        pointGeometry.segments.at(-1);
                    followingWaypoint.routeCurve = pointGeometry.curve;
                    followingWaypoint.routeCurveFinal = true;
                    followingWaypoint.curveStartDistance = 0;
                    followingWaypoint.curveStopDistance =
                        pointGeometry.getLength();
                    followingWaypoint.routeGeometryPoints =
                        pointGeometry.getDebugPoints();

                }

                actor.navigation.touchGeometry();

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

            actor.centerVisualForNavigation();
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
        const laneIndex = this.reserveLane(
            actor,
            fromId,
            toId,
            requestedLaneIndex
        );

        if (laneIndex === null) {

            this.setWaitReason(actor, originKey, WaitReason.LANE_FULL, {
                connection: { fromId, toId }
            });
            return false;

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
                arrivalDirection: waypoint.interactionDirection,
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
                context.traversal.laneCurve = Boolean(
                    nextWaypoint.routeCurve
                );
                context.traversal.transitTangent = laneBuild?.arrivalDirection
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

            actor.navigation.touchGeometry();

        }

        this.clearWaitReason(actor);
        this.owner.refresh();

        return true;

    }

    completeInteractionDeparture(actor, originKey) {

        if (originKey) this.departures.complete(originKey, actor);

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

            const physicallyTraversing = Boolean(
                actor.navigation.getTraversalState().currentConnection
            );

            context.traversal.laneCurve = false;
            context.traversal.interactionCurve = false;

            // Cancelling future claims does not erase the geometry the actor
            // is physically traversing. Its arrival tangent is still required
            // to join the next authorized lane without a corner or snap.
            if (!physicallyTraversing) {
                context.traversal.transitTangent = null;
                context.traversal.arrivalFromNodeId = null;
            }

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

            wait.blocker = this.getWaitBlocker(
                actor,
                wait.resourceId,
                wait.reason,
                wait.connection
            );

            // Waiting behind an actor that owns the junction and is visibly
            // progressing is ordinary right-of-way, not a deadlock. Restart
            // the timeout only when the owner itself stops making progress.
            if (this.isBlockerProgressing(wait.blocker)) {
                wait.elapsed = 0;
                continue;
            }

            wait.elapsed += delta;

            if (wait.elapsed < this.waitTimeout) continue;

            wait.elapsed = 0;
            wait.timeoutCount++;
            this.owner.metrics.increment("trafficTimeouts");

            if (this.graph.hasNode(wait.resourceId) &&
                this.owner.evacuateStaleNode(wait.resourceId)) {
                continue;
            }

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

            const arrivalHead = this.arrivals.getFirst(resourceId);

            if (arrivalHead && arrivalHead !== actor) return arrivalHead;

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

    isBlockerProgressing(blocker) {

        if (!blocker?.isActive?.()) return false;

        const motion = blocker.locomotion?.getMotionState?.();

        // Backing away resolves contact but does not advance a traffic claim.
        // Counting it as progress can keep stale reservations alive forever.
        return Boolean(
            motion?.moving && !motion?.retreating && !motion?.avoiding
        );

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

    reserveLane(actor, fromId, toId, preferredLaneIndex = null) {

        if (actor.navigationPassagePolicy !== "absolute") {
            return Number.isInteger(preferredLaneIndex)
                ? this.state.reserveSpecificConnectionLane(
                    fromId,
                    toId,
                    preferredLaneIndex,
                    actor
                )
                : this.state.reserveConnectionLane(fromId, toId, actor);
        }

        const grant = this.state.reservePriorityConnectionLane(
            fromId,
            toId,
            actor,
            preferredLaneIndex
        );

        if (grant) {
            for (const displacedActor of grant.displaced) {
                displacedActor.onTrafficReservationYielded?.({
                    by: actor,
                    resourceType: "lane",
                    fromId,
                    toId,
                    laneIndex: grant.laneIndex
                });
            }
            return grant.laneIndex;
        }

        const connection = this.state.getConnectionState(fromId, toId);
        const occupants = connection.lanes.flatMap(lane =>
            [...lane.occupants]
        );

        this.owner.requestPriorityPassage(actor, occupants, {
            resourceType: "lane",
            fromId,
            toId
        });
        return null;

    }

    claimPhysicalArrival(
        nodeId,
        actor
    ) {

        this.arrivals.enqueue(
            nodeId,
            actor,
            {
                rank: 5,

                priority:
                    this.getActorPriority(
                        actor
                    ),

                kind:
                    "physical-arrival"
            }
        );

        if (
            actor.navigationPassagePolicy ===
            "absolute"
        ) {

            const displaced =
                this.state
                    .yieldNodeReservationsToPriority(
                        nodeId,
                        actor
                    );

            for (
                const displacedActor of
                displaced
            ) {

                displacedActor
                    .onTrafficReservationYielded?.({
                        by:
                            actor,

                        resourceType:
                            "node",

                        nodeId
                    });

            }

            const node =
                this.state
                    .getNodeState(
                        nodeId
                    );

            const blockers =
                [...node.occupants]
                    .filter(candidate =>
                        candidate !== actor &&
                        !node.crossingAgents
                            .has(candidate)
                    );

            this.owner
                .requestPriorityPassage(
                    actor,
                    blockers,
                    {
                        resourceType:
                            "node",

                        nodeId
                    }
                );

        }

    }

    /* hasArrivalGrant(nodeId, actor) {

        if (this.arrivals.isFirst(nodeId, actor)) return true;

        const actorsAhead = this.arrivals.getActorsBefore(nodeId, actor);

        // This is the junction handshake. Queue order decides intersecting
        // maneuvers; independent planned splines may cross concurrently.
        return actorsAhead.length > 0 && actorsAhead.every(other =>
            !this.geometry.plannedNodePathsConflict(actor, other, nodeId)
        );

    } */

    hasArrivalGrant(
        nodeId,
        actor
    ) {

        /*
         * Um ator só pode receber autorização
         * se realmente estiver na fila física
         * de chegada deste nó.
         */
        if (
            !this.arrivals.hasAt(
                nodeId,
                actor
            )
        ) {

            return false;

        }

        /*
         * A cabeça da fila sempre pode tentar
         * reservar e atravessar o nó.
         */
        if (
            this.arrivals.isFirst(
                nodeId,
                actor
            )
        ) {

            return true;

        }

        const actorsAhead =
            this.arrivals
                .getActorsBefore(
                    nodeId,
                    actor
                );

        /*
         * Se o ator está na fila, não é o
         * primeiro e não existem atores antes
         * dele, o estado da queue é incoerente.
         */
        if (
            actorsAhead.length === 0
        ) {

            return false;

        }

        /*
         * Atores fora da cabeça podem receber
         * passagem simultânea somente quando
         * sua trajetória é independente de
         * todos os atores posicionados antes
         * deles na fila.
         */
        return actorsAhead.every(
            other =>
                !this.geometry
                    .plannedNodePathsConflict(
                        actor,
                        other,
                        nodeId
                    )
        );

    }

    canCrossNode(
        nodeId,
        actor
    ) {

        if (
            !this.hasArrivalGrant(
                nodeId,
                actor
            )
        ) {

            return false;

        }

        /*
         * A compatibilidade é determinada pela
         * geometria planejada.
         *
         * Um conflito físico ou um ator preso no
         * nó deve produzir collisionBlocks no
         * TrafficState. Não inferimos bloqueio a
         * partir de currentNodeId ou hasPath().
         */
        const compatibleCrossing =
            other =>
                !this.geometry
                    .plannedNodePathsConflict(
                        actor,
                        other,
                        nodeId
                    );

        const reserved =
            this.state
                .reserveNodeForTransit(
                    nodeId,
                    actor,
                    compatibleCrossing
                );

        if (!reserved) {

            if (
                actor.navigationPassagePolicy ===
                "absolute"
            ) {

                const nodeState =
                    this.state
                        .getNodeState(
                            nodeId
                        );

                this.owner
                    .requestPriorityPassage(
                        actor,
                        nodeState.occupants,
                        {
                            resourceType:
                                "node",

                            nodeId
                        }
                    );

            }

            return false;

        }

        const mayCross =
            this.state.canCrossNode(
                nodeId,
                actor,
                compatibleCrossing
            );

        if (
            !mayCross &&
            actor.navigationPassagePolicy ===
            "absolute"
        ) {

            const nodeState =
                this.state
                    .getNodeState(
                        nodeId
                    );

            this.owner
                .requestPriorityPassage(
                    actor,
                    nodeState.occupants,
                    {
                        resourceType:
                            "node",

                        nodeId
                    }
                );

        }

        return mayCross;

    }

    isQueuedAtNode(nodeId, actor) {

        return this.departures.hasAt(nodeId, actor) ||
            this.arrivals.hasAt(nodeId, actor);

    }

    completeNodeArrival(
        nodeId,
        actor
    ) {

        this.arrivals.complete(
            nodeId,
            actor
        );

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
