import { EntityState } from "../core/EntityState";
import { NavigationTrafficSystem } from "./NavigationTrafficSystem";
import { InteractionNavigation } from "./InteractionNavigation";
import { CharacterCollisionFailsafe } from "./CharacterCollisionFailsafe";
import { CharacterCollisionSolver } from "./CharacterCollisionSolver";
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
import { NavigationMetrics } from "./NavigationMetrics";
import { InteractionTrafficState } from "./InteractionTrafficState";
import { TurnaroundCoordinator } from "./TurnaroundCoordinator";
import { ClosedLoopCoordinator } from "./ClosedLoopCoordinator";
import { WaypointTraversalCoordinator } from "./WaypointTraversalCoordinator";
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
        this.agents = new Map();
        this.priorityPassageRequests = new WeakMap();
        this.staleNodeEvacuations = new Map();
        this.navigationTime = 0;
        this.metrics = new NavigationMetrics();
        this.trafficState = new NavigationTrafficState(graph);
        this.interactionTraffic = new InteractionTrafficState(connector, this);
        this.connector.traffic = this.interactionTraffic;
        this.pathfinder = new Pathfinder(
            graph,
            this.trafficState,
            this.metrics
        );
        this.routeGeometry = new RouteGeometryService(graph);
        this.connector.pathfinder = this.pathfinder;
        this.connector.routeGeometry = this.routeGeometry;
        this.traffic = new NavigationTrafficSystem(this);
        this.interactions = new InteractionNavigation(this);
        this.collisionFailsafe = new CharacterCollisionFailsafe(this);
        this.collisionSolver = new CharacterCollisionSolver(this);
        this.physics = new PhysicsWorld(this);
        this.grounding = null;
        this.routePlanner = new RoutePlanner(this);
        this.geometryBuilder = new RouteGeometryBuilder(this);
        this.interactionTraversal =
            new InteractionTraversalCoordinator(this);
        this.recoveryPolicy = new NavigationRecoveryPolicy(this);
        this.turnaround = new TurnaroundCoordinator(this);
        this.closedLoops = new ClosedLoopCoordinator(this);
        this.waypointTraversal = new WaypointTraversalCoordinator(this);

    }

    // -----------------------------
    // Actor registration
    // -----------------------------

    registerActor(actor, { spawnId = null } = {}) {

        // Player and NPCs use the same agent. Their only difference is who
        // calls moveToClosestNode() or InteractionSystem.request().
        const context = new NavigationAgent(actor);

        this.agents.set(actor, context);

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

            const reserved = this.interactionTraffic.reservePoint(point, actor);

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
                this.interactionTraffic.releaseReservations(actor);
            this.traffic.cancel(actor);
            this.collisionFailsafe.cancel(actor);
            this.routeGeometry.clearPlannedLaneCurve(actor);
            context.route.previewSignature = null;
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

        const context = this.agents.get(actor);
        if (!context) return;

        this.trafficState.releaseAgent(actor);
        this.finishActiveInteraction(context);
        this.interactionTraffic.releaseAgent(actor);
        this.traffic.unregister(actor);
        this.collisionFailsafe.unregister(actor);
        this.collisionSolver.unregister(actor);
        this.physics.unregisterActor(actor);
        this.routeGeometry.clearPlannedLaneCurve(actor);
        actor.setMovementGuard(null);
        actor.setWaypointArrivalGuard(null);
        this.agents.delete(actor);
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

    startClosedLoop(actor, nodeIds, options = {}) {

        return this.closedLoops.start(actor, nodeIds, options);

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

    leaveInteraction(actor) {

        const context = this.requireContext(actor);
        const interactionPoint = context.interaction.active?.point;

        if (!interactionPoint) return false;

        const accessPoint = interactionPoint.via ?? interactionPoint;
        const connection = accessPoint.connection ??
            this.connector.connect(accessPoint);

        if (!connection) return false;

        // Leaving an activity is a valid autonomous command by itself. An NPC
        // must not occupy the point forever merely because no next activity
        // could be reserved in the same decision tick.
        const candidates = connection.nodeIds
            .map(nodeId => {
                const node = this.graph.getNode(nodeId);
                if (!node || this.graph.isNodeBlocked(nodeId)) return null;

                const plan = this.findBestPlan(context, node.position, 3);
                return plan ? { node, plan } : null;
            })
            .filter(Boolean)
            .sort((first, second) =>
                first.plan.plan.cost - second.plan.plan.cost
            );

        const selected = candidates[0];
        if (!selected) return false;

        return this.moveToClosestNode(actor, selected.node.position, {
            preparedCandidate: selected.plan
        });

    }

    requestPriorityPassage(priorityActor, blockers, detail = {}) {

        if (priorityActor.navigationPassagePolicy !== "absolute") return false;

        let requested = false;

        for (const blocker of new Set(blockers)) {

            if (!blocker || blocker === priorityActor ||
                blocker.navigationPassagePolicy === "absolute") continue;

            const context = this.agents.get(blocker);
            if (!context) continue;

            const requestKey = [
                detail.resourceType,
                detail.nodeId,
                detail.point?.id,
                detail.fromId,
                detail.toId
            ].filter(Boolean).join(":");
            const previousRequest = this.priorityPassageRequests.get(blocker);
            const sameRequest = previousRequest?.by === priorityActor &&
                previousRequest.key === requestKey;

            if (!sameRequest) {
                this.priorityPassageRequests.set(blocker, {
                    by: priorityActor,
                    key: requestKey,
                    attemptedAt: this.navigationTime
                });
                blocker.onPriorityPassageRequested?.({
                    by: priorityActor,
                    ...detail
                });
            }
            requested = true;

            // A failed evacuation remains retryable, but route planning is
            // never a per-frame operation. This was especially expensive
            // while Player retained the lane that the blocker wanted to use.
            if (sameRequest &&
                this.navigationTime - previousRequest.attemptedAt < 0.75) {
                continue;
            }

            if (sameRequest) previousRequest.attemptedAt = this.navigationTime;

            // Leaving an InteractionPoint is transactional: its occupation is
            // retained through the exit animation, then released. The Player
            // waits for the physical exit but never loses its own intention.
            if (context.interaction.active) {
                if (!context.interaction.leaving &&
                    !context.interaction.exitCommitted) {
                    this.leaveInteraction(blocker);
                }
                continue;
            }

            // An idle ambient actor standing on a traffic node has no route
            // that would naturally clear it. Give it a real neighboring node
            // to evacuate toward; moving actors keep their current route and
            // the collision negotiator gives the Player right-of-way.
            const currentNodeId = blocker.navigation
                .getTraversalState().currentNodeId;

            if (!currentNodeId || blocker.navigation.hasPath()) continue;

            const origin = this.graph.getNode(currentNodeId);
            const candidates = [...origin.connections.entries()]
                .filter(([nodeId, connection]) =>
                    !connection.blocked &&
                    !this.graph.isNodeBlocked(nodeId)
                )
                .sort(([firstId], [secondId]) =>
                    Number(this.trafficState.isNodeAvailable(secondId, blocker)) -
                    Number(this.trafficState.isNodeAvailable(firstId, blocker))
                );
            const destination = candidates[0]
                ? this.graph.getNode(candidates[0][0])
                : null;

            if (destination) {
                this.moveToClosestNode(blocker, destination.position, {
                    replaceIntent: true,
                    maxDetourFactor: 2
                });
            }

        }

        return requested;

    }

    evacuateStaleNode(nodeId) {

        const node = this.graph.getNode(nodeId);
        if (!node || node.blocked) return false;

        const previous = this.staleNodeEvacuations.get(nodeId) ?? -Infinity;
        if (this.navigationTime - previous < 2) return true;

        const state = this.trafficState.getNodeState(nodeId);
        const actors = new Set([
            ...state.occupants,
            ...state.reservations,
            ...state.transitReservations,
            ...this.traffic.departures.getActors(nodeId),
            ...this.traffic.arrivals.getActors(nodeId)
        ]);

        for (const encounter of state.collisionBlocks) {
            actors.add(encounter.winner);
            actors.add(encounter.yielder);
        }

        const evacuationRadius = (node.metadata.laneRadius ?? 1.75) + 1.5;
        const activeActors = [...actors].filter(actor => {
            if (!actor?.isActive?.() || !this.agents.has(actor)) return false;
            const traversal = actor.navigation.getTraversalState();
            return traversal.currentNodeId === nodeId ||
                Math.hypot(
                    actor.object3D.position.x - node.position.x,
                    actor.object3D.position.z - node.position.z
                ) <= evacuationRadius;
        });
        if (activeActors.length < 2 && state.collisionBlocks.size === 0) {
            return false;
        }

        const exits = [...node.connections.entries()]
            .filter(([neighborId, connection]) =>
                !connection.blocked &&
                !this.graph.isNodeBlocked(neighborId)
            )
            .map(([neighborId]) => this.graph.requireNode(neighborId));
        if (exits.length === 0) return false;

        this.staleNodeEvacuations.set(nodeId, this.navigationTime);
        console.warn(
            `[NavigationRecovery] Stale node "${nodeId}" releases ` +
            `${activeActors.length} actor(s); all current routes are ` +
            `replaced by local exits.`
        );

        for (const actor of activeActors) {

            const context = this.requireContext(actor);

            // Interaction points are external to nodes. Never tear down a
            // transactional enter/exit merely because its access node stalled.
            if (context.interaction.entering || context.interaction.leaving ||
                context.interaction.exitCommitted) continue;

            this.cancelClosedLoop(context, "stale-node-evacuation");
            this.traffic.cancel(actor);
            this.interactionTraffic.releaseReservations(actor);
            this.trafficState.releaseAgent(actor);
            this.routeGeometry.clearActiveLaneCurve(actor);
            this.collisionFailsafe.cancel(actor);
            actor.navigation.cancel();
            actor.navigation.setCurrentNode(nodeId);
            actor.locomotion.resetCurve();
            this.trafficState.occupyNode(nodeId, actor, { crossing: true });

            context.intent.position = null;
            context.intent.destinationId = null;
            context.intent.interaction = null;
            context.intent.deferredCommand = null;
            context.traversal.laneCurve = false;
            context.traversal.interactionCurve = false;
            context.traversal.transitTangent = null;
            context.wait.retryElapsed = 0;
            context.wait.collisionElapsed = 0;
            context.recovery.elapsed = 0;

        }

        const evacuees = activeActors.filter(actor => {
            const context = this.requireContext(actor);
            return !context.interaction.entering &&
                !context.interaction.leaving &&
                !context.interaction.exitCommitted;
        });

        evacuees.forEach((actor, index) => {
            const destination = exits[index % exits.length];
            this.moveToClosestNode(actor, destination.position, {
                replaceIntent: true,
                skipTurnaround: true,
                maxDetourFactor: 1.5
            });
        });

        this.refresh();
        return true;

    }

    cancel(actor) {

        const agent = this.requireContext(actor);
        this.metrics.increment("cancellations");

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
        this.routeGeometry.clearPlannedLaneCurve(actor);
        agent.route.previewSignature = null;
        agent.syncPhase();
        return true;

    }

    startClosedLoopPriming(context) {

        return this.closedLoops.startPriming(context);

    }

    findClosedLoopEntry(context, nodeIds) {

        return this.closedLoops.findEntry(context, nodeIds);

    }

    isNodeAttachedToActionPoint(nodeId) {

        return this.closedLoops.isNodeAttachedToActionPoint(nodeId);

    }

    startClosedLoopLap(context) {

        return this.closedLoops.startLap(context);

    }

    cancelClosedLoop(context, reason = "cancelled") {

        return this.closedLoops.cancel(context, reason);

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

        if (replaceIntent && context.intent.closedLoop) {

            this.cancelClosedLoop(context, "replaced-by-command");

        }

        // Store the command before planning. Traffic, a temporary occupation
        // or even the absence of a route may reject this attempt, but they do
        // not mean that the actor stopped wanting to reach this position.
        if (actor.navigationIntentPolicy === "persistent") {

            context.intent.position = position.clone();
            context.intent.interaction = null;
            context.intent.destinationId = null;
            context.wait.retryElapsed = 0;

        }

        if (context.interaction.entering) {

            // Do not interrupt an authored entry animation. The newest
            // command starts after the current action has actually arrived.
            context.intent.deferredCommand = {
                type: "node",
                position: position.clone()
            };
            return true;

        }

        if (context.turnaround.active) {

            context.intent.deferredCommand = {
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

        if (!skipInteractionExit && context.interaction.active) {

            this.beginInteractionExit(context, {
                type: "node",
                position: position.clone(),
                originId: routeOriginId,
                nextNodeId,
                preparedCandidate: candidate,
                intentPrepared: true
            });
            return true;

        }
        if (!skipTurnaround && this.shouldTurnAround(actor, position)) {

            if (replaceIntent) {

                this.traffic.cancel(actor);
                this.interactionTraffic.releaseReservations(actor);

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

        context.intent.position = position.clone();
        context.intent.interaction = null;
        context.intent.destinationId = candidate.plan.destinationId;
        context.wait.retryElapsed = 0;
        context.wait.blockedElapsed = null;
        context.recovery.pending = false;
        this.prepareOrigin(context, routeOriginId, {
            preserveTrafficReservations: preparedCandidate !== null
        });

        const exitWaypoints = this.connector.createExitWaypoints(
            context.traversal.interactionPoint,
            routeOriginId,
            { nextNodeId }
        );
        const graphWaypoints = this.createTraversalWaypoints(
            context,
            routeNodeIds
        );
        const waypoints = [
            ...exitWaypoints,
            ...this.applyTopologyToGraphPrefix(
                context,
                graphWaypoints,
                exitWaypoints
            )
        ];
        const traversal = actor.navigation.getTraversalState();
        const alreadyThere =
            traversal.currentNodeId === candidate.plan.destinationId &&
            candidate.plan.nodeIds.length === 1 &&
            !context.traversal.interactionPoint;

        this.helper?.highlightNode(candidate.plan.destinationId);

        if (alreadyThere) {

            context.intent.position = null;
            context.intent.destinationId = null;
            context.route.departureContinuity = null;
            actor.cancel();
            return true;

        }

        actor.followWaypoints(this.prepareRouteWaypoints(
            context,
            waypoints
        ), {
            waitAtEnd: candidate.plan.status === "waiting"
        });
        context.route.departureContinuity = null;

        return true;

    }

    moveToInteractionPoint(actor, point, onArrive = null, {
        replaceIntent = true,
        skipTurnaround = false,
        skipInteractionExit = false,
        preparedRouteCandidate = null
    } = {}) {

        const context = this.requireContext(actor);

        if (replaceIntent && context.intent.closedLoop) {

            this.cancelClosedLoop(context, "replaced-by-interaction");

        }

        // Requesting the InteractionPoint that is already active is a
        // completed command, not a route with identical origin/destination.
        // This also protects autonomous behavior from re-enqueuing its current
        // ambient action while the controller is between decisions.
        if (context.interaction.active?.point === point) return true;

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

            context.intent.position = null;
            context.intent.interaction = { point, onArrive };
            context.intent.destinationId = null;
            context.wait.retryElapsed = 0;

        }

        if (context.interaction.entering) {

            context.intent.deferredCommand = {
                type: "interaction",
                point,
                onArrive
            };
            return true;

        }

        if (context.turnaround.active) {

            context.intent.deferredCommand = {
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
            context.interaction.active &&
            context.interaction.active.point !== point) {

            const routeCandidate = this.findInteractionRouteCandidate(
                context,
                point
            );

            if (!routeCandidate ||
                !this.interactionTraffic.reserveRoutePoints(
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
            const exitNodeIds = exitTraversal.nodeIds;

            this.beginInteractionExit(context, {
                type: "interaction",
                point,
                onArrive,
                originId: exitTraversal.exitNodeId,
                nextNodeId: exitNodeIds[1] ?? null,
                preparedRouteCandidate: routeCandidate,
                intentPrepared: true
            });
            return true;

        }

        if (!skipTurnaround &&
            this.shouldTurnAround(actor, point.getWorldPosition())) {

            if (replaceIntent) {

                this.traffic.cancel(actor);
                this.interactionTraffic.releaseReservations(actor);

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
            const exitNodeIds = exitTraversal.nodeIds;
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
                context.traversal.interactionPoint,
                exitTraversal.exitNodeId,
                { nextNodeId: exitNodeIds[1] ?? null }
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
            context.route.departureContinuity = null;
            return true;

        }

        const directRoute = this.interactions.createDirectConnectionRoute(actor, point);

        if (directRoute) {

            if (!this.interactionTraffic.reserveRoutePoints(directRoute, actor)) {

                this.deferPersistentIntent(context);
                return false;
            }

            this.interactions.beginRoute(context, point, onArrive);
            this.helper?.highlightInteractionPoint(point.id);
            actor.followWaypoints(this.prepareRouteWaypoints(
                context,
                directRoute.waypoints
            ));
            context.route.departureContinuity = null;
            return true;

        }

        const candidate = this.findInteractionRouteCandidate(context, point);

        if (!candidate) {

            this.deferPersistentIntent(context);
            return false;

        }

        if (!this.interactionTraffic.reserveRoutePoints(candidate.route, actor)) {

            this.deferPersistentIntent(context);
            return false;
        }

        const exitTraversal = this.resolveInteractionExitTraversal(
            context,
            candidate.origin.id,
            this.getGraphWaypointIds(candidate.route.waypoints)
        );
        const exitNodeIds = exitTraversal.nodeIds;
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
            context.traversal.interactionPoint,
            exitTraversal.exitNodeId,
            { nextNodeId: exitNodeIds[1] ?? null }
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
        context.route.departureContinuity = null;

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

        const continuity = context.route.departureContinuity;

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

        return this.closedLoops.createRouteWaypoints(nodeIds);

    }

    preserveTopologicalWaypoints(...args) {

        return this.geometryBuilder.preserveTopologicalWaypoints(...args);

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
            !context.traversal.interactionPoint &&
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

        return this.waypointTraversal.canAcceptArrival(
            context,
            waypoint,
            completedConnection
        );

    }

    rejectInvalidSegment(actor, fromId, toId) {

        return this.waypointTraversal.rejectInvalidSegment(actor, fromId, toId);

    }

    tryEnterConnectionFromInteraction(actor, entry, waypoint = null) {

        return this.traffic.tryEnterFromInteraction(actor, entry, waypoint);

    }

    handleWaypointReached(context, waypoint, completedConnection) {

        return this.waypointTraversal.handleReached(
            context,
            waypoint,
            completedConnection
        );

    }

    completeClosedLoopLap(context, waypoint) {

        return this.closedLoops.completeLap(context, waypoint);

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

        // InteractionPoints are outside node ownership. Their exits request
        // traffic through their own originKey and enter the selected lane only
        // after the normal queue grants passage. This method therefore has no
        // node occupancy state to clear; it only removes obsolete visual tweens.
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

        return this.turnaround.shouldTurnAround(actor, requestedPosition);

    }

    beginTurnaround(context, command) {

        return this.turnaround.begin(context, command);

    }

    onTurnaroundRequested(actor) {

        return this.turnaround.onRequested(actor);

    }

    executeDeferredCommand(context, { skipInteractionExit = false } = {}) {

        return this.turnaround.execute(context, { skipInteractionExit });

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

        const actors = [...this.agents.keys()]
            .filter(actor => actor.isActive());

        for (const actor of actors) actor.authorizeMovementTraffic();
        for (const actor of actors) actor.prepareMovement();
        this.prepareCollisionFrame(actors);
        this.resolveCharacterOverlaps(actors, delta);
        for (const actor of actors) actor.evaluateMovementGuard(delta);
        for (const actor of actors) actor.updateMovement(delta);
        this.resolveResidualCharacterOverlaps(actors, delta);

        this.solvePhysics(delta);

        for (const actor of actors) actor.updateGrounding();
        for (const actor of actors) actor.updateAnimation(delta);

    }

    updatePlanning(delta) {

        this.navigationTime += delta;

        for (const context of this.agents.values()) {

            const { actor } = context;
            this.refreshPlannedRoutePreview(context);
            context.syncPhase(this.traffic.getWaitReason(actor));

            // Debug-only timer: this separates a pause owned by a visual exit
            // animation from a pause caused by traffic after it has finished.
            if (context.interaction.leaving) {

                context.interaction.exitElapsed += delta;

            }

            if (this.monitorNavigationProgress(context, delta)) continue;
            if (this.recoverOrphanedActor(context, delta)) continue;

            if (context.turnaround.active) {

                context.turnaround.elapsed += delta;

                if (context.turnaround.elapsed >= context.turnaround.duration) {

                    context.turnaround.active = false;
                    context.turnaround.elapsed = 0;
                    this.executeDeferredCommand(context);

                }

                continue;

            }

            // prepareInteractionExit() exclusively owns deferredCommand until
            // its animation callback fires. Generic retries here could execute
            // the command early, then leave the actor lowered at seat with no
            // command remaining for onComplete.
            if (context.interaction.leaving) continue;

            if (context.intent.deferredCommand) {

                context.wait.retryElapsed += delta;

                if (context.wait.retryElapsed < 0.5) continue;

                context.wait.retryElapsed = 0;
                this.executeDeferredCommand(context);
                continue;

            }

            if (context.traversal.laneCurve &&
                actor.isState(EntityState.WAITING) &&
                !this.traffic.isWaitingForQueue(actor)) {

                actor.resume();
                continue;

            }

            if (context.traversal.interactionCurve &&
                actor.isState(EntityState.WAITING) &&
                !this.traffic.isWaitingForQueue(actor)) {

                actor.resume();
                continue;

            }

            if (context.wait.blockedElapsed !== null) {

                context.wait.blockedElapsed += delta;

                if (context.wait.blockedElapsed >= context.wait.blockedTimeout) {

                    context.wait.blockedElapsed = null;
                    this.abandonBlockedIntent(context);

                }

            }

            if (context.wait.blockedElapsed !== null) continue;

            // prepareInteraction() owns this pause and resumes through its
            // onComplete callback; traffic retry must not interrupt animation.
            if (context.interaction.entering) continue;

            if (!actor.isState(EntityState.WAITING)) continue;

            context.wait.retryElapsed += delta;

            if (context.wait.retryElapsed < 0.5) continue;

            context.wait.retryElapsed = 0;

            if (context.intent.interaction ||
                actor.navigation.getCurrentWaypoint()?.interactionPoint) {

                if (actor.navigation.hasPath()) {

                    actor.resume();

                } else if (context.intent.interaction) {

                    const { point, onArrive } = context.intent.interaction;
                    this.moveToInteractionPoint(actor, point, onArrive, {
                        replaceIntent: false,
                        skipTurnaround: true
                    });

                }
                continue;

            }

            if (context.intent.position) {

                this.moveToClosestNode(actor, context.intent.position, {
                    replaceIntent: false,
                    skipTurnaround: true
                });

            }

        }

    }

    refreshPlannedRoutePreview(context, force = false) {

        const { actor } = context;
        const currentWaypoint = actor.navigation.getCurrentWaypoint();
        const signature = !currentWaypoint
            ? null
            : `${actor.navigation.getRouteRevision()}:` +
                `${actor.navigation.currentIndex}:` +
                `${actor.navigation.getGeometryRevision()}`;

        if (!force && signature === context.route.previewSignature) return;

        context.route.previewSignature = signature;

        if (!signature) {
            this.routeGeometry.clearPlannedLaneCurve(actor);
            this.helper?.refreshActiveLaneCurves();
            this.onChanged?.();
            return;
        }

        const waypoints = actor.navigation.getRemainingWaypoints();
        const points = this.geometryBuilder.createPlannedRoutePreview(
            context,
            waypoints
        );

        if (points.length >= 2) {
            this.routeGeometry.setPlannedLaneCurve(actor, points);
        } else {
            this.routeGeometry.clearPlannedLaneCurve(actor);
        }

        this.helper?.refreshActiveLaneCurves();
        this.onChanged?.();

    }

    updateTraffic(delta) {

        // Queue timers and timeouts are resolved before movement authorization
        // for this same frame. No CharacterCollisionFailsafe decision is made
        // from last frame's traffic snapshot anymore.
        let repairedLaneOccupancy = false;

        for (const { actor } of this.agents.values()) {

            const traversal = actor.navigation.getTraversalState();
            const connection = traversal.currentConnection;

            if (!connection) continue;

            const preferredLaneIndex = actor.navigation
                .getCurrentWaypoint()?.authorizedLaneIndex;
            const result = this.trafficState.ensureConnectionOccupancy(
                connection.fromId,
                connection.toId,
                actor,
                preferredLaneIndex
            );

            if (!result?.repaired) continue;

            repairedLaneOccupancy = true;
            console.warn(
                `[NavigationTraffic] Restored ${actor.name} as occupant of ` +
                `lane ${result.laneIndex} on "${connection.fromId} -> ` +
                `${connection.toId}".`
            );

        }

        if (repairedLaneOccupancy) this.refresh();

        this.traffic.update(delta);

        // Callbacks executed above may have completed an interaction, started
        // recovery or resumed traversal. Publish the final phase of this frame.
        for (const context of this.agents.values()) {

            context.syncPhase(
                this.traffic.getWaitReason(context.actor)
            );

        }

    }

    solvePhysics(delta) {

        // Cannon mirrors kinematic, detection-only character bodies. Traffic,
        // the predictive brake and the negotiated backstep remain the only
        // authorities allowed to affect character movement.
        this.physics.solve(delta);

    }

    prepareCollisionFrame(characters) {

        this.collisionFailsafe.beginFrame(characters);

    }

    resolveCharacterOverlaps(characters, delta) {

        this.collisionSolver.resolve(characters, delta);

    }

    resolveResidualCharacterOverlaps(characters, delta) {

        this.collisionSolver.resolveResidual(characters, delta);

    }

    monitorNavigationProgress(...args) {

        return this.recoveryPolicy.monitorNavigationProgress(...args);

    }

    retryPreservedIntent(context, { maxDetourFactor = 3 } = {}) {

        if (context.intent.interaction) {

            const { point, onArrive } = context.intent.interaction;
            return this.moveToInteractionPoint(
                context.actor,
                point,
                onArrive,
                { replaceIntent: false, skipTurnaround: true }
            );

        }

        if (context.intent.position) {

            return this.moveToClosestNode(
                context.actor,
                context.intent.position,
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

        for (const context of this.agents.values()) {

            if (context.recovery.pending) {

                this.tryRecoverToNearestNode(context);
                continue;

            }

            if (context.intent.position) {

                const replanned = this.moveToClosestNode(
                    context.actor,
                    context.intent.position,
                    { replaceIntent: false, skipTurnaround: true }
                );

                if (!replanned) {

                    context.actor.pause();
                    context.wait.blockedElapsed ??= 0;

                }

            }

            if (context.intent.interaction) {

                const { point, onArrive } = context.intent.interaction;
                const replanned = this.moveToInteractionPoint(
                    context.actor,
                    point,
                    onArrive,
                    { replaceIntent: false, skipTurnaround: true }
                );

                if (!replanned) {

                    context.actor.pause();
                    context.wait.blockedElapsed ??= 0;

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

        const context = this.agents.get(actor);

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
            this.agents.get(actor);

        if (!context) {

            return null;

        }

        const point =
            context.interaction.active?.point;

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
        // helper's full refresh explicitly through GameServices/Game.
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
        const interaction = context.intent.interaction?.point;
        const collision = this.collisionFailsafe.getDebugState(actor);
        const flags = [
            context.turnaround.active && "turning",
            context.interaction.entering && "interaction-entry",
            context.interaction.leaving && "interaction-exit",
            context.interaction.exitCommitted && "exit-committed",
            context.traversal.interactionExitPoint &&
                `exit-point:${context.traversal.interactionExitPoint.id}`,
            context.intent.closedLoop?.phase === "entering"
                ? `closed-loop-entry:${context.intent.closedLoop.entryNodeId}`
                : context.intent.closedLoop &&
                    `closed-loop:${context.intent.closedLoop.lapsCompleted}/` +
                    `${context.intent.closedLoop.lapsTotal}`,
            this.collisionFailsafe.isWaiting(actor) &&
                `collision-wait:${context.wait.collisionElapsed.toFixed(1)}s`,
            waypoint?.routeGeometry && "route-segments",
            context.traversal.laneCurve && "lane-curve",
            context.traversal.interactionCurve && "interaction-curve"
        ].filter(Boolean);

        return {
            name: actor.name,
            state: actor.state,
            phase: context.phase,
            traversal:
                context.traversal.kind,
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
                (context.intent.closedLoop
                    ? `${context.intent.closedLoop.id} ` +
                        (context.intent.closedLoop.phase === "entering"
                            ? `→ ${context.intent.closedLoop.entryNodeId} `
                            : "") +
                        `(${context.intent.closedLoop.lapsCompleted}/` +
                        `${context.intent.closedLoop.lapsTotal})`
                    : null) ??
                (context.intent.position
                    ? context.intent.destinationId ??
                    `position (${context.intent.position.x.toFixed(1)}, ` +
                    `${context.intent.position.z.toFixed(1)})`
                    : "—"),
            interaction: context.interaction.leaving
                ? `exit animation (${context.interaction.exitElapsed.toFixed(2)}s)`
                : context.interaction.active && context.intent.deferredCommand
                    ? "exit waits for traffic (animation not started)"
                    : context.interaction.active
                        ? `active: ${context.interaction.active.point.id}`
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
            collision: collision
                ? `${collision.kind}: ${collision.blocker.name} ` +
                    `(${collision.clearance.toFixed(2)}m, ` +
                    `${context.wait.collisionElapsed.toFixed(1)}s)`
                : "clear",
            collisionActive: Boolean(collision),
            recovery: context.recovery.pending
                ? `navigation ${context.recovery.elapsed.toFixed(1)}s / ` +
                    `${context.recovery.timeout.toFixed(1)}s`
                : collision && actor.navigationIntentPolicy !== "persistent"
                    ? `collision timeout ` +
                        `${context.wait.collisionElapsed.toFixed(1)}s / ` +
                        `${context.wait.collisionTimeout.toFixed(1)}s`
                    : collision
                        ? "persistent intent preserved"
                        : "—",
            flags: flags.join(", ") || "—"
        };

    }

    debugQueues() {

        return this.traffic.debugQueues();

    }

    getMetricsSnapshot() {

        return this.metrics.snapshot({
            agents: this.agents,
            trafficState: this.trafficState,
            connector: this.connector,
            traffic: this.traffic,
            physics: this.physics
        });

    }

    dispose() {

        for (const actor of [...this.agents.keys()]) {
            this.unregisterActor(actor);
        }

        this.interactionTraffic.dispose();
        if (this.connector.traffic === this.interactionTraffic) {
            this.connector.traffic = null;
        }

    }

}
