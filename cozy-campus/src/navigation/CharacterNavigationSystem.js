import { EntityState } from "../core/EntityState";
import { AnimationPresets } from "../core/AnimationPresets";
import { Tween } from "../core/Tween";
import { NavigationTrafficSystem } from "./NavigationTrafficSystem";
import { InteractionNavigation } from "./InteractionNavigation";
import { CharacterCollisionFailsafe } from "./CharacterCollisionFailsafe";
import { PhysicsWorld } from "../physics/PhysicsWorld";
import { WaitReason } from "./WaitReason";
import { RouteSpline } from "./RouteSpline";
import * as THREE from "three";

export class CharacterNavigationSystem {

    constructor({
        graph,
        connector,
        helper,
        onChanged = null
    }) {

        this.graph = graph;
        this.connector = connector;
        this.helper = helper;
        this.onChanged = onChanged;
        this.contexts = new Map();
        this.traffic = new NavigationTrafficSystem(this);
        this.interactions = new InteractionNavigation(this);
        this.collisionFailsafe = new CharacterCollisionFailsafe(this);
        this.physics = new PhysicsWorld(this);
        this.grounding = null;

    }

    // -----------------------------
    // Actor registration
    // -----------------------------

    registerActor(actor, { spawnId = null } = {}) {

        // Player and NPCs use the same context. Their only difference is who
        // calls moveToClosestNode() or InteractionSystem.request().
        const context = {
            actor,
            pendingPosition: null,
            destinationId: null,
            pendingInteraction: null,
            interactionPoint: null,
            // During action -> approach -> graph, the actor physically uses
            // the approach while the original action must remain occupied.
            // Both are released only after crossing leavingInteraction.
            interactionExitPoint: null,
            activeInteraction: null,
            preparingInteraction: false,
            preparingInteractionExit: false,
            // True after exit traffic has been secured. From this moment the
            // action -> approach -> graph transition is transactional: route
            // recovery may change the later target, but cannot abandon the
            // physical return to the graph halfway through.
            interactionExitCommitted: false,
            interactionExitElapsed: 0,
            retryElapsed: 0,
            blockedElapsed: null,
            blockedTimeout: 3,
            recoveryPending: false,
            traversingLaneCurve: false,
            traversingInteractionCurve: false,
            transitTangent: null,
            arrivalFromNodeId: null,
            currentTraversal: "flat",
            deferredCommand: null,
            turningAround: false,
            turnaroundElapsed: 0,
            turnaroundDuration: 0.35,
            recoveryElapsed: 0,
            recoveryTimeout: actor.name === "Player" ? 8 : 3,
            recoveryPosition: actor.object3D.position.clone(),
            collisionWaitElapsed: 0,
            orphanedElapsed: 0
        };

        this.contexts.set(actor, context);

        actor.setWaypointReachedHandler((waypoint, completedConnection) =>
            this.handleWaypointReached(context, waypoint, completedConnection)
        );
        actor.setWaypointArrivalGuard((waypoint, completedConnection) =>
            this.canAcceptWaypointArrival(context, waypoint, completedConnection)
        );
        actor.setSegmentRequestedHandler((fromId, toId, waypoint) =>
            this.tryStartConnection(actor, fromId, toId, waypoint)
        );
        actor.setLocalPointRequestedHandler(point => {

            const context = this.requireContext(actor);

            const reserved = this.connector.reservePoint(point, actor);

            // Rejoin the graph axis while already moving toward the local
            // interaction path; returning to node center is not a separate step.
            if (reserved) this.centerActorForDeparture(context);

            this.refresh();
            return reserved;

        });
        actor.setLocalConnectionRequestedHandler((entry, waypoint) =>
            this.tryEnterConnectionFromInteraction(actor, entry, waypoint)
        );
        actor.setDepartureRequestedHandler((request, waypoint) =>
            request.originId
                ? this.traffic.tryLeaveNodeForInteraction(
                    actor,
                    request.originId,
                    waypoint,
                    request.transitionTarget
                )
                : this.traffic.tryExitConnectionForInteraction(actor)
        );
        actor.setNavigationCancelledHandler(() => {

            this.graph.releaseReservations(actor);
            this.connector.releaseReservations(actor);
            this.traffic.cancel(actor);
            this.collisionFailsafe.cancel(actor);
            this.refresh();

        });
        actor.setMovementGuard((target, delta) =>
            this.collisionFailsafe.canMove(
                actor,
                target,
                delta
            )
        );
        this.physics.registerActor(actor);

        if (spawnId) this.placeActorAtNode(actor, spawnId);

        return context;

    }

    unregisterActor(actor) {

        const context = this.contexts.get(actor);
        if (!context) return;

        this.graph.releaseAgent(actor);
        this.finishActiveInteraction(context);
        this.connector.releaseAgent(actor);
        this.traffic.unregister(actor);
        this.collisionFailsafe.unregister(actor);
        this.physics.unregisterActor(actor);
        actor.setMovementGuard(null);
        actor.setWaypointArrivalGuard(null);
        this.contexts.delete(actor);
        this.refresh();

    }

    placeActorAtNode(actor, nodeId) {

        const node = this.graph.getNode(nodeId);

        if (!node) {

            console.log(
                `[CharacterNavigationSystem] Spawn node "${nodeId}" is missing.`
            );
            return false;

        }

        actor.navigation.setCurrentNode(nodeId);
        this.graph.occupyNode(nodeId, actor);
        actor.object3D.position.x = node.position.x;
        actor.object3D.position.z = node.position.z;
        this.refresh();

        return true;

    }

    // -----------------------------
    // Commands
    // -----------------------------


    // Não usar moveToClosestNode() como comando de gameplay.
    moveToClosestNode(actor, position, {
        replaceIntent = true,
        skipTurnaround = false,
        skipInteractionExit = false,
        maxDetourFactor = 3,
        preparedCandidate = null
    } = {}) {

        const context = this.requireContext(actor);

        // Store the command before planning. Traffic, a temporary occupation
        // or even the absence of a route may reject this attempt, but they do
        // not mean that the actor stopped wanting to reach this position.
        if (actor.navigationIntentPolicy === "persistent") {

            context.pendingPosition = position.clone();
            context.pendingInteraction = null;
            context.destinationId = null;
            context.retryElapsed = 0;

        }

        if (context.preparingInteraction) {

            // Do not interrupt an authored entry animation. The newest
            // command starts after the current action has actually arrived.
            context.deferredCommand = {
                type: "node",
                position: position.clone()
            };
            return true;

        }

        if (context.turningAround) {

            context.deferredCommand = {
                type: "node",
                position: position.clone()
            };
            return true;

        }

        // Interaction exit already validated this exact plan before its
        // animation began. Reusing it avoids a second, transient planning
        // decision cancelling the lane that made the exit safe to start.
        const candidate = preparedCandidate ?? this.findBestPlan(
            context,
            position,
            maxDetourFactor
        );

        if (!candidate) {

            console.log(`[Navigation] No reachable node for ${actor.name}.`);
            this.deferPersistentIntent(context);
            return false;

        }

        const exitTraversal = this.resolveInteractionExitTraversal(
            context,
            candidate.originId,
            candidate.plan.nodeIds
        );
        const routeOriginId = exitTraversal.exitNodeId;
        const routeNodeIds = exitTraversal.nodeIds;
        const nextNodeId = routeNodeIds[1] ?? null;

        if (!skipInteractionExit && context.activeInteraction) {

            this.beginInteractionExit(context, {
                type: "node",
                position: position.clone(),
                originId: routeOriginId,
                preparedCandidate: candidate,
                intentPrepared: true
            });
            return true;

        }
        if (!skipTurnaround && this.shouldTurnAround(actor, position)) {

            if (replaceIntent) {

                this.traffic.cancel(actor);
                this.connector.releaseReservations(actor);

            }

            if (!this.traffic.preflightDeparture(
                actor,
                routeOriginId,
                nextNodeId
            )) {

                this.deferPersistentIntent(context);
                return false;

            }

            this.beginTurnaround(context, {
                type: "node",
                position: position.clone(),
                intentPrepared: true
            });
            return true;

        }

        if (replaceIntent) this.traffic.cancel(actor);

        context.pendingPosition = position.clone();
        context.pendingInteraction = null;
        context.destinationId = candidate.plan.destinationId;
        context.retryElapsed = 0;
        context.blockedElapsed = null;
        context.recoveryPending = false;
        this.prepareOrigin(context, routeOriginId, {
            preserveTrafficReservations: preparedCandidate !== null
        });

        const exitWaypoints = this.connector.createExitWaypoints(
            context.interactionPoint,
            routeOriginId
        );
        const entryConnection = exitWaypoints.find(
            waypoint => waypoint.connectionEntry
        )?.connectionEntry ?? null;
        const waypoints = [
            ...exitWaypoints,
            ...this.createTraversalWaypoints(
                context,
                routeNodeIds,
                { entryConnection }
            )
        ];
        const traversal = actor.navigation.getTraversalState();
        const alreadyThere =
            traversal.currentNodeId === candidate.plan.destinationId &&
            candidate.plan.nodeIds.length === 1 &&
            !context.interactionPoint;

        this.helper?.highlightNode(candidate.plan.destinationId);

        if (alreadyThere) {

            context.pendingPosition = null;
            context.destinationId = null;
            actor.cancel();
            return true;

        }

        actor.followWaypoints(this.createCompleteRouteSpline(
            context,
            waypoints
        ), {
            waitAtEnd: candidate.plan.status === "waiting"
        });

        return true;

    }

    moveToInteractionPoint(actor, point, onArrive = null, {
        replaceIntent = true,
        skipTurnaround = false,
        skipInteractionExit = false,
        preparedRouteCandidate = null
    } = {}) {

        const context = this.requireContext(actor);

        // Requesting the InteractionPoint that is already active is a
        // completed command, not a route with identical origin/destination.
        // This also protects autonomous behavior from re-enqueuing its current
        // ambient action while the controller is between decisions.
        if (context.activeInteraction?.point === point) return true;

        // Traffic/collision recovery can remove topology ownership while the
        // physical body has already reached its authored mark. Finish that
        // arrival locally instead of inventing a graph origin and producing a
        // spline that walks back to its beginning before returning here.
        if (this.isActorAtInteractionPoint(actor, point)) {

            return this.completeInteractionAtCurrentPosition(
                context,
                point,
                onArrive
            );

        }

        // Pointer commands must survive failed preflight checks. The queue may
        // suspend this interaction, but only a newer Player command replaces it.
        if (actor.navigationIntentPolicy === "persistent") {

            context.pendingPosition = null;
            context.pendingInteraction = { point, onArrive };
            context.destinationId = null;
            context.retryElapsed = 0;

        }

        if (context.preparingInteraction) {

            context.deferredCommand = {
                type: "interaction",
                point,
                onArrive
            };
            return true;

        }

        if (context.turningAround) {

            context.deferredCommand = {
                type: "interaction",
                point,
                onArrive
            };
            return true;

        }

        if (!point.accessible || !this.connector.connect(point)) {

            this.deferPersistentIntent(context);
            return false;

        }

        const preflight = this.findInteractionPreflight(context, point);

        if (!preflight) {

            this.deferPersistentIntent(context);
            return false;

        }

        if (!skipInteractionExit &&
            context.activeInteraction &&
            context.activeInteraction.point !== point) {

            const routeCandidate = this.findInteractionRouteCandidate(
                context,
                point
            );

            if (!routeCandidate ||
                !this.connector.reserveRoutePoints(
                    routeCandidate.route,
                    actor
                )) {

                this.deferPersistentIntent(context);
                return false;

            }

            const exitTraversal = this.resolveInteractionExitTraversal(
                context,
                routeCandidate.origin.id,
                this.getGraphWaypointIds(routeCandidate.route.waypoints)
            );

            this.beginInteractionExit(context, {
                type: "interaction",
                point,
                onArrive,
                originId: exitTraversal.exitNodeId,
                preparedRouteCandidate: routeCandidate,
                intentPrepared: true
            });
            return true;

        }

        if (!skipTurnaround &&
            this.shouldTurnAround(actor, point.getWorldPosition())) {

            if (replaceIntent) {

                this.traffic.cancel(actor);
                this.connector.releaseReservations(actor);

            }

            if (!this.traffic.preflightDeparture(
                actor,
                preflight.originId,
                preflight.nextNodeId
            )) {

                this.deferPersistentIntent(context);
                return false;

            }

            this.beginTurnaround(context, {
                type: "interaction",
                point,
                onArrive,
                intentPrepared: true
            });
            return true;

        }

        if (replaceIntent) this.traffic.cancel(actor);

        if (preparedRouteCandidate) {

            const candidate = preparedRouteCandidate;
            const exitTraversal = this.resolveInteractionExitTraversal(
                context,
                candidate.origin.id,
                this.getGraphWaypointIds(candidate.route.waypoints)
            );
            const routeWaypoints = exitTraversal.skippedOrigin
                ? candidate.route.waypoints.slice(1)
                : candidate.route.waypoints;

            this.prepareOrigin(context, exitTraversal.exitNodeId, {
                preserveTrafficReservations: true
            });
            this.interactions.beginRoute(context, point, onArrive);
            this.helper?.highlightInteractionPoint(point.id);
            const remainingRouteWaypoints = this.omitCurrentNodeWaypoint(
                context,
                routeWaypoints
            );
            const exitWaypoints = this.connector.createExitWaypoints(
                context.interactionPoint,
                exitTraversal.exitNodeId
            );
            const completeWaypoints = [
                ...exitWaypoints,
                ...this.applyRouteSplineToGraphPrefix(
                    context,
                    remainingRouteWaypoints,
                    exitWaypoints
                )
            ];
            actor.followWaypoints(this.createCompleteRouteSpline(
                context,
                completeWaypoints
            ));
            return true;

        }

        const directRoute = this.interactions.createDirectConnectionRoute(actor, point);

        if (directRoute) {

            if (!this.connector.reserveRoutePoints(directRoute, actor)) {

                this.deferPersistentIntent(context);
                return false;
            }

            this.interactions.beginRoute(context, point, onArrive);
            this.helper?.highlightInteractionPoint(point.id);
            actor.followWaypoints(this.createCompleteRouteSpline(
                context,
                directRoute.waypoints
            ));
            return true;

        }

        const candidate = this.findInteractionRouteCandidate(context, point);

        if (!candidate) {

            this.deferPersistentIntent(context);
            return false;

        }

        if (!this.connector.reserveRoutePoints(candidate.route, actor)) {

            this.deferPersistentIntent(context);
            return false;
        }

        const exitTraversal = this.resolveInteractionExitTraversal(
            context,
            candidate.origin.id,
            this.getGraphWaypointIds(candidate.route.waypoints)
        );
        const optimizedRouteWaypoints = exitTraversal.skippedOrigin
            ? candidate.route.waypoints.slice(1)
            : candidate.route.waypoints;

        this.prepareOrigin(context, exitTraversal.exitNodeId);
        this.interactions.beginRoute(context, point, onArrive);
        this.helper?.highlightInteractionPoint(point.id);
        const routeWaypoints = this.omitCurrentNodeWaypoint(
            context,
            optimizedRouteWaypoints
        );
        const exitWaypoints = this.connector.createExitWaypoints(
            context.interactionPoint,
            exitTraversal.exitNodeId
        );
        const completeWaypoints = [
            ...exitWaypoints,
            ...this.applyRouteSplineToGraphPrefix(
                context,
                routeWaypoints,
                exitWaypoints
            )
        ];
        actor.followWaypoints(this.createCompleteRouteSpline(
            context,
            completeWaypoints
        ));

        return true;

    }

    findInteractionRouteCandidate(context, point) {

        return this.getOrigins(context)
            .sort((first, second) => first.accessCost - second.accessCost)
            .map(origin => ({
                origin,
                route: this.connector.createRoute(
                    point,
                    origin.id,
                    context.actor
                )
            }))
            .find(candidate => candidate.route) ?? null;

    }

    // -----------------------------
    // Planning
    // -----------------------------

    getGraphWaypointIds(waypoints) {

        const nodeIds = [];

        for (const waypoint of waypoints) {

            if (!waypoint.id) break;
            nodeIds.push(waypoint.id);

        }

        return nodeIds;

    }

    resolveInteractionExitTraversal(context, originId, nodeIds) {

        const unchanged = {
            exitNodeId: originId,
            nodeIds,
            skippedOrigin: false
        };

        if (!context.interactionPoint ||
            nodeIds.length < 2 ||
            nodeIds[0] !== originId) return unchanged;

        const accessPoint = context.interactionPoint.via ??
            context.interactionPoint;
        const access = this.connector.connect(accessPoint, { silent: true });
        const segmentNodeIds = access?.segmentNodeIds ?? access?.nodeIds;
        const nextNodeId = nodeIds[1];
        const crossesAccessSegment = segmentNodeIds?.length === 2 &&
            segmentNodeIds.includes(originId) &&
            segmentNodeIds.includes(nextNodeId);

        if (!crossesAccessSegment) return unchanged;

        // The generated approach portal already lies inside this connection.
        // Going to originId first and immediately traversing the same segment
        // back to nextNodeId would mean portal -> lane start -> portal -> lane
        // end. Treat the approach portal as the physical start of this first
        // connection and proceed directly to its intended endpoint instead.
        return {
            exitNodeId: nextNodeId,
            nodeIds: nodeIds.slice(1),
            skippedOrigin: true
        };

    }

    findInteractionPreflight(context, point) {

        const accessPoint = point.via ?? point;
        const access = this.connector.connect(accessPoint);

        if (!access) return null;

        const traversal = context.actor.navigation.getTraversalState();
        let originIds = [];

        if (context.interactionPoint) {

            const currentAccess = this.connector.connect(
                context.interactionPoint.via ?? context.interactionPoint
            );

            originIds = currentAccess?.nodeIds ?? [];

        } else if (traversal.currentNodeId) {

            originIds = [traversal.currentNodeId];

        } else if (traversal.currentConnection) {

            originIds = [
                traversal.currentConnection.fromId,
                traversal.currentConnection.toId
            ];

        }

        const candidates = [];

        for (const originId of originIds) {

            if (this.graph.isNodeBlocked(originId)) continue;

            for (const endpointId of access.nodeIds) {

                const path = this.graph.findPreferredPath(
                    originId,
                    endpointId,
                    context.actor
                );

                if (path) candidates.push({ originId, path });

            }

        }

        if (candidates.length === 0) return null;

        const selected = candidates.reduce((best, candidate) =>
            candidate.path.cost < best.path.cost ? candidate : best
        );

        return {
            originId: selected.originId,
            nextNodeId: selected.path.nodeIds[1] ?? null
        };

    }

    findBestPlan(context, position, maxDetourFactor = 3) {

        const candidates = this.getOrigins(context)
            .map(origin => ({
                originId: origin.id,
                accessCost: origin.accessCost,
                plan: this.graph.planClosestPath(
                    origin.id,
                    position,
                    context.actor,
                    { maxDetourFactor }
                )
            }))
            .filter(candidate => candidate.plan.status !== "unreachable");

        if (candidates.length === 0) return null;

        return candidates.reduce((best, current) =>
            current.accessCost + current.plan.cost <
                best.accessCost + best.plan.cost ? current : best
        );

    }

    getOrigins(context) {

        const { actor, interactionPoint } = context;

        if (interactionPoint) {

            const accessPoint = interactionPoint.via ?? interactionPoint;
            const connection = this.connector.connect(accessPoint);

            if (!connection) return [];

            return connection.nodeIds
                // Occupancy is temporary and must not force an interaction
                // exit through the opposite endpoint. Planning keeps the
                // intended endpoint and traffic waits at approach if needed.
                .filter(id => !this.graph.isNodeBlocked(id))
                .map(id => ({
                    id,
                    accessCost: Math.sqrt(
                        this.graph.getPlanarDistanceSquared(
                            connection.projectedPosition,
                            this.graph.requireNode(id).position
                        )
                    )
                }));

        }

        const traversal = actor.navigation.getTraversalState();

        if (traversal.currentNodeId) {
            return [{ id: traversal.currentNodeId, accessCost: 0 }];
        }

        if (!traversal.currentConnection) return [];

        return [
            traversal.currentConnection.fromId,
            traversal.currentConnection.toId
        ]
            .filter(id => this.graph.isNodeAvailable(id, actor))
            .map(id => ({
                id,
                accessCost: Math.sqrt(
                    this.graph.getPlanarDistanceSquared(
                        actor.object3D.position,
                        this.graph.requireNode(id).position
                    )
                )
            }));

    }

    prepareOrigin(context, originId, {
        preserveTrafficReservations = false
    } = {}) {

        const {
            actor,
            interactionPoint
        } = context;

        if (!interactionPoint) {

            if (
                !actor.navigation
                    .getTraversalState()
                    .currentConnection
            ) {

                return;

            }

            this.graph.releaseReservations(
                actor
            );

            this.graph.reserveNode(
                originId,
                actor
            );

            return;

        }

        /*
         * Um ator em InteractionPoint ainda não está no nó.
         * A entrada no tráfego será autorizada por
         * tryEnterFromInteraction(), que reserva a lane e
         * o endpoint apropriados.
         */
        if (!preserveTrafficReservations) {

            this.graph.releaseReservations(
                actor
            );

        }

        actor.navigation.setCurrentNode(
            null
        );

        this.refresh();

    }

    createTraversalWaypoints(context, nodeIds, {
        entryConnection = null
    } = {}) {

        const traversal = context.actor.navigation.getTraversalState();
        const startsAtCurrentNode =
            !context.interactionPoint &&
            traversal.currentNodeId === nodeIds[0];
        const startsAfterDirectInteractionExit =
            context.interactionPoint !== null && !entryConnection;
        const startsOnCurrentConnection =
            (entryConnection ?? traversal.currentConnection) !== null &&
            (
                (entryConnection ?? traversal.currentConnection).fromId ===
                    nodeIds[0] ||
                (entryConnection ?? traversal.currentConnection).toId ===
                    nodeIds[0]
            );
        const originAlreadyRepresented =
            startsAtCurrentNode || startsAfterDirectInteractionExit;
        const ordinaryWaypoints = this.graph.createWaypoints(
            originAlreadyRepresented ? nodeIds.slice(1) : nodeIds
        );

        if (startsOnCurrentConnection) {

            return this.createRouteSplineWaypoints(
                context,
                nodeIds,
                ordinaryWaypoints,
                {
                    entryConnection:
                        entryConnection ?? traversal.currentConnection
                }
            );

        }

        if (!originAlreadyRepresented || nodeIds.length < 2) {

            return ordinaryWaypoints;

        }

        return this.createRouteSplineWaypoints(
            context,
            nodeIds,
            ordinaryWaypoints
        );

    }

    createRouteSplineWaypoints(context, nodeIds, waypoints, {
        entryConnection = null
    } = {}) {

        const { actor } = context;
        const anchors = [actor.object3D.position.clone()];
        const markers = [];

        const pushAnchor = position => {

            const previous = anchors.at(-1);

            if (previous.distanceToSquared(position) <= 0.000001) {

                return anchors.length - 1;

            }

            anchors.push(position.clone());
            return anchors.length - 1;

        };

        if (entryConnection) {

            const originId = nodeIds[0];

            if (entryConnection.fromId !== originId &&
                entryConnection.toId !== originId) {

                return waypoints;

            }

            const connection = this.graph.requireConnection(
                entryConnection.fromId,
                entryConnection.toId
            );
            const sameDirection =
                connection.fromId === entryConnection.fromId;
            const preferredLaneIndex = sameDirection ? 0 : 1;
            // Interaction exits already selected the lane from the authored
            // side of the approach. Never recalculate it from the connection's
            // canonical order: doing so puts the portal on one lane and the
            // following spline endpoint on the other, producing a loop.
            const laneIndex = Number.isInteger(entryConnection.laneIndex)
                ? entryConnection.laneIndex
                : this.graph.getConnectionLaneIndex(
                    entryConnection.fromId,
                    entryConnection.toId,
                    actor
                ) ?? preferredLaneIndex;
            const endpoint = this.graph.getConnectionLaneNodePosition(
                originId,
                entryConnection.fromId,
                entryConnection.toId,
                laneIndex
            );

            markers.push({
                nodeId: originId,
                anchorIndex: pushAnchor(endpoint),
                laneIndex,
                position: endpoint.clone()
            });

        }

        for (let index = 0; index < nodeIds.length - 1; index++) {

            const fromId = nodeIds[index];
            const toId = nodeIds[index + 1];
            const connection = this.graph.requireConnection(fromId, toId);
            const sameDirection = connection.fromId === fromId;
            // Lane A is the right lane in the connection's canonical
            // direction; reverse travel uses lane B as its right lane.
            const preferredLaneIndex = sameDirection ? 0 : 1;
            // Build the complete spline through a currently usable lane when
            // possible. Traffic still performs the authoritative reservation
            // immediately before entry and may make the actor wait/replan.
            const laneIndex = this.graph.findAvailableLaneIndex(
                connection,
                fromId,
                toId,
                actor
            ) ?? preferredLaneIndex;
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

            // Both portals are mandatory interpolation anchors. RouteSpline
            // crosses them exactly; they are not control handles that the
            // curve is allowed to cut around.
            pushAnchor(laneStart);
            const endpointAnchorIndex = pushAnchor(laneEnd);

            markers.push({
                nodeId: toId,
                anchorIndex: endpointAnchorIndex,
                laneIndex,
                position: laneEnd.clone()
            });

        }

        if (anchors.length < 2 || markers.length !== waypoints.length) {

            return waypoints;

        }

        const curve = new RouteSpline(anchors);
        curve.updateArcLengths();
        const debugPoints = curve.getDebugPoints(
            THREE.MathUtils.clamp(anchors.length * 20, 96, 256)
        );

        return waypoints.map((waypoint, index) => {

            const marker = markers[index];
            const stopDistance = curve.getDistanceAtAnchor(
                marker.anchorIndex
            );
            const previousMarker = markers[index - 1];

            return {
                ...waypoint,
                position: marker.position,
                routeCurve: curve,
                routeSpline: true,
                routeAnchorIndex: marker.anchorIndex,
                curveStartDistance: previousMarker
                    ? curve.getDistanceAtAnchor(previousMarker.anchorIndex)
                    : 0,
                curveStopDistance: stopDistance,
                routeCurveFinal: index === waypoints.length - 1,
                plannedLaneIndex: marker.laneIndex,
                routeFirstLaneStart: anchors[1]?.clone() ?? null,
                routeSplinePoints: debugPoints
            };

        });

    }

    applyRouteSplineToGraphPrefix(context, waypoints, exitWaypoints = []) {

        const currentNodeId = context.actor.navigation
            .getTraversalState().currentNodeId;

        const graphWaypoints = [];

        for (const waypoint of waypoints) {

            if (!waypoint.id) break;
            graphWaypoints.push(waypoint);

        }

        if (graphWaypoints.length === 0) return waypoints;

        const remainingWaypoints = waypoints.slice(graphWaypoints.length);

        // createRoute() includes the graph origin as a normal node waypoint.
        // While leaving an InteractionPoint, createExitWaypoints() already
        // owns that arrival through its lane portal. Keeping the origin here
        // would insert the node center between the portal and the next lane.
        if (context.interactionPoint) {

            const nodeIds = graphWaypoints.map(waypoint => waypoint.id);
            const entryConnection = exitWaypoints.find(
                waypoint => waypoint.connectionEntry
            )?.connectionEntry ?? null;

            if (entryConnection) {

                return [
                    ...this.createRouteSplineWaypoints(
                        context,
                        nodeIds,
                        graphWaypoints,
                        { entryConnection }
                    ),
                    ...remainingWaypoints
                ];

            }

            if (nodeIds.length < 2) return remainingWaypoints;

            return [
                ...this.createRouteSplineWaypoints(
                    context,
                    nodeIds,
                    graphWaypoints.slice(1)
                ),
                ...remainingWaypoints
            ];

        }

        if (!currentNodeId) return waypoints;

        const nodeIds = [
            currentNodeId,
            ...graphWaypoints.map(waypoint => waypoint.id)
        ];
        const splineWaypoints = this.createRouteSplineWaypoints(
            context,
            nodeIds,
            graphWaypoints
        );

        return [
            ...splineWaypoints,
            ...remainingWaypoints
        ];

    }

    createCompleteRouteSpline(context, waypoints) {

        if (waypoints.length === 0) return waypoints;

        const anchors = [context.actor.object3D.position.clone()];
        const markerIndices = [];
        let importedCurve = null;
        let importedAnchorIndices = [];

        const pushAnchor = position => {

            if (anchors.at(-1).distanceToSquared(position) <= 0.000001) {

                return anchors.length - 1;

            }

            anchors.push(position.clone());
            return anchors.length - 1;

        };

        for (let index = 0; index < waypoints.length; index++) {

            const waypoint = waypoints[index];

            // A direct node InteractionPoint has no authored access edge, so
            // its default portal is the node center. Route context supplies a
            // better portal: the incoming lane endpoint when entering it.
            if (waypoint.leavingGraph &&
                waypoint.departureRequest?.originId &&
                !waypoint.laneStartPosition) {

                const previous = waypoints[index - 1];
                const portal = previous?.routeSpline &&
                    previous.id === waypoint.departureRequest.originId
                    ? previous.position
                    : context.actor.navigation
                        .getTraversalState().currentNodeId ===
                            waypoint.departureRequest.originId
                        ? context.actor.object3D.position
                        : null;

                if (portal) waypoint.position.copy(portal);

            }

            // On the reverse trip, enter that same direct node already at the
            // first lane start of the outgoing graph route. This removes the
            // center detour between an ambient point and circulation.
            if (waypoint.leavingInteraction && waypoint.graphEntryNodeId) {

                const nextRouteWaypoint = waypoints.slice(index + 1).find(
                    candidate => candidate.routeSpline
                );
                const portal = nextRouteWaypoint?.routeFirstLaneStart;

                if (portal) waypoint.position.copy(portal);

            }

        }

        for (let waypointIndex = 0;
            waypointIndex < waypoints.length;
            waypointIndex++) {

            const waypoint = waypoints[waypointIndex];

            if (waypoint.connectionEntry) {

                const entry = waypoint.connectionEntry;
                const connection = this.graph.requireConnection(
                    entry.fromId,
                    entry.toId
                );
                const preferredLaneIndex =
                    connection.fromId === entry.fromId ? 0 : 1;
                const reservedLaneIndex =
                    this.graph.getConnectionLaneIndex(
                        entry.fromId,
                        entry.toId,
                        context.actor
                    );
                const laneIndex = Number.isInteger(waypoint.plannedLaneIndex)
                    ? waypoint.plannedLaneIndex
                    : reservedLaneIndex ??
                        this.graph.findAvailableLaneIndex(
                            connection,
                            entry.fromId,
                            entry.toId,
                            context.actor
                        ) ?? preferredLaneIndex;
                const anchor = entry.anchorId
                    ? this.connector.anchors.get(entry.anchorId)
                    : null;

                waypoint.plannedLaneIndex = laneIndex;

                // Geometry and reservation must describe the same lane.
                // Otherwise a retry could keep waiting for lane A while the
                // visible spline had already been drawn through free lane B.
                if (anchor?.lanePositions[laneIndex]) {

                    waypoint.position.copy(anchor.lanePositions[laneIndex]);

                }

            }

            if (waypoint.routeSpline && waypoint.routeCurve?.points) {

                if (importedCurve !== waypoint.routeCurve) {

                    importedCurve = waypoint.routeCurve;
                    importedAnchorIndices = [anchors.length - 1];

                    for (const point of importedCurve.points.slice(1)) {

                        importedAnchorIndices.push(pushAnchor(point));

                    }

                }

                markerIndices.push(
                    importedAnchorIndices[waypoint.routeAnchorIndex]
                );
                continue;

            }

            if (waypoint.leavingInteraction) {

                const previousWaypoint = waypoints[waypointIndex - 1];
                const departureDirection = waypoint.departureDirection ??
                    previousWaypoint?.departureDirection ?? null;
                const entry = waypoint.connectionEntry;
                const laneIndex = waypoint.plannedLaneIndex;
                const laneEnd = entry && Number.isInteger(laneIndex)
                    ? this.graph.getConnectionLaneNodePosition(
                        entry.toId,
                        entry.fromId,
                        entry.toId,
                        laneIndex
                    )
                    : null;

                // The route-wide natural spline does not know the facing of
                // an actor leaving an InteractionPoint. With only
                // approach -> portal -> lane end, a sharp right turn can
                // overshoot the distant portal and loop back around it.
                // Import a few samples from the authored interaction Bezier
                // as mandatory spline anchors. The complete route remains a
                // single spline, but its first turn now leaves in the actor's
                // actual forward direction and joins the selected lane in
                // its travel direction.
                if (departureDirection && laneEnd) {

                    const exitCurve = this.traffic
                        .createInteractionCurveWaypoints(
                            anchors.at(-1),
                            waypoint.position,
                            laneEnd,
                            8,
                            departureDirection
                        );

                    for (const sample of exitCurve) {

                        pushAnchor(sample.position);

                    }

                }

            }

            if (waypoint.laneStartPosition) {

                pushAnchor(waypoint.laneStartPosition);

            }

            markerIndices.push(pushAnchor(waypoint.position));

        }

        if (anchors.length < 2) return waypoints;

        const curve = new RouteSpline(anchors);
        curve.updateArcLengths();
        const debugPoints = curve.getDebugPoints(
            THREE.MathUtils.clamp(anchors.length * 20, 96, 256)
        );

        return waypoints.map((waypoint, index) => {

            let plannedLaneIndex = waypoint.plannedLaneIndex;

            if (waypoint.connectionEntry &&
                !Number.isInteger(plannedLaneIndex)) {

                const entry = waypoint.connectionEntry;
                const connection = this.graph.requireConnection(
                    entry.fromId,
                    entry.toId
                );

                plannedLaneIndex = connection.fromId === entry.fromId ? 0 : 1;

            }

            const stopDistance = curve.getDistanceAtAnchor(
                markerIndices[index]
            );
            const startDistance = index > 0
                ? curve.getDistanceAtAnchor(markerIndices[index - 1])
                : 0;

            return {
                ...waypoint,
                routeCurve: curve,
                routeSpline: true,
                routeAnchorIndex: markerIndices[index],
                curveStartDistance: startDistance,
                curveStopDistance: stopDistance,
                routeCurveFinal: index === waypoints.length - 1,
                plannedLaneIndex,
                routeSplinePoints: debugPoints
            };

        });

    }

    omitCurrentNodeWaypoint(context, waypoints) {

        const traversal = context.actor.navigation.getTraversalState();
        const startsAtCurrentNode =
            !context.interactionPoint &&
            traversal.currentNodeId === waypoints[0]?.id;

        return startsAtCurrentNode ? waypoints.slice(1) : waypoints;

    }

    // -----------------------------
    // Traffic facade
    // -----------------------------

    tryStartConnection(actor, fromId, toId, waypoint = null) {

        return this.traffic.tryStartConnection(
            actor,
            fromId,
            toId,
            waypoint
        );

    }

    canAcceptWaypointArrival(context, waypoint, completedConnection) {

        if (!completedConnection || !waypoint?.id) return true;

        const { actor } = context;
        this.traffic.claimPhysicalArrival(waypoint.id, actor);

        if (!this.graph.isNodeAvailable(waypoint.id, actor)) {
            this.traffic.setWaitReason(
                actor,
                waypoint.id,
                WaitReason.NODE_OCCUPIED
            );
            return false;
        }

        return true;

    }

    rejectInvalidSegment(actor, fromId, toId) {

        const context = this.requireContext(actor);

        console.log(
            `[Navigation] ${actor.name} discarded stale segment ` +
            `"${fromId}" -> "${toId}".`
        );

        actor.cancel();
        actor.setState(EntityState.WAITING);
        context.retryElapsed = 0;

        // pendingPosition/pendingInteraction remain intact. The normal retry
        // cycle will build a fresh route from the actor's real current node.
        this.refresh();

    }

    tryEnterConnectionFromInteraction(actor, entry, waypoint = null) {

        return this.traffic.tryEnterFromInteraction(actor, entry, waypoint);

    }

    handleWaypointReached(context, waypoint, completedConnection) {

        const { actor } = context;

        const interactionResult = this.interactions.handleWaypoint(
            context,
            waypoint
        );

        if (interactionResult === "waiting") return false;
        if (interactionResult) return;

        if (!waypoint.id) return;

        if (context.interactionPoint) {

            this.leaveInteractionPoint(context);

        }

        const isFinalRouteWaypoint =
            actor.navigation.getNextWaypoint() === null;
        const reachedDestination =
            waypoint.id === context.destinationId ||
            (
                actor.navigationIntentPolicy !== "persistent" &&
                isFinalRouteWaypoint &&
                context.pendingPosition !== null &&
                context.pendingInteraction === null
            );

        if (reachedDestination && waypoint.id !== context.destinationId) {

            console.log(
                `[NavigationRecovery] ${actor.name} treats final waypoint ` +
                `"${waypoint.id}" as its destination after intent ` +
                `synchronization was lost.`
            );

        }

        if (completedConnection) {

            context.traversingLaneCurve = false;
            this.graph.clearActiveLaneCurve(actor);
            context.arrivalFromNodeId = completedConnection.fromId;
            context.currentTraversal = "flat";
            actor.traversalType = "flat";

            this.graph.releaseConnection(
                completedConnection.fromId,
                completedConnection.toId,
                actor
            );

            if (reachedDestination &&
                actor.visual &&
                Math.abs(actor.visual.position.x) > 0.001) {

                AnimationPresets.to(actor, {
                    object: actor.visual.position,
                    property: "x",
                    to: 0,
                    duration: 0.25,
                    easing: Tween.easeInOutQuad
                });

            }

        }

        if (!this.graph.occupyNode(waypoint.id, actor)) {

            actor.setState(EntityState.WAITING);
            console.log(
                `[NavigationReservation] ${actor.name} reached ` +
                `"${waypoint.id}" but waits for its reservation to become ` +
                `occupiable.`
            );
            this.refresh();
            return false;

        }

        this.traffic.completeNodeArrival(waypoint.id, actor);

        if (reachedDestination) {

            context.pendingPosition =
                null;

            context.destinationId =
                null;

            actor.setState(
                EntityState.IDLE
            );

            console.warn(
                `[Navigation] "${waypoint.id}" ` +
                `was used as a terminal destination. ` +
                `Navigation nodes must only be used ` +
                `for transit.`
            );

            this.graph.releaseNode(
                waypoint.id,
                actor
            );

            actor.navigation.setCurrentNode(
                waypoint.id
            );

        } else {

            actor.setState(
                EntityState.WALKING
            );

        }

        // console.log(`[Navigation] ${actor.name} passed: ${waypoint.id}`);
        this.refresh();

    }

    setGrounding(grounding) {

        this.grounding = grounding;

    }

    projectWaypointsToGround(waypoints, options = {}) {

        if (!this.grounding) return waypoints;

        for (const waypoint of waypoints) {

            if (!waypoint.airborne) {

                this.grounding.projectPosition(
                    waypoint.position,
                    1,
                    options
                );

            }

        }

        return waypoints;

    }

    /* orientActor(actor, direction) {

        // Helper and actor consume this exact same world-space vector. Do not
        // reconstruct an Euler angle here: lookAt keeps the +Z convention used
        // by Locomotion and removes ambiguity around arrival direction.
        actor.object3D.lookAt(
            actor.object3D.position.x + direction.x,
            actor.object3D.position.y,
            actor.object3D.position.z + direction.z
        );

    } */

    centerActorForDeparture(context) {

        const { actor } = context;

        const currentNodeId = actor.navigation.getTraversalState().currentNodeId;

        if (currentNodeId) {

            // Returning toward the center makes this actor part of traffic
            // again, so the node must stop being passable immediately.
            this.graph.setNodeAgentResting(currentNodeId, actor, false);

        }

        // object3D already occupies the resting spot in world space. Once the
        // route is authorized, Locomotion moves directly from there to the next
        // graph node and owns all turning; no visual recentering is necessary.
        actor.cancelTweens(actor.object3D.position, ["x", "z"]);
        return true;

    }

    leaveInteractionPoint(context) {

        if (!context.interactionPoint) return;

        if (context.activeInteraction?.point === context.interactionPoint) {

            this.finishActiveInteraction(context);

        }

        this.connector.releasePoint(
            context.interactionPoint,
            context.actor
        );

        context.interactionPoint = null;

    }

    releaseInteractionExitPoint(context) {

        if (!context.interactionExitPoint) return;

        this.connector.releasePoint(
            context.interactionExitPoint,
            context.actor
        );

        context.interactionExitPoint = null;

    }

    completeInteractionExit(context) {

        this.leaveInteractionPoint(context);
        this.releaseInteractionExitPoint(context);
        context.interactionExitCommitted = false;

    }

    finishActiveInteraction(context) {

        const interaction = context.activeInteraction;

        if (!interaction) return;

        interaction.target?.endInteraction(
            context.actor,
            interaction.point
        );
        context.activeInteraction = null;

    }

    beginInteractionExit(context, command) {

        if (context.preparingInteractionExit) {

            // A newer Player command replaces the destination, but never cuts
            // short the stand-up/release animation already in progress.
            context.deferredCommand = command;
            return;

        }

        if (context.interactionExitCommitted) {

            // The actor has already stood up or left its action pose. A new
            // target replaces only what happens after the exit; replaying the
            // exit animation would teleport it back toward the old action.
            context.deferredCommand = command;

            if (!context.actor.navigation.hasPath()) {

                this.executeDeferredCommand(context, {
                    skipInteractionExit: true
                });

            }
            return;

        }

        const interaction = context.activeInteraction;
        const approachPoint = interaction.point.via ?? interaction.point;
        const exitWaypoints = this.connector.createExitWaypoints(
            interaction.point,
            command.originId
        );
        const connectionEntry = exitWaypoints.find(
            waypoint => waypoint.connectionEntry
        )?.connectionEntry ?? null;

        context.deferredCommand = command;
        context.actor.pause();

        // Reserve the real exit before playing the visual transition. Without
        // this preflight, the actor visibly stood up and only then discovered
        // that its lane was busy, appearing frozen beside the interaction.
        if (!this.traffic.preflightInteractionExit(
            context.actor,
            connectionEntry
        )) {

            context.retryElapsed = 0;
            return;

        }

        context.interactionExitCommitted = true;
        context.preparingInteractionExit = true;
        context.interactionExitElapsed = 0;

        interaction.target?.prepareInteractionExit(
            context.actor,
            interaction.point,
            approachPoint,
            () => {

                if (!context.preparingInteractionExit) return;

                context.preparingInteractionExit = false;
                context.interactionExitElapsed = 0;
                this.executeDeferredCommand(context, {
                    skipInteractionExit: true
                });

            }
        );

    }

    shouldTurnAround(actor, requestedPosition) {

        if (!actor.isState(EntityState.WALKING)) return false;

        const waypoint = actor.navigation.getCurrentWaypoint();

        if (!waypoint) return false;

        const currentDirection = waypoint.position.clone()
            .sub(actor.object3D.position)
            .setY(0);
        const requestedDirection = requestedPosition.clone()
            .sub(actor.object3D.position)
            .setY(0);

        if (currentDirection.lengthSq() < 0.0001 ||
            requestedDirection.lengthSq() < 0.0001) return false;

        return currentDirection.normalize().dot(
            requestedDirection.normalize()
        ) < -0.1;

    }

    beginTurnaround(context, command) {

        // The replacement route was structurally validated and queued before
        // this callback. Future animation may replace the temporary timer.
        context.deferredCommand = command;
        context.turningAround = true;
        context.turnaroundElapsed = 0;
        context.actor.pause();
        this.onTurnaroundRequested(context.actor);

    }

    onTurnaroundRequested(actor) {

        // Future animation callback: play a turn-in-place clip and replace the
        // timer by its onComplete signal before executing the deferred route.
        console.log(`[Navigation] ${actor.name} prepares to turn around.`);

    }

    executeDeferredCommand(context, { skipInteractionExit = false } = {}) {

        const command = context.deferredCommand;

        if (!command) return false;

        context.deferredCommand = null;

        let accepted;

        if (command.type === "interaction") {

            accepted = this.moveToInteractionPoint(
                context.actor,
                command.point,
                command.onArrive,
                {
                    replaceIntent: !command.intentPrepared,
                    skipTurnaround: true,
                    skipInteractionExit,
                    preparedRouteCandidate:
                        command.preparedRouteCandidate ?? null
                }
            );

        } else {

            accepted = this.moveToClosestNode(
                context.actor,
                command.position,
                {
                    replaceIntent: !command.intentPrepared,
                    skipTurnaround: true,
                    skipInteractionExit,
                    preparedCandidate: command.preparedCandidate ?? null
                }
            );

        }

        if (!accepted) {

            context.deferredCommand = command;
            context.actor.pause();

        }

        return accepted;

    }

    // -----------------------------
    // Lifecycle
    // -----------------------------

    update(delta) {

        this.traffic.update(delta);

        for (const context of this.contexts.values()) {

            const { actor } = context;

            // Debug-only timer: this separates a pause owned by a visual exit
            // animation from a pause caused by traffic after it has finished.
            if (context.preparingInteractionExit) {

                context.interactionExitElapsed += delta;

            }

            if (this.monitorNavigationProgress(context, delta)) continue;
            if (this.recoverOrphanedActor(context, delta)) continue;

            this.traffic.prequeueUpcomingTransit(actor);

            if (context.turningAround) {

                context.turnaroundElapsed += delta;

                if (context.turnaroundElapsed >= context.turnaroundDuration) {

                    context.turningAround = false;
                    context.turnaroundElapsed = 0;
                    this.executeDeferredCommand(context);

                }

                continue;

            }

            // prepareInteractionExit() exclusively owns deferredCommand until
            // its animation callback fires. Generic retries here could execute
            // the command early, then leave the actor lowered at seat with no
            // command remaining for onComplete.
            if (context.preparingInteractionExit) continue;

            if (context.deferredCommand) {

                context.retryElapsed += delta;

                if (context.retryElapsed < 0.5) continue;

                context.retryElapsed = 0;
                this.executeDeferredCommand(context);
                continue;

            }

            if (context.traversingLaneCurve &&
                actor.isState(EntityState.WAITING) &&
                !this.traffic.isWaitingForQueue(actor)) {

                actor.resume();
                continue;

            }

            if (context.traversingInteractionCurve &&
                actor.isState(EntityState.WAITING) &&
                !this.traffic.isWaitingForQueue(actor)) {

                actor.resume();
                continue;

            }

            if (context.blockedElapsed !== null) {

                context.blockedElapsed += delta;

                if (context.blockedElapsed >= context.blockedTimeout) {

                    context.blockedElapsed = null;
                    this.abandonBlockedIntent(context);

                }

            }

            if (context.blockedElapsed !== null) continue;

            // prepareInteraction() owns this pause and resumes through its
            // onComplete callback; traffic retry must not interrupt animation.
            if (context.preparingInteraction) continue;

            if (!actor.isState(EntityState.WAITING)) continue;

            context.retryElapsed += delta;

            if (context.retryElapsed < 0.5) continue;

            context.retryElapsed = 0;

            if (context.pendingInteraction ||
                actor.navigation.getCurrentWaypoint()?.interactionPoint) {

                if (actor.navigation.hasPath()) {

                    actor.resume();

                } else if (context.pendingInteraction) {

                    const { point, onArrive } = context.pendingInteraction;
                    this.moveToInteractionPoint(actor, point, onArrive, {
                        replaceIntent: false,
                        skipTurnaround: true
                    });

                }
                continue;

            }

            if (context.pendingPosition) {

                this.moveToClosestNode(actor, context.pendingPosition, {
                    replaceIntent: false,
                    skipTurnaround: true
                });

            }

        }

        // Scene updates every Character before this system. Cannon resolves
        // residual actor contacts after navigation has produced its intent.
        this.physics.solve(delta);

    }

    monitorNavigationProgress(context, delta) {

        const { actor } = context;
        const traversal = actor.navigation.getTraversalState();
        const hasGraphOwnership = Boolean(
            traversal.currentNodeId || traversal.currentConnection
        );
        const hasIntent = Boolean(
            context.pendingInteraction || context.pendingPosition
        );

        // A predictive collision stop is expected lack of progress. It must
        // not trigger generic recovery immediately. Autonomous actors still
        // need an escape from intermittent stop/go oscillation, though: the
        // timer decays slowly instead of resetting on every single free frame.
        if (this.collisionFailsafe.isWaiting(actor)) {

            context.collisionWaitElapsed += delta;

            if (actor.navigationIntentPolicy !== "persistent" &&
                !context.preparingInteraction &&
                !context.preparingInteractionExit &&
                !context.interactionExitCommitted &&
                context.collisionWaitElapsed >= 4) {

                context.collisionWaitElapsed = 0;
                this.collisionFailsafe.cancel(actor);

                if (hasGraphOwnership) {

                    console.warn(
                        `[NavigationRecovery] ${actor.name} abandons a route ` +
                        `after prolonged collision avoidance.`
                    );
                    this.abandonReplaceableRoute(context);

                } else {

                    // Portal -> approach/action is intentionally off-graph.
                    // Clearing that local route leaves no topological origin
                    // from which an autonomous controller can plan again.
                    console.warn(
                        `[NavigationRecovery] ${actor.name} rebuilds an ` +
                        `off-graph interaction route after prolonged ` +
                        `collision avoidance.`
                    );
                    this.restartIntentFromNearestAccess(context);

                }
                return true;

            }

            context.recoveryElapsed = 0;
            context.recoveryPosition.copy(actor.object3D.position);
            return false;

        }

        context.collisionWaitElapsed = Math.max(
            0,
            context.collisionWaitElapsed - delta * 0.25
        );

        // No movement is expected while DepartureQueue owns the actor. Running
        // recovery here would cancel a valid request and enqueue it again at
        // the tail, which can starve both Player and NPC indefinitely.
        if (this.traffic.isQueued(actor)) {

            if (!actor.navigation.hasPath()) {

                const interactionExitOwnsQueue =
                    context.activeInteraction &&
                    (context.preparingInteractionExit ||
                        context.deferredCommand);

                if (interactionExitOwnsQueue) {

                    // Interaction exit intentionally reserves traffic before
                    // the stand-up/release animation creates a navigation
                    // path. This is a committed exit, not a stale queue row.
                    context.recoveryElapsed = 0;
                    context.recoveryPosition.copy(actor.object3D.position);
                    return false;

                }

                // A queue orders departure of an existing route. Without a
                // waypoint there is nothing left to authorize, so retaining
                // the request would exempt this actor from recovery forever.
                console.warn(
                    `[NavigationQueue] ${actor.name} had a stale queue entry ` +
                    `without a route; releasing it for replanning.`
                );
                this.traffic.cancel(actor);
                actor.setState(EntityState.WAITING);
                return false;

            }

            // prequeueUpcomingTransit() may reserve order while the actor is
            // still moving on the previous connection. Timeout measures an
            // actual stopped queue, never this useful look-ahead period.
            if (!actor.isState(EntityState.WAITING)) {

                context.recoveryElapsed = 0;
                context.recoveryPosition.copy(actor.object3D.position);
                return false;

            }

            context.recoveryElapsed = 0;
            context.recoveryPosition.copy(actor.object3D.position);
            return false;

        }

        const mayRecover = hasIntent &&
            !context.preparingInteraction &&
            !context.preparingInteractionExit &&
            !context.interactionExitCommitted;

        if (!mayRecover) {

            context.recoveryElapsed = 0;
            context.recoveryPosition.copy(actor.object3D.position);
            return false;

        }

        const progress = context.recoveryPosition.distanceTo(
            actor.object3D.position
        );

        if (progress >= 0.025) {

            context.recoveryElapsed = 0;
            context.recoveryPosition.copy(actor.object3D.position);
            return false;

        }

        context.recoveryElapsed += delta;

        if (context.recoveryElapsed < context.recoveryTimeout) return false;

        context.recoveryElapsed = 0;
        context.recoveryPosition.copy(actor.object3D.position);
        this.restartIntentFromNearestAccess(context);
        return true;

    }

    retryPreservedIntent(context, { maxDetourFactor = 3 } = {}) {

        if (context.pendingInteraction) {

            const { point, onArrive } = context.pendingInteraction;
            return this.moveToInteractionPoint(
                context.actor,
                point,
                onArrive,
                { replaceIntent: false, skipTurnaround: true }
            );

        }

        if (context.pendingPosition) {

            return this.moveToClosestNode(
                context.actor,
                context.pendingPosition,
                {
                    replaceIntent: false,
                    skipTurnaround: true,
                    maxDetourFactor
                }
            );

        }

        context.actor.setState(EntityState.IDLE);
        return false;

    }

    resolveTrafficWaitTimeout(actor, wait) {

        const replaceableWait =
            actor.navigationIntentPolicy !== "persistent" &&
            (
                wait.reason === WaitReason.LANE_FULL ||
                wait.reason === WaitReason.ENDPOINT_WAIT ||
                wait.reason === WaitReason.QUEUE_HEAD
            );
        const persistentReplan =
            actor.navigationIntentPolicy === "persistent" &&
            wait.reason === WaitReason.LANE_FULL;

        if ((!replaceableWait && !persistentReplan) ||
            wait.timeoutCount < 2) {

            return false;

        }

        const context = this.requireContext(actor);

        if (context.interactionExitCommitted) {

            // The actor may already be between action, approach and graph.
            // Clearing its route here would strand it off-graph. Traffic keeps
            // the queue and the ordinary retry loop preserves the later goal.
            context.collisionWaitElapsed = 0;
            context.recoveryElapsed = 0;
            return true;

        }

        console.warn(
            `[NavigationRecovery] ${actor.name} abandons a stale traffic wait ` +
            `at "${wait.resourceId}" and releases its route.`
        );

        this.traffic.cancel(actor);
        this.connector.releaseReservations(actor);
        this.graph.releaseReservations(actor);
        this.graph.clearActiveLaneCurve(actor);
        actor.navigation.clearRoute();
        actor.locomotion.resetCurve();
        context.traversingLaneCurve = false;
        context.traversingInteractionCurve = false;
        context.retryElapsed = 0;

        if (actor.navigationIntentPolicy === "persistent") {

            actor.setState(EntityState.WAITING);
            this.retryPreservedIntent(context, { maxDetourFactor: 6 });

        } else {

            // Autonomous actors may abandon one ambient action. Their
            // controller receives IDLE and chooses a new task next update.
            this.abandonReplaceableRoute(context);

        }

        this.refresh();
        return true;

    }

    abandonReplaceableRoute(context) {

        const { actor } = context;

        if (context.interactionExitCommitted) {

            // Losing this path would strand the actor between an interaction
            // and the graph. Preserve the committed exit; once clearance is
            // restored, the existing route or retry loop can continue it.
            context.collisionWaitElapsed = 0;
            context.recoveryElapsed = 0;

            if (actor.navigation.hasPath()) actor.resume();
            else actor.pause();

            return false;

        }

        if (context.activeInteraction) {

            // The attempted next task may be replaceable, but the interaction
            // physically occupied right now is not. Cancel only the pending
            // departure and let the controller make another decision later.
            this.traffic.cancel(actor);
            this.connector.releaseReservations(actor);
            this.graph.releaseReservations(actor);
            this.graph.clearActiveLaneCurve(actor);
            this.collisionFailsafe.cancel(actor);
            actor.navigation.clearRoute();
            actor.locomotion.resetCurve();

            context.pendingPosition = null;
            context.pendingInteraction = null;
            context.destinationId = null;
            context.deferredCommand = null;
            context.turningAround = false;
            context.traversingLaneCurve = false;
            context.traversingInteractionCurve = false;
            context.retryElapsed = 0;
            context.recoveryElapsed = 0;
            context.collisionWaitElapsed = 0;
            context.recoveryPosition.copy(actor.object3D.position);
            actor.setState(EntityState.IDLE);
            this.refresh();
            return true;

        }

        const rejectedPoint = context.pendingInteraction?.point ?? null;

        actor.navigationAvoidInteractionPoint = rejectedPoint;
        actor.navigationAvoidInteractionPointId = rejectedPoint?.id ?? null;

        this.traffic.cancel(actor);
        this.connector.releaseReservations(actor);
        this.graph.releaseReservations(actor);
        this.graph.clearActiveLaneCurve(actor);
        this.collisionFailsafe.cancel(actor);
        actor.navigation.clearRoute();
        actor.locomotion.resetCurve();

        context.pendingPosition = null;
        context.pendingInteraction = null;
        context.destinationId = null;
        context.deferredCommand = null;
        context.turningAround = false;
        context.traversingLaneCurve = false;
        context.traversingInteractionCurve = false;
        context.retryElapsed = 0;
        context.recoveryElapsed = 0;
        context.collisionWaitElapsed = 0;
        context.recoveryPosition.copy(actor.object3D.position);
        actor.setState(EntityState.IDLE);

        return true;

    }

    recoverOrphanedActor(context, delta) {

        const { actor } = context;
        const hasOwner = Boolean(
            actor.navigation.hasPath() ||
            context.pendingPosition ||
            context.pendingInteraction ||
            context.deferredCommand ||
            context.activeInteraction ||
            this.traffic.isQueued(actor) ||
            context.turningAround ||
            context.preparingInteraction ||
            context.preparingInteractionExit
        );

        if (!actor.isState(EntityState.WAITING) || hasOwner) {

            context.orphanedElapsed = 0;
            return false;

        }

        context.orphanedElapsed += delta;

        if (context.orphanedElapsed < 0.5) return false;

        context.orphanedElapsed = 0;
        actor.setState(EntityState.IDLE);
        console.warn(
            `[NavigationRecovery] ${actor.name} had orphaned WAITING; ` +
            `returning control to its controller.`
        );
        return true;

    }

    deferPersistentIntent(context) {

        const { actor } = context;

        if (actor.navigationIntentPolicy !== "persistent") return;

        // A newer Player command supersedes the old route, but not itself.
        // Remove obsolete geometry/claims, preserve the topological location
        // and leave pendingPosition/pendingInteraction available for retry.
        this.traffic.cancel(actor);
        this.connector.releaseReservations(actor);
        this.graph.releaseReservations(actor);
        this.graph.clearActiveLaneCurve(actor);
        actor.navigation.clearRoute();
        actor.setState(EntityState.WAITING);
        context.traversingLaneCurve = false;
        context.traversingInteractionCurve = false;
        context.retryElapsed = 0;
        this.refresh();

    }

    restartIntentFromNearestAccess(context) {

        const { actor } = context;
        const interactionIntent = context.pendingInteraction
            ? { ...context.pendingInteraction }
            : null;
        const positionIntent = context.pendingPosition?.clone() ?? null;

        if (interactionIntent && this.isActorAtInteractionPoint(
            actor,
            interactionIntent.point
        )) {

            console.log(
                `[NavigationRecovery] ${actor.name} was already at ` +
                `"${interactionIntent.point.id}"; completing arrival locally.`
            );
            return this.completeInteractionAtCurrentPosition(
                context,
                interactionIntent.point,
                interactionIntent.onArrive
            );

        }

        console.log(
            `[NavigationRecovery] ${actor.name} timed out; rebuilding ` +
            `navigation from the nearest graph access.`
        );

        // Abandon every old ownership claim and geometric sample. Only the
        // user/behavior target captured above survives this reset.
        this.graph.releaseAgent(actor);
        this.connector.releaseAgent(actor);
        this.traffic.cancel(actor);
        this.graph.clearActiveLaneCurve(actor);
        actor.navigation.cancel();
        actor.navigation.setCurrentNode(null);

        context.pendingPosition = null;
        context.destinationId = null;
        context.pendingInteraction = null;
        context.interactionPoint = null;
        context.traversingLaneCurve = false;
        context.traversingInteractionCurve = false;
        context.transitTangent = null;
        context.arrivalFromNodeId = null

        const origin = [...this.graph.nodes.values()]
            .filter(node =>
                !node.blocked &&
                [...node.connections.values()].some(connection =>
                    !connection.blocked
                ) &&
                (!node.exclusive ||
                    this.graph.isNodeAvailable(node.id, actor))
            )
            .sort((first, second) =>
                this.graph.getPlanarDistanceSquared(
                    actor.object3D.position,
                    first.position
                ) -
                this.graph.getPlanarDistanceSquared(
                    actor.object3D.position,
                    second.position
                )
            )[0];

        let accepted = false;

        if (origin) {

            actor.navigation.setCurrentNode(origin.id);
            this.graph.occupyNode(origin.id, actor);

            accepted = interactionIntent
                ? this.moveToInteractionPoint(
                    actor,
                    interactionIntent.point,
                    interactionIntent.onArrive,
                    { skipTurnaround: true }
                )
                : positionIntent
                    ? this.moveToClosestNode(actor, positionIntent, {
                        skipTurnaround: true
                    })
                    : false;

        }

        if (accepted) {

            console.log(
                `[NavigationRecovery] ${actor.name} rejoined through ` +
                `"${origin.id}".`
            );
            return true;

        }

        if (actor.navigationIntentPolicy === "persistent") {

            // A failed recovery invalidates only the route. Keep the command
            // queued in the context so the ordinary WAITING retry and future
            // topology/occupancy changes can attempt it again.
            context.pendingPosition = positionIntent;
            context.pendingInteraction = interactionIntent;
            context.destinationId = null;
            context.retryElapsed = 0;
            actor.setState(EntityState.WAITING);
            console.log(
                `[NavigationRecovery] ${actor.name} still intends to reach ` +
                `its target and will retry.`
            );
            return false;

        }

        // An autonomous controller may abandon the task and choose another.
        context.pendingPosition = null;
        context.pendingInteraction = null;
        context.destinationId = null;
        actor.cancel();
        console.log(
            `[NavigationRecovery] ${actor.name} could not recover; ` +
            `the old target was abandoned.`
        );
        return false;

    }

    topologyChanged() {

        this.refresh();

        for (const context of this.contexts.values()) {

            if (context.recoveryPending) {

                this.tryRecoverToNearestNode(context);
                continue;

            }

            if (context.pendingPosition) {

                const replanned = this.moveToClosestNode(
                    context.actor,
                    context.pendingPosition,
                    { replaceIntent: false, skipTurnaround: true }
                );

                if (!replanned) {

                    context.actor.pause();
                    context.blockedElapsed ??= 0;

                }

            }

            if (context.pendingInteraction) {

                const { point, onArrive } = context.pendingInteraction;
                const replanned = this.moveToInteractionPoint(
                    context.actor,
                    point,
                    onArrive,
                    { replaceIntent: false, skipTurnaround: true }
                );

                if (!replanned) {

                    context.actor.pause();
                    context.blockedElapsed ??= 0;

                }

            }

        }

    }

    abandonBlockedIntent(context) {

        if (context.actor.navigationIntentPolicy === "persistent") {

            // A hard block has no known release time. Keep the Player command
            // pending instead of converting a navigation condition into a
            // silent input failure. Topology changes and the retry loop will
            // rebuild the route when it becomes possible again.
            context.blockedElapsed = null;
            context.retryElapsed = 0;
            context.actor.setState(EntityState.WAITING);
            this.graph.releaseReservations(context.actor);
            this.connector.releaseReservations(context.actor);
            console.log(
                `[Navigation] ${context.actor.name} keeps its blocked intent ` +
                `and will retry.`
            );
            return;

        }

        context.pendingPosition = null;
        context.destinationId = null;
        context.pendingInteraction = null;
        context.preparingInteraction = false;
        context.recoveryPending = true;
        this.graph.releaseReservations(context.actor);
        this.connector.releaseReservations(context.actor);
        console.log(
            `[Navigation] ${context.actor.name} abandoned a blocked intent.`
        );
        this.tryRecoverToNearestNode(context);

    }

    tryRecoverToNearestNode(context) {

        const { actor } = context;
        const traversal = actor.navigation.getTraversalState();

        if (traversal.currentNodeId) {

            const current = this.graph.requireNode(traversal.currentNodeId);

            if (!current.blocked) {

                context.recoveryPending = false;
                actor.cancel();
                this.helper?.highlightNode(current.id);
                return true;

            }

            const path = this.graph.findNearestAvailablePath(
                current.id,
                actor
            );

            if (!path) return false;

            const destinationId = path.nodeIds.at(-1);

            context.recoveryPending = false;
            context.destinationId = destinationId;
            this.helper?.highlightNode(destinationId);
            actor.followWaypoints(
                this.createTraversalWaypoints(context, path.nodeIds)
            );

            return true;

        }

        if (!traversal.currentConnection) return false;

        const endpoint = [
            traversal.currentConnection.fromId,
            traversal.currentConnection.toId
        ]
            .map(id => this.graph.requireNode(id))
            .filter(node =>
                !node.blocked && this.graph.isNodeAvailable(node.id, actor)
            )
            .sort((first, second) =>
                this.graph.getPlanarDistanceSquared(
                    actor.object3D.position,
                    first.position
                ) -
                this.graph.getPlanarDistanceSquared(
                    actor.object3D.position,
                    second.position
                )
            )[0];

        if (!endpoint) return false;

        context.recoveryPending = false;
        context.destinationId = endpoint.id;
        this.graph.reserveNode(endpoint.id, actor);
        this.helper?.highlightNode(endpoint.id);
        actor.followWaypoints(
            this.createTraversalWaypoints(context, [endpoint.id])
        );

        return true;

    }

    requireContext(actor) {

        const context = this.contexts.get(actor);

        if (!context) {

            throw new Error(
                `Character "${actor?.name ?? "unknown"}" is not registered in CharacterNavigationSystem.`
            );

        }

        return context;

    }

    isActorAtInteractionPoint(actor, point, tolerance = 0.12) {

        if (!actor?.object3D || !point) return false;

        const target = point.getWorldPosition();
        const deltaX = actor.object3D.position.x - target.x;
        const deltaY = actor.object3D.position.y - target.y;
        const deltaZ = actor.object3D.position.z - target.z;

        return deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ <=
            tolerance * tolerance;

    }

    completeInteractionAtCurrentPosition(context, point, onArrive) {

        const { actor } = context;

        this.traffic.cancel(actor);
        this.graph.releaseReservations(actor);
        this.connector.releaseReservations(actor);
        this.graph.clearActiveLaneCurve(actor);
        actor.navigation.clearRoute();
        actor.locomotion.resetCurve();

        context.pendingPosition = null;
        context.destinationId = null;
        context.pendingInteraction = { point, onArrive };
        context.deferredCommand = null;
        context.traversingLaneCurve = false;
        context.traversingInteractionCurve = false;
        context.recoveryElapsed = 0;
        context.recoveryPosition.copy(actor.object3D.position);

        this.interactions.handleWaypoint(context, {
            id: null,
            position: point.getWorldPosition(),
            interactionPoint: point
        });

        this.refresh();
        return true;

    }

    getOccupiedInteractionPoint(actor) {

        const context =
            this.contexts.get(actor);

        if (!context) {

            return null;

        }

        const point =
            context.activeInteraction?.point;

        if (!point) {

            return null;

        }

        if (
            !point.occupants.has(actor)
        ) {

            return null;

        }

        return point;

    }

    refresh() {

        // Traffic and route changes are dynamic. Rebuilding the whole helper
        // here recreated every canvas label/texture and caused a large frame
        // spike whenever a spline appeared. Topology changes still call the
        // helper's full refresh explicitly from Scene.
        this.helper?.refreshDynamic();
        this.onChanged?.();

    }

    getActorDebugState(actor) {

        const context = this.requireContext(actor);
        const traversal = actor.navigation.getTraversalState();
        const waypoint = actor.navigation.getCurrentWaypoint();
        const nextStructuralWaypoint = actor.navigation
            .getRemainingWaypoints()
            .find(candidate =>
                candidate.id ||
                candidate.interactionPoint ||
                candidate.departureRequest ||
                candidate.connectionEntry
            );
        const traffic = this.traffic.getDebugState(actor);
        const connection = traversal.currentConnection;
        const laneIndex = connection
            ? this.graph.getConnectionLaneIndex(
                connection.fromId,
                connection.toId,
                actor
            )
            : null;
        const interaction = context.pendingInteraction?.point;
        const flags = [
            context.turningAround && "turning",
            context.preparingInteraction && "interaction-entry",
            context.preparingInteractionExit && "interaction-exit",
            context.interactionExitCommitted && "exit-committed",
            context.interactionExitPoint &&
                `exit-point:${context.interactionExitPoint.id}`,
            this.collisionFailsafe.isWaiting(actor) &&
                `collision-wait:${context.collisionWaitElapsed.toFixed(1)}s`,
            waypoint?.routeSpline && "route-spline",
            context.traversingLaneCurve && "lane-curve",
            context.traversingInteractionCurve && "interaction-curve"
        ].filter(Boolean);

        return {
            name: actor.name,
            state: actor.state,
            traversal:
                context.currentTraversal,
            position:
                `${actor.object3D.position.x.toFixed(2)}, ` +
                `${actor.object3D.position.y.toFixed(2)}, ` +
                `${actor.object3D.position.z.toFixed(2)}`,
            location: traversal.currentNodeId ?? (connection
                ? `${connection.fromId} → ${connection.toId}`
                : "off-graph"),
            lane: laneIndex === null ? "—" : `${laneIndex === 0 ? "A" : "B"} (${laneIndex})`,
            next: nextStructuralWaypoint?.id ??
                nextStructuralWaypoint?.interactionPoint?.id ??
                nextStructuralWaypoint?.departureRequest?.originId ??
                (waypoint ? "curve → local target" : "—"),
            progress: waypoint?.routeCurve
                ? `${actor.locomotion.curveDistance.toFixed(2)} / ` +
                    `${waypoint.curveStopDistance?.toFixed(2) ?? "?"}`
                : "—",
            intent: interaction?.id ??
                (context.pendingPosition
                    ? context.destinationId ??
                    `position (${context.pendingPosition.x.toFixed(1)}, ` +
                    `${context.pendingPosition.z.toFixed(1)})`
                    : "—"),
            interaction: context.preparingInteractionExit
                ? `exit animation (${context.interactionExitElapsed.toFixed(2)}s)`
                : context.activeInteraction && context.deferredCommand
                    ? "exit waits for traffic (animation not started)"
                    : context.activeInteraction
                        ? `active: ${context.activeInteraction.point.id}`
                        : "—",
            queue: [
                traffic.departure &&
                    `D:${traffic.departure.originId} ` +
                    `${traffic.departure.position}/${traffic.departure.length} ` +
                    `[${traffic.departure.kind}, r${traffic.departure.rank}]`,
                traffic.arrival &&
                    `A:${traffic.arrival.originId} ` +
                    `${traffic.arrival.position}/${traffic.arrival.length} ` +
                    `[${traffic.arrival.kind}, r${traffic.arrival.rank}]`
            ].filter(Boolean).join(" | ") || "—",
            wait: traffic.waitReason ?? (actor.navigation.isPaused()
                ? "navigation paused"
                : "—"),
            flags: flags.join(", ") || "—"
        };

    }

    debugQueues() {

        return this.traffic.debugQueues();

    }

    dispose() {

    }

}
