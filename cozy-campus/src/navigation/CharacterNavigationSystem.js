import { EntityState } from "../core/EntityState";
import { AnimationPresets } from "../core/AnimationPresets";
import { Tween } from "../core/Tween";
import { NavigationTrafficSystem } from "./NavigationTrafficSystem";
import { InteractionNavigation } from "./InteractionNavigation";
import { CharacterCollisionFailsafe } from "./CharacterCollisionFailsafe";
import { PhysicsWorld } from "../physics/PhysicsWorld";
import { WaitReason } from "./WaitReason";
import { NavigationAgent } from "./NavigationAgent";
import { RoutePlanner } from "./RoutePlanner";
import { RouteGeometryBuilder } from "./RouteGeometryBuilder";
import { InteractionTraversalCoordinator } from "./InteractionTraversalCoordinator";
import { NavigationRecoveryPolicy } from "./NavigationRecoveryPolicy";
import { NavigationTrafficState } from "./NavigationTrafficState";
import { Pathfinder } from "./Pathfinder";
import { RouteGeometryService } from "./RouteGeometryService";
import * as THREE from "three";

// Short triangular circuits look like an NPC pacing nervously around one
// corner. Increase this value if a level needs even broader ambient walks.
const MIN_CLOSED_LOOP_NODES = 4;

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
        this.agents = new Map();
        // Alias temporário para consumidores antigos. Os valores agora são
        // NavigationAgent; não existe mais um segundo "context object".
        this.contexts = this.agents;
        this.trafficState = new NavigationTrafficState(graph);
        this.pathfinder = new Pathfinder(graph, this.trafficState);
        this.routeGeometry = new RouteGeometryService(graph);
        this.connector.pathfinder = this.pathfinder;
        this.connector.routeGeometry = this.routeGeometry;
        this.traffic = new NavigationTrafficSystem(this);
        this.interactions = new InteractionNavigation(this);
        this.collisionFailsafe = new CharacterCollisionFailsafe(this);
        this.physics = new PhysicsWorld(this);
        this.grounding = null;
        this.routePlanner = new RoutePlanner(this);
        this.geometryBuilder = new RouteGeometryBuilder(this);
        this.interactionTraversal =
            new InteractionTraversalCoordinator(this);
        this.recoveryPolicy = new NavigationRecoveryPolicy(this);

    }

    // -----------------------------
    // Actor registration
    // -----------------------------

    registerActor(actor, { spawnId = null } = {}) {

        // Player and NPCs use the same agent. Their only difference is who
        // calls moveToClosestNode() or InteractionSystem.request().
        const context = new NavigationAgent(actor);

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

            this.cancelClosedLoop(context, "navigation-cancelled");
            this.trafficState.releaseReservations(actor);
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

        this.trafficState.releaseAgent(actor);
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
        this.trafficState.occupyNode(nodeId, actor);
        actor.object3D.position.x = node.position.x;
        actor.object3D.position.z = node.position.z;
        this.refresh();

        return true;

    }

    // -----------------------------
    // Commands
    // -----------------------------

    startClosedLoop(actor, nodeIds, {
        laps = 1,
        id = "closed-loop",
        onLap = null,
        onComplete = null,
        onCancelled = null
    } = {}) {

        const context = this.requireContext(actor);
        const traversal = actor.navigation.getTraversalState();
        const cycle = [...nodeIds];

        // Accept both [A, B, C] and the author-friendly [A, B, C, A]. The
        // closing edge is implicit and must not duplicate the first anchor.
        if (cycle.length > 1 && cycle[0] === cycle.at(-1)) cycle.pop();

        const uniqueNodeIds = new Set(cycle);
        const lapCount = THREE.MathUtils.clamp(
            Math.floor(laps),
            1,
            2
        );

        // Three-node triangles are technically valid cycles, but they look
        // like nervous circling rather than an ordinary walk through the
        // environment. Closed-loop activities require at least four distinct
        // circulation nodes; use a regular route for anything shorter.
        if (cycle.length < MIN_CLOSED_LOOP_NODES ||
            uniqueNodeIds.size !== cycle.length) return false;

        for (let index = 0; index < cycle.length; index++) {

            const fromId = cycle[index];
            const toId = cycle[(index + 1) % cycle.length];

            if (!this.graph.hasNode(fromId) ||
                this.graph.isNodeBlocked(fromId) ||
                !this.graph.areConnected(fromId, toId) ||
                this.graph.isConnectionBlocked(fromId, toId)) return false;

        }

        const entry = this.findClosedLoopEntry(context, cycle);

        if (!entry) return false;

        const startIndex = cycle.indexOf(entry.nodeId);
        let orderedCycle = [
            ...cycle.slice(startIndex),
            ...cycle.slice(0, startIndex)
        ];

        if (entry.arrivalFromId &&
            orderedCycle[1] === entry.arrivalFromId) {

            // Do not begin a stroll by immediately reversing over the segment
            // used to reach its entry. Traverse the same closed circuit in the
            // opposite order, so priming continues through the junction while
            // still selecting the right-hand lane for every new direction.
            orderedCycle = [
                orderedCycle[0],
                ...orderedCycle.slice(1).reverse()
            ];

        }

        const startsImmediately = !context.activeInteraction &&
            !traversal.currentConnection &&
            traversal.currentNodeId === entry.nodeId;

        context.closedLoop = {
            id,
            nodeIds: orderedCycle,
            entryNodeId: entry.nodeId,
            phase: startsImmediately ? "looping" : "entering",
            lapsTotal: lapCount,
            lapsRemaining: lapCount,
            lapsCompleted: 0,
            onLap,
            onComplete,
            onCancelled
        };
        context.departureContinuity = null;

        console.log(
            `[ClosedLoop] ${actor.name} chooses "${id}" for ` +
            `${lapCount} lap${lapCount === 1 ? "" : "s"}.`
        );

        if (startsImmediately) {

            this.traffic.cancel(actor);
            this.connector.releaseReservations(actor);
            this.trafficState.releaseReservations(actor);
            this.routeGeometry.clearActiveLaneCurve(actor);
            actor.locomotion.resetCurve();
            context.pendingPosition = null;
            context.pendingInteraction = null;
            context.destinationId = null;
            context.deferredCommand = null;
            return this.startClosedLoopPriming(context);

        }

        console.log(
            `[ClosedLoop] ${actor.name} heads to safe entry ` +
            `"${entry.nodeId}" before starting the circuit.`
        );
        const accepted = this.moveToClosestNode(
            actor,
            this.graph.requireNode(entry.nodeId).position,
            {
                replaceIntent: false,
                preparedCandidate: entry.candidate
            }
        );

        if (accepted) return true;

        this.cancelClosedLoop(context, "entry-unreachable");
        return false;

    }

    // -----------------------------
    // Public facade
    // -----------------------------

    moveTo(actor, destination, options = {}) {

        const position = typeof destination === "string"
            ? this.graph.requireNode(destination).position
            : destination?.position ?? destination;

        return this.moveToClosestNode(actor, position, options);

    }

    moveToInteraction(actor, point, onArrive = null, options = {}) {

        return this.moveToInteractionPoint(
            actor,
            point,
            onArrive,
            options
        );

    }

    cancel(actor) {

        const agent = this.requireContext(actor);

        this.cancelClosedLoop(agent, "facade-cancel");
        this.finishActiveInteraction(agent);

        agent.intent.position = null;
        agent.intent.destinationId = null;
        agent.intent.interaction = null;
        agent.intent.deferredCommand = null;
        agent.route.departureContinuity = null;
        agent.traversal.interactionPoint = null;
        agent.traversal.interactionExitPoint = null;
        agent.traversal.laneCurve = false;
        agent.traversal.interactionCurve = false;
        agent.interaction.entering = false;
        agent.interaction.leaving = false;
        agent.interaction.exitCommitted = false;
        agent.wait.retryElapsed = 0;
        agent.wait.blockedElapsed = null;
        agent.recovery.pending = false;
        agent.turnaround.active = false;

        actor.cancel();
        agent.syncPhase();
        return true;

    }

    startClosedLoopPriming(context) {

        const loop = context.closedLoop;

        if (!loop ||
            loop.nodeIds.length < MIN_CLOSED_LOOP_NODES) return false;

        const fromId = loop.nodeIds[0];
        const toId = loop.nodeIds[1];
        const actor = context.actor;
        const connection = this.graph.requireConnection(fromId, toId);
        const laneIndex = connection.fromId === fromId ? 0 : 1;
        const laneEnd = this.routeGeometry.getConnectionLaneNodePosition(
            toId,
            fromId,
            toId,
            laneIndex
        );
        loop.phase = "priming";
        loop.primingTargetId = toId;

        // The priming edge establishes a point that belongs to the circuit's
        // own right-hand lane. Without it, the first segment could inherit the
        // opposite lane used by the unrelated route that reached its entry.
        actor.followWaypoints([{
            id: toId,
            position: laneEnd,
            // A closed walk requires the right-hand lane, but TrafficSystem
            // still performs the actual reservation before geometry exists.
            preferredLaneIndex: laneIndex,
            closedLoopPrimingEnd: true
        }]);
        this.refresh();
        return true;

    }

    findClosedLoopEntry(context, nodeIds) {

        const traversal = context.actor.navigation.getTraversalState();
        const allowedNodeIds = nodeIds.filter(nodeId =>
            !this.isNodeAttachedToActionPoint(nodeId)
        );

        if (allowedNodeIds.length === 0) return null;

        if (!context.activeInteraction &&
            !traversal.currentConnection &&
            allowedNodeIds.includes(traversal.currentNodeId)) {

            return {
                nodeId: traversal.currentNodeId,
                candidate: null,
                cost: 0,
                arrivalFromId: context.arrivalFromNodeId
            };

        }

        return allowedNodeIds
            .map(nodeId => {

                const candidate = this.findBestPlan(
                    context,
                    this.graph.requireNode(nodeId).position,
                    6
                );

                if (!candidate ||
                    candidate.plan.destinationId !== nodeId) return null;

                return {
                    nodeId,
                    candidate,
                    cost: candidate.accessCost + candidate.plan.cost,
                    arrivalFromId: candidate.plan.nodeIds.at(-2) ?? null
                };

            })
            .filter(Boolean)
            .sort((first, second) => first.cost - second.cost)[0] ?? null;

    }

    isNodeAttachedToActionPoint(nodeId) {

        for (const point of this.connector.points.values()) {

            if (point.metadata.role !== "action") continue;

            const accessPoint = point.via ?? point;
            const access = this.connector.connect(accessPoint, {
                silent: true
            });

            // Projected approaches belong to an edge and are valid parts of a
            // circuit. Only a direct node ActionPoint is a bad loop entrance:
            // beginning there visually mixes an idle/action pose with travel.
            if (access?.nodeIds?.length === 1 &&
                access.nodeIds[0] === nodeId) return true;

        }

        return false;

    }

    startClosedLoopLap(context) {

        const loop = context.closedLoop;

        if (!loop) return false;

        loop.phase = "looping";

        const waypoints = this.createClosedLoopRouteWaypoints(
            context,
            loop.nodeIds
        );

        if (waypoints.length === 0) {

            this.cancelClosedLoop(context, "invalidated");
            return false;

        }

        context.actor.followWaypoints(waypoints);
        this.refresh();
        return true;

    }

    cancelClosedLoop(context, reason = "cancelled") {

        const loop = context?.closedLoop;

        if (!loop) return false;

        context.closedLoop = null;
        loop.onCancelled?.({
            actor: context.actor,
            id: loop.id,
            lapsCompleted: loop.lapsCompleted,
            reason
        });
        return true;

    }


    // Não usar moveToClosestNode() como comando de gameplay.
    moveToClosestNode(actor, position, {
        replaceIntent = true,
        skipTurnaround = false,
        skipInteractionExit = false,
        maxDetourFactor = 3,
        preparedCandidate = null
    } = {}) {

        const context = this.requireContext(actor);

        if (replaceIntent && context.closedLoop) {

            this.cancelClosedLoop(context, "replaced-by-command");

        }

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
            context.departureContinuity = null;
            actor.cancel();
            return true;

        }

        actor.followWaypoints(this.prepareRouteWaypoints(
            context,
            waypoints
        ), {
            waitAtEnd: candidate.plan.status === "waiting"
        });
        context.departureContinuity = null;

        return true;

    }

    moveToInteractionPoint(actor, point, onArrive = null, {
        replaceIntent = true,
        skipTurnaround = false,
        skipInteractionExit = false,
        preparedRouteCandidate = null
    } = {}) {

        const context = this.requireContext(actor);

        if (replaceIntent && context.closedLoop) {

            this.cancelClosedLoop(context, "replaced-by-interaction");

        }

        // Requesting the InteractionPoint that is already active is a
        // completed command, not a route with identical origin/destination.
        // This also protects autonomous behavior from re-enqueuing its current
        // ambient action while the controller is between decisions.
        if (context.activeInteraction?.point === point) return true;

        // Traffic/collision recovery can remove topology ownership while the
        // physical body has already reached its authored mark. Finish that
        // arrival locally instead of inventing a graph origin and producing a
        // curve that walks back to its beginning before returning here.
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
                ...this.applyTopologyToGraphPrefix(
                    context,
                    remainingRouteWaypoints,
                    exitWaypoints
                )
            ];
            actor.followWaypoints(this.prepareRouteWaypoints(
                context,
                completeWaypoints
            ));
            context.departureContinuity = null;
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
            actor.followWaypoints(this.prepareRouteWaypoints(
                context,
                directRoute.waypoints
            ));
            context.departureContinuity = null;
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
            ...this.applyTopologyToGraphPrefix(
                context,
                routeWaypoints,
                exitWaypoints
            )
        ];
        actor.followWaypoints(this.prepareRouteWaypoints(
            context,
            completeWaypoints
        ));
        context.departureContinuity = null;

        return true;

    }

    findInteractionRouteCandidate(...args) {

        return this.routePlanner.findInteractionRouteCandidate(...args);

    }

    evaluateInteraction(actor, point) {

        const context = this.requireContext(actor);
        const candidate = this.findInteractionRouteCandidate(
            context,
            point,
            { ignorePointAvailability: true }
        );

        if (!candidate) return { reachable: false };

        const nodeIds = this.getGraphWaypointIds(candidate.route.waypoints);
        const loads = [];
        const pointUsers = new Set([
            ...point.occupants,
            ...point.reservations
        ]);

        pointUsers.delete(actor);
        loads.push(Math.min(1, pointUsers.size / Math.max(1, point.capacity)));

        for (const nodeId of nodeIds) {

            const state = this.trafficState.getNodeState(nodeId);
            const users = new Set([
                ...state.occupants,
                ...state.reservations,
                ...state.transitReservations
            ]);

            users.delete(actor);
            loads.push(Math.min(1, users.size));

        }

        for (let index = 0; index < nodeIds.length - 1; index++) {

            const state = this.trafficState.getConnectionState(
                nodeIds[index],
                nodeIds[index + 1]
            );
            const busyLanes = state.lanes.filter(lane => {
                const users = new Set([
                    ...lane.occupants,
                    ...lane.reservations
                ]);
                users.delete(actor);
                return users.size > 0;
            }).length;

            loads.push(busyLanes / state.lanes.length);

        }

        const access = this.connector.connect(point.via ?? point, {
            silent: true
        });
        const queueLength = (access?.nodeIds ?? []).reduce(
            (maximum, nodeId) => Math.max(
                maximum,
                this.traffic.departures.queues.get(nodeId)?.length ?? 0,
                this.traffic.arrivals.queues.get(nodeId)?.length ?? 0
            ),
            0
        );

        return {
            reachable: true,
            pathCost: candidate.route.cost,
            congestion: loads.length > 0
                ? loads.reduce((sum, load) => sum + load, 0) / loads.length
                : 0,
            waitPenalty: Math.min(1, queueLength / 3),
            originId: candidate.origin.id,
            nodeIds
        };

    }

    // -----------------------------
    // Planning
    // -----------------------------

    getAvoidFirstStepTo(context, originId) {

        const continuity = context.departureContinuity;

        return continuity?.nodeId === originId
            ? continuity.previousNodeId
            : null;

    }

    getGraphWaypointIds(waypoints) {

        const nodeIds = [];

        for (const waypoint of waypoints) {

            if (!waypoint.id) break;
            nodeIds.push(waypoint.id);

        }

        return nodeIds;

    }

    resolveInteractionExitTraversal(...args) {

        return this.routePlanner.resolveInteractionExitTraversal(...args);

    }

    findInteractionPreflight(...args) {

        return this.routePlanner.findInteractionPreflight(...args);

    }

    findBestPlan(...args) {

        return this.routePlanner.findBestPlan(...args);

    }

    getOrigins(...args) {

        return this.routePlanner.getOrigins(...args);

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

            this.trafficState.releaseReservations(
                actor
            );

            this.trafficState.reserveNode(
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

            this.trafficState.releaseReservations(
                actor
            );

        }

        actor.navigation.setCurrentNode(
            null
        );

        this.refresh();

    }

    createTraversalWaypoints(...args) {

        return this.geometryBuilder.createTraversalWaypoints(...args);

    }


    createClosedLoopRouteWaypoints(context, nodeIds) {

        return nodeIds.map((fromId, index) => {

            const toId = nodeIds[(index + 1) % nodeIds.length];
            const connection = this.graph.requireConnection(fromId, toId);
            const preferredLaneIndex = connection.fromId === fromId ? 0 : 1;

            return {
                id: toId,
                // Traffic replaces this center with the endpoint of the lane
                // it actually reserves immediately before traversal.
                position: this.graph.requireNode(toId).position.clone(),
                preferredLaneIndex,
                closedLoopLapEnd: index === nodeIds.length - 1
            };

        });

    }

    preserveTopologicalWaypoints(...args) {

        return this.geometryBuilder.preserveTopologicalWaypoints(...args);

    }

    appendPostLoopUTurnAnchors(pushAnchor, start, end, incomingDirection) {

        const direction = incomingDirection.clone().setY(0);

        if (direction.lengthSq() <= 0.0001 ||
            start.distanceToSquared(end) <= 0.0001) return;

        direction.normalize();
        const laneSeparation = Math.sqrt(start.distanceToSquared(end));
        const radius = THREE.MathUtils.clamp(
            laneSeparation * 1.25,
            0.75,
            1.5
        );
        const firstControl = start.clone().addScaledVector(direction, radius);
        const secondControl = end.clone().addScaledVector(direction, radius);
        const sampleCount = 6;

        // This cubic leaves the old lane in its current direction and arrives
        // at the reverse lane already facing back. It is only used when the
        // graph truly offers no forward route; ordinary post-loop decisions
        // never cross to the opposite portal at the finishing node.
        for (let index = 1; index < sampleCount; index++) {

            const t = index / sampleCount;
            const inverse = 1 - t;
            const position = start.clone()
                .multiplyScalar(inverse ** 3)
                .add(firstControl.clone().multiplyScalar(
                    3 * inverse ** 2 * t
                ))
                .add(secondControl.clone().multiplyScalar(
                    3 * inverse * t ** 2
                ))
                .add(end.clone().multiplyScalar(t ** 3));

            pushAnchor(position);

        }

    }

    applyTopologyToGraphPrefix(...args) {

        return this.geometryBuilder.applyTopologyToGraphPrefix(...args);

    }

    prepareRouteWaypoints(...args) {

        return this.geometryBuilder.prepareRouteWaypoints(...args);

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

        if (!this.trafficState.isNodeAvailable(waypoint.id, actor)) {
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
            this.routeGeometry.clearActiveLaneCurve(actor);
            context.arrivalFromNodeId = completedConnection.fromId;
            context.currentTraversal = "flat";
            actor.traversalType = "flat";

            this.trafficState.releaseConnection(
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

        if (!this.trafficState.occupyNode(waypoint.id, actor)) {

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

        if (context.closedLoop?.phase === "entering" &&
            waypoint.id === context.closedLoop.entryNodeId) {

            // Entry is only a staging destination. Do not release it, warn
            // about a terminal navigation node or let NPCController make a
            // decision between arrival and the first loop connection.
            context.pendingPosition = null;
            context.destinationId = null;
            context.retryElapsed = 0;
            this.startClosedLoopPriming(context);
            this.refresh();
            return;

        }

        if (waypoint.closedLoopPrimingEnd &&
            context.closedLoop?.phase === "priming") {

            const loop = context.closedLoop;

            // Begin the periodic curve at the endpoint just reached. Rotating
            // the authored cycle preserves its direction while making the
            // priming edge the final edge of every complete lap.
            loop.nodeIds = [
                ...loop.nodeIds.slice(1),
                loop.nodeIds[0]
            ];
            loop.entryNodeId = waypoint.id;
            loop.primingTargetId = null;
            this.startClosedLoopLap(context);
            this.refresh();
            return;

        }

        if (waypoint.closedLoopLapEnd && context.closedLoop) {

            this.completeClosedLoopLap(context, waypoint);
            this.refresh();
            return;

        }

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

            this.trafficState.releaseNode(
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

    completeClosedLoopLap(context, waypoint) {

        const { actor } = context;
        const loop = context.closedLoop;
        const nodeId = waypoint.id;

        if (!loop) return false;

        loop.lapsCompleted++;
        loop.lapsRemaining--;
        loop.onLap?.({
            actor,
            id: loop.id,
            completed: loop.lapsCompleted,
            total: loop.lapsTotal
        });

        if (loop.lapsRemaining > 0) {

            console.log(
                `[ClosedLoop] ${actor.name} completed ` +
                `${loop.lapsCompleted}/${loop.lapsTotal} on "${loop.id}".`
            );
            return this.startClosedLoopLap(context);

        }

        context.closedLoop = null;
        this.routeGeometry.clearActiveLaneCurve(actor);

        const previousNodeId = context.arrivalFromNodeId;
        let direction = waypoint.routeCurve
            ?.getTangent(1, new THREE.Vector3())
            .setY(0) ?? new THREE.Vector3();

        if (direction.lengthSq() <= 0.0001 && previousNodeId) {

            direction = this.graph.requireNode(nodeId).position.clone()
                .sub(this.graph.requireNode(previousNodeId).position)
                .setY(0);

        }

        context.departureContinuity = previousNodeId &&
            direction.lengthSq() > 0.0001
            ? {
                nodeId,
                previousNodeId,
                direction: direction.normalize()
            }
            : null;

        // The circuit ends at the same logical and physical origin. Release
        // its transit occupancy just like another completed autonomous task;
        // the controller may now choose a fresh interaction or route.
        this.trafficState.releaseNode(nodeId, actor);
        actor.navigation.setCurrentNode(nodeId);
        actor.setState(EntityState.IDLE);

        console.log(
            `[ClosedLoop] ${actor.name} leaves "${loop.id}" after ` +
            `${loop.lapsCompleted} lap${loop.lapsCompleted === 1 ? "" : "s"}.`
        );
        loop.onComplete?.({
            actor,
            id: loop.id,
            lapsCompleted: loop.lapsCompleted
        });

        return true;

    }

    setGrounding(grounding) {

        this.grounding = grounding;

    }

    projectWaypointsToGround(...args) {

        return this.geometryBuilder.projectWaypointsToGround(...args);

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
            this.trafficState.setNodeAgentResting(
                currentNodeId,
                actor,
                false
            );

        }

        // object3D already occupies the resting spot in world space. Once the
        // route is authorized, Locomotion moves directly from there to the next
        // graph node and owns all turning; no visual recentering is necessary.
        actor.cancelTweens(actor.object3D.position, ["x", "z"]);
        return true;

    }

    leaveInteractionPoint(...args) {

        return this.interactionTraversal.leaveInteractionPoint(...args);

    }

    releaseInteractionExitPoint(...args) {

        return this.interactionTraversal.releaseInteractionExitPoint(...args);

    }

    completeInteractionExit(...args) {

        return this.interactionTraversal.completeInteractionExit(...args);

    }

    finishActiveInteraction(...args) {

        return this.interactionTraversal.finishActiveInteraction(...args);

    }

    beginInteractionExit(...args) {

        return this.interactionTraversal.beginInteractionExit(...args);

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

        // Compatibility orchestrator for isolated simulations and tests.
        // Scene calls every phase explicitly so the production frame order is
        // visible in one place instead of being hidden inside this method.
        this.updatePlanning(delta);
        this.updateTraffic(delta);

        const actors = [...this.contexts.keys()]
            .filter(actor => actor.isActive());

        for (const actor of actors) actor.authorizeMovementTraffic();
        for (const actor of actors) actor.prepareMovement();
        for (const actor of actors) actor.evaluateMovementGuard(delta);
        for (const actor of actors) actor.updateMovement(delta);

        this.solvePhysics(delta);

        for (const actor of actors) actor.updateGrounding();
        for (const actor of actors) actor.updateAnimation(delta);

    }

    updatePlanning(delta) {

        for (const context of this.contexts.values()) {

            const { actor } = context;
            context.syncPhase(this.traffic.getWaitReason(actor));

            // Debug-only timer: this separates a pause owned by a visual exit
            // animation from a pause caused by traffic after it has finished.
            if (context.preparingInteractionExit) {

                context.interactionExitElapsed += delta;

            }

            if (this.monitorNavigationProgress(context, delta)) continue;
            if (this.recoverOrphanedActor(context, delta)) continue;

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

    }

    updateTraffic(delta) {

        // Queue timers and timeouts are resolved before movement authorization
        // for this same frame. No CharacterCollisionFailsafe decision is made
        // from last frame's traffic snapshot anymore.
        this.traffic.update(delta);

        for (const { actor } of this.contexts.values()) {

            this.traffic.prequeueUpcomingTransit(actor);

        }

        // Callbacks executed above may have completed an interaction, started
        // recovery or resumed traversal. Publish the final phase of this frame.
        for (const context of this.contexts.values()) {

            context.syncPhase(
                this.traffic.getWaitReason(context.actor)
            );

        }

    }

    solvePhysics(delta) {

        // Cannon owns only residual body separation. manualContactSeparation
        // remains false; navigation and the predictive brake are authoritative
        // before bodies reach this phase.
        this.physics.solve(delta);

    }

    monitorNavigationProgress(...args) {

        return this.recoveryPolicy.monitorNavigationProgress(...args);

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

    resolveTrafficWaitTimeout(...args) {

        return this.recoveryPolicy.resolveTrafficWaitTimeout(...args);

    }

    abandonReplaceableRoute(...args) {

        return this.recoveryPolicy.abandonReplaceableRoute(...args);

    }

    recoverOrphanedActor(...args) {

        return this.recoveryPolicy.recoverOrphanedActor(...args);

    }

    deferPersistentIntent(...args) {

        return this.recoveryPolicy.deferPersistentIntent(...args);

    }

    restartIntentFromNearestAccess(...args) {

        return this.recoveryPolicy.restartIntentFromNearestAccess(...args);

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

    abandonBlockedIntent(...args) {

        return this.recoveryPolicy.abandonBlockedIntent(...args);

    }

    tryRecoverToNearestNode(...args) {

        return this.recoveryPolicy.tryRecoverToNearestNode(...args);

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

    completeInteractionAtCurrentPosition(...args) {

        return this.interactionTraversal.completeInteractionAtCurrentPosition(...args);

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
        context.syncPhase(this.traffic.getWaitReason(actor));
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
            ? this.trafficState.getConnectionLaneIndex(
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
            context.closedLoop?.phase === "entering"
                ? `closed-loop-entry:${context.closedLoop.entryNodeId}`
                : context.closedLoop &&
                    `closed-loop:${context.closedLoop.lapsCompleted}/` +
                    `${context.closedLoop.lapsTotal}`,
            this.collisionFailsafe.isWaiting(actor) &&
                `collision-wait:${context.collisionWaitElapsed.toFixed(1)}s`,
            waypoint?.routeGeometry && "route-segments",
            context.traversingLaneCurve && "lane-curve",
            context.traversingInteractionCurve && "interaction-curve"
        ].filter(Boolean);

        return {
            name: actor.name,
            state: actor.state,
            phase: context.phase,
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
                (context.closedLoop
                    ? `${context.closedLoop.id} ` +
                        (context.closedLoop.phase === "entering"
                            ? `→ ${context.closedLoop.entryNodeId} `
                            : "") +
                        `(${context.closedLoop.lapsCompleted}/` +
                        `${context.closedLoop.lapsTotal})`
                    : null) ??
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
