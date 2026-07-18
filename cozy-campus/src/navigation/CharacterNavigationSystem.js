import { EntityState } from "../core/EntityState";
import { AnimationPresets } from "../core/AnimationPresets";
import { Tween } from "../core/Tween";
import { NavigationTrafficSystem } from "./NavigationTrafficSystem";
import { InteractionNavigation } from "./InteractionNavigation";
import { CharacterCollisionFailsafe } from "./CharacterCollisionFailsafe";
import { PhysicsWorld } from "../physics/PhysicsWorld";
import { WaitReason } from "./WaitReason";
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
            activeInteraction: null,
            preparingInteraction: false,
            preparingInteractionExit: false,
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
            orphanedElapsed: 0,
            queueWaitElapsed: 0,
            queueWaitTimeout: 2,
            congestionEscaping: false,
            congestionAttempts: 0
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
        actor.setMovementGuard((target, _delta) =>
            this.collisionFailsafe.canMove(actor, target)
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

    moveToClosestNode(actor, position, {
        replaceIntent = true,
        skipTurnaround = false,
        skipInteractionExit = false,
        maxDetourFactor = 1.5
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

        if (context.turningAround) {

            context.deferredCommand = {
                type: "node",
                position: position.clone()
            };
            return true;

        }

        const candidate = this.findBestPlan(
            context,
            position,
            maxDetourFactor
        );

        if (!candidate) {

            console.log(`[Navigation] No reachable node for ${actor.name}.`);
            this.deferPersistentIntent(context);
            return false;

        }

        const originIndex = candidate.plan.nodeIds.indexOf(
            candidate.originId
        );
        const nextNodeId = candidate.plan.nodeIds[originIndex + 1] ?? null;

        if (!skipInteractionExit && context.activeInteraction) {

            this.beginInteractionExit(context, {
                type: "node",
                position: position.clone()
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
                candidate.originId,
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
        this.prepareOrigin(context, candidate.originId);

        const waypoints = [
            ...this.connector.createExitWaypoints(
                context.interactionPoint,
                candidate.originId
            ),
            ...this.createTraversalWaypoints(context, candidate.plan.nodeIds)
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

        actor.followWaypoints(waypoints, {
            waitAtEnd: candidate.plan.status === "waiting"
        });

        return true;

    }

    moveToInteractionPoint(actor, point, onArrive = null, {
        replaceIntent = true,
        skipTurnaround = false,
        skipInteractionExit = false
    } = {}) {

        const context = this.requireContext(actor);

        // Pointer commands must survive failed preflight checks. The queue may
        // suspend this interaction, but only a newer Player command replaces it.
        if (actor.navigationIntentPolicy === "persistent") {

            context.pendingPosition = null;
            context.pendingInteraction = { point, onArrive };
            context.destinationId = null;
            context.retryElapsed = 0;

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

            this.beginInteractionExit(context, {
                type: "interaction",
                point,
                onArrive
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

        const directRoute = this.interactions.createDirectConnectionRoute(actor, point);

        if (directRoute) {

            if (!this.connector.reserveRoutePoints(directRoute, actor)) {

                this.deferPersistentIntent(context);
                return false;
            }

            this.interactions.beginRoute(context, point, onArrive);
            this.helper?.highlightInteractionPoint(point.id);
            actor.followWaypoints(directRoute.waypoints);
            return true;

        }

        const routes = this.getOrigins(context)
            .sort((first, second) => first.accessCost - second.accessCost)
            .map(origin => ({
                origin,
                route: this.connector.createRoute(point, origin.id, actor)
            }))
            .filter(candidate => candidate.route);

        if (routes.length === 0) {

            this.deferPersistentIntent(context);
            return false;

        }

        const candidate = routes[0];

        if (!this.connector.reserveRoutePoints(candidate.route, actor)) {

            this.deferPersistentIntent(context);
            return false;
        }

        this.prepareOrigin(context, candidate.origin.id);
        this.interactions.beginRoute(context, point, onArrive);
        this.helper?.highlightInteractionPoint(point.id);
        actor.followWaypoints([
            ...this.connector.createExitWaypoints(
                context.interactionPoint,
                candidate.origin.id
            ),
            ...this.omitCurrentNodeWaypoint(context, candidate.route.waypoints)
        ]);

        return true;

    }

    // -----------------------------
    // Planning
    // -----------------------------

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

                const path = this.graph.findShortestPath(
                    originId,
                    endpointId,
                    { agent: context.actor, avoidOccupied: false }
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

    findBestPlan(context, position, maxDetourFactor = 1.5) {

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

    prepareOrigin(context, originId) {

        const { actor, interactionPoint } = context;

        if (!interactionPoint) {

            if (!actor.navigation.getTraversalState().currentConnection) return;

            this.graph.releaseReservations(actor);
            this.graph.reserveNode(originId, actor);
            return;

        }

        this.graph.releaseReservations(actor);
        this.graph.reserveNode(originId, actor);
        actor.navigation.setCurrentNode(originId);
        this.refresh();

    }

    createTraversalWaypoints(context, nodeIds) {

        const traversal = context.actor.navigation.getTraversalState();
        const startsAtCurrentNode =
            !context.interactionPoint &&
            traversal.currentNodeId === nodeIds[0];

        return this.graph.createWaypoints(
            startsAtCurrentNode ? nodeIds.slice(1) : nodeIds
        );

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
        if (!this.traffic.isFirstAtNode(waypoint.id, actor)) {
            this.traffic.setWaitReason(
                actor,
                waypoint.id,
                WaitReason.QUEUE_HEAD
            );
            return false;
        }

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

        if (this.interactions.handleWaypoint(context, waypoint)) return;

        if (waypoint.congestionEscape) {

            context.congestionEscaping = false;
            console.log(
                `[NavigationCongestion] ${actor.name} created local space ` +
                `and replans its preserved intent.`
            );
            this.retryPreservedIntent(context, { maxDetourFactor: Infinity });
            return;

        }

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
        context.congestionAttempts = 0;
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

    orientActor(actor, direction) {

        // Helper and actor consume this exact same world-space vector. Do not
        // reconstruct an Euler angle here: lookAt keeps the +Z convention used
        // by Locomotion and removes ambiguity around arrival direction.
        actor.object3D.lookAt(
            actor.object3D.position.x + direction.x,
            actor.object3D.position.y,
            actor.object3D.position.z + direction.z
        );

    }

    recoverAfterCollisionDisplacement(actor) {

        const context = this.requireContext(actor);
        const remaining = actor.navigation.getRemainingWaypoints();

        if (remaining.length === 0) return false;

        // Bézier samples have no semantic ownership. Keep the first waypoint
        // that actually means node/interaction/transition and everything
        // after it; only the obsolete local samples leading there are rebuilt.
        const targetIndex = remaining.findIndex(waypoint =>
            waypoint.id ||
            waypoint.interactionPoint ||
            waypoint.departureRequest ||
            waypoint.connectionEntry ||
            waypoint.leavingGraph ||
            waypoint.leavingInteraction
        );

        if (targetIndex < 0) return false;

        const target = remaining[targetIndex];
        const start = actor.object3D.position.clone();
        const staleSamples = remaining.slice(0, targetIndex);
        const lastStalePosition = staleSamples.at(-1)?.position;
        const arrivalDirection = lastStalePosition
            ? target.position.clone().sub(lastStalePosition).setY(0)
            : target.arrivalDirection?.clone() ?? null;
        const departureDirection = new THREE.Vector3(0, 0, 1)
            .applyQuaternion(actor.object3D.quaternion)
            .setY(0)
            .normalize();
        const midpoint = start.clone().lerp(target.position, 0.5);
        const curve = this.traffic.createLaneCurveWaypoints(
            start,
            midpoint,
            target.position,
            10,
            {
                departureDirection,
                arrivalDirection: arrivalDirection?.lengthSq() > 0.0001
                    ? arrivalDirection.normalize()
                    : null
            }
        );

        actor.navigation.replaceRemainingWaypoints([
            ...curve,
            target,
            ...remaining.slice(targetIndex + 1)
        ]);
        const belongsToSpecialCurve =
            context.traversingInteractionCurve;

        context.traversingLaneCurve =
            !belongsToSpecialCurve && curve.length > 0;
        this.graph.setActiveLaneCurve(actor, [
            start,
            ...curve.map(waypoint => waypoint.position),
            target.position
        ]);
        console.log(
            `[CollisionRecovery] ${actor.name} rebuilds ${curve.length} ` +
            `Bézier samples toward ` +
            `"${target.id ?? target.interactionPoint?.id ?? "local target"}".`
        );
        this.refresh();
        return true;

    }

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

        if (context.preparingInteractionExit) return;

        const interaction = context.activeInteraction;
        const approachPoint = interaction.point.via ?? interaction.point;

        context.preparingInteractionExit = true;
        context.deferredCommand = command;
        context.actor.pause();

        interaction.target?.prepareInteractionExit(
            context.actor,
            interaction.point,
            approachPoint,
            () => {

                if (!context.preparingInteractionExit) return;

                context.preparingInteractionExit = false;
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
                    skipInteractionExit
                }
            );

        } else {

            accepted = this.moveToClosestNode(
                context.actor,
                command.position,
                {
                    replaceIntent: !command.intentPrepared,
                    skipTurnaround: true,
                    skipInteractionExit
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

        for (const context of this.contexts.values()) {

            const { actor } = context;

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
        const hasIntent = Boolean(
            context.pendingInteraction || context.pendingPosition
        );

        // No movement is expected while DepartureQueue owns the actor. Running
        // recovery here would cancel a valid request and enqueue it again at
        // the tail, which can starve both Player and NPC indefinitely.
        if (this.traffic.isQueued(actor)) {

            if (!actor.navigation.hasPath()) {

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

                context.queueWaitElapsed = 0;
                context.recoveryElapsed = 0;
                context.recoveryPosition.copy(actor.object3D.position);
                return false;

            }

            context.queueWaitElapsed += delta;

            if (context.queueWaitElapsed >= context.queueWaitTimeout) {

                context.queueWaitElapsed = 0;
                this.resolveQueueCongestion(context);
                return true;

            }

            context.recoveryElapsed = 0;
            context.recoveryPosition.copy(actor.object3D.position);
            return false;

        }

        context.queueWaitElapsed = 0;

        const mayRecover = hasIntent &&
            !context.preparingInteraction &&
            !context.preparingInteractionExit

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

    resolveQueueCongestion(context) {

        const { actor } = context;

        console.warn(
            `[NavigationCongestion] ${actor.name} exceeded queue timeout; ` +
            `discarding the local route while preserving its target.`
        );
        context.congestionAttempts++;
        this.traffic.cancel(actor);
        this.graph.releaseReservations(actor);
        this.connector.releaseReservations(actor);
        this.graph.clearActiveLaneCurve(actor);
        actor.navigation.clearRoute();
        context.traversingLaneCurve = false;
        context.traversingInteractionCurve = false;
        context.transitTangent = null;

        if (context.pendingPosition) {

            const alternative = this.findBestPlan(
                context,
                context.pendingPosition,
                Infinity
            );

            if (alternative?.plan.status === "ready") {

                console.log(
                    `[NavigationCongestion] ${actor.name} found an available ` +
                    `detour.`
                );
                this.moveToClosestNode(actor, context.pendingPosition, {
                    replaceIntent: false,
                    skipTurnaround: true,
                    maxDetourFactor: Infinity
                });
                return true;

            }

        }

        return this.beginCongestionEscape(context);

    }

    beginCongestionEscape(context) {

        const { actor } = context;
        const target = context.pendingInteraction?.point.getWorldPosition() ??
            context.pendingPosition ??
            actor.navigation.getCurrentWaypoint()?.position ??
            null;

        if (!target) {

            actor.setState(EntityState.IDLE);
            return false;

        }

        const retreat = context.congestionAttempts > 1;
        const escapePosition = retreat
            ? this.physics.findRetreatPosition(actor, target)
            : this.physics.findEscapePosition(actor, target);

        context.congestionEscaping = true;
        actor.followWaypoints([{
            id: null,
            position: escapePosition,
            congestionEscape: true
        }]);
        console.log(
            `[NavigationCongestion] ${actor.name} ` +
            `${retreat ? "turns back" : "leaves the lane locally"} ` +
            `before trying another route.`
        );
        return true;

    }

    retryPreservedIntent(context, { maxDetourFactor = 1.5 } = {}) {

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

    recoverOrphanedActor(context, delta) {

        const { actor } = context;
        const hasOwner = Boolean(
            actor.navigation.hasPath() ||
            context.pendingPosition ||
            context.pendingInteraction ||
            context.deferredCommand ||
            context.activeInteraction ||
            context.congestionEscaping ||
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
        actor.followWaypoints(this.graph.createWaypoints([endpoint.id]));

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

        this.helper?.refresh();
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
            context.congestionEscaping && "congestion-escape",
            context.traversingLaneCurve && "lane-curve",
            context.traversingInteractionCurve && "interaction-curve"
        ].filter(Boolean);

        return {
            name: actor.name,
            state: actor.state,
            traversal:
                context.currentTraversal,
            location: traversal.currentNodeId ?? (connection
                ? `${connection.fromId} → ${connection.toId}`
                : "off-graph"),
            lane: laneIndex === null ? "—" : `${laneIndex === 0 ? "A" : "B"} (${laneIndex})`,
            next: nextStructuralWaypoint?.id ??
                nextStructuralWaypoint?.interactionPoint?.id ??
                nextStructuralWaypoint?.departureRequest?.originId ??
                (waypoint ? "curve → local target" : "—"),
            intent: interaction?.id ??
                (context.pendingPosition
                    ? context.destinationId ??
                    `position (${context.pendingPosition.x.toFixed(1)}, ` +
                    `${context.pendingPosition.z.toFixed(1)})`
                    : "—"),
            queue: traffic.queue
                ? `${traffic.queue.originId} ${traffic.queue.position}/${traffic.queue.length}`
                : "—",
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
