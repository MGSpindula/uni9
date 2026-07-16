import { EntityState } from "../core/EntityState";
import { AnimationPresets } from "../core/AnimationPresets";
import { Tween } from "../core/Tween";
import { NavigationNodeMode } from "./NavigationNodeMode";
import { NavigationTrafficSystem } from "./NavigationTrafficSystem";
import { InteractionNavigation } from "./InteractionNavigation";
import * as THREE from "three";

export class CharacterNavigationSystem {

    constructor({ graph, connector, helper, onChanged = null }) {

        this.graph = graph;
        this.connector = connector;
        this.helper = helper;
        this.onChanged = onChanged;
        this.contexts = new Map();
        this.traffic = new NavigationTrafficSystem(this);
        this.interactions = new InteractionNavigation(this);

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
            retryElapsed: 0,
            blockedElapsed: null,
            blockedTimeout: 3,
            recoveryPending: false,
            pendingIdleSlot: null,
            pendingIdleNodeId: null,
            idleDelayRemaining: 0,
            centeringForDeparture: false,
            nodeMode: NavigationNodeMode.DWELL,
            clearanceRequesters: new Set()
        };

        this.contexts.set(actor, context);

        actor.setWaypointReachedHandler((waypoint, completedConnection) =>
            this.handleWaypointReached(context, waypoint, completedConnection)
        );
        actor.setSegmentRequestedHandler((fromId, toId) =>
            this.tryStartConnection(actor, fromId, toId)
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
        actor.setLocalConnectionRequestedHandler(entry =>
            this.tryEnterConnectionFromInteraction(actor, entry)
        );
        actor.setNavigationCancelledHandler(() => {

            this.graph.releaseReservations(actor);
            this.connector.releaseReservations(actor);
            this.releaseClearanceRequests(actor);
            this.refresh();

        });

        if (spawnId) this.placeActorAtNode(actor, spawnId);

        return context;

    }

    unregisterActor(actor) {

        const context = this.contexts.get(actor);
        if (!context) return;

        this.graph.releaseAgent(actor);
        this.releaseClearanceRequests(actor);
        this.finishActiveInteraction(context);
        this.connector.releaseAgent(actor);
        this.traffic.unregister(actor);
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
        this.parkActorAtNode(this.requireContext(actor), nodeId);
        this.refresh();

        return true;

    }

    // -----------------------------
    // Commands
    // -----------------------------

    moveToClosestNode(actor, position) {

        const context = this.requireContext(actor);

        if (context.clearanceRequesters.size > 0) return false;

        const candidate = this.findBestPlan(context, position);

        if (!candidate) {

            console.log(`[Navigation] No reachable node for ${actor.name}.`);
            return false;

        }

        context.pendingPosition = position.clone();
        context.nodeMode = NavigationNodeMode.TRANSIT;
        context.pendingInteraction = null;
        context.destinationId = candidate.plan.destinationId;
        context.retryElapsed = 0;
        context.blockedElapsed = null;
        context.recoveryPending = false;
        this.cancelPendingParking(context);
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
            context.nodeMode = NavigationNodeMode.DWELL;
            actor.cancel();
            return true;

        }

        actor.followWaypoints(waypoints, {
            waitAtEnd: candidate.plan.status === "waiting"
        });

        return true;

    }

    moveToInteractionPoint(actor, point, onArrive = null) {

        const context = this.requireContext(actor);

        if (context.clearanceRequesters.size > 0 ||
            !point.accessible ||
            !this.connector.connect(point)) return false;

        const directRoute = this.interactions.createDirectConnectionRoute(actor, point);

        if (directRoute) {

            if (!this.connector.reserveRoutePoints(directRoute, actor)) {
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

        if (routes.length === 0) return false;

        const candidate = routes[0];

        if (!this.connector.reserveRoutePoints(candidate.route, actor)) {
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

    findBestPlan(context, position) {

        const candidates = this.getOrigins(context)
            .map(origin => ({
                originId: origin.id,
                accessCost: origin.accessCost,
                plan: this.graph.planClosestPath(
                    origin.id,
                    position,
                    context.actor
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
                .filter(id => this.graph.isNodeAvailable(id, actor))
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

    tryStartConnection(actor, fromId, toId) {

        return this.traffic.tryStartConnection(actor, fromId, toId);

    }

    tryEnterConnectionFromInteraction(actor, entry) {

        return this.traffic.tryEnterFromInteraction(actor, entry);

    }

    handleWaypointReached(context, waypoint, completedConnection) {

        const { actor } = context;

        if (this.interactions.handleWaypoint(context, waypoint)) return;
        if (!waypoint.id) return;

        if (context.interactionPoint) {

            this.leaveInteractionPoint(context);

        }

        if (completedConnection) {

            this.graph.releaseConnection(
                completedConnection.fromId,
                completedConnection.toId,
                actor
            );

            if (actor.visual && Math.abs(actor.visual.position.x) > 0.001) {

                AnimationPresets.to(actor, {
                    object: actor.visual.position,
                    property: "x",
                    to: 0,
                    duration: 0.25,
                    easing: Tween.easeInOutQuad
                });

            }

        }

        this.graph.occupyNode(waypoint.id, actor);
        this.releaseClearanceRequests(actor, waypoint.id);

        if (waypoint.id === context.destinationId) {

            context.pendingPosition = null;
            context.destinationId = null;
            context.nodeMode = NavigationNodeMode.DWELL;
            context.clearanceRequesters.clear();
            actor.setState(EntityState.STOPPING);
            this.parkActorAtNode(context, waypoint.id);

        } else {

            context.nodeMode = NavigationNodeMode.TRANSIT;

        }

        console.log(`[Navigation] ${actor.name} passed: ${waypoint.id}`);
        this.refresh();

    }

    parkActorAtNode(context, nodeId, { immediate = false } = {}) {

        const { actor } = context;

        if (!actor.visual) return;

        const node = this.graph.requireNode(nodeId);
        const slot = this.graph.claimNodeIdleSlot(nodeId, actor);
        const worldPosition = node.position.clone().add(
            new THREE.Vector3(slot.x, 0, slot.z)
        );

        if (immediate) {

            actor.object3D.position.x = worldPosition.x;
            actor.object3D.position.z = worldPosition.z;
            return;

        }

        // Reaching a node and stepping aside are different visual actions.
        // Waiting here prevents the side-step from blending into locomotion.
        context.pendingIdleSlot = worldPosition;
        context.pendingIdleNodeId = nodeId;
        context.idleDelayRemaining = 5;

    }

    applyPendingParking(context) {

        const { actor, pendingIdleSlot, pendingIdleNodeId } = context;

        if (!pendingIdleSlot) return;

        // Resting is a real world-space displacement. Navigation still owns the
        // logical node, while object3D moves physically outside its crossing.
        AnimationPresets.to(actor, {
            object: actor.object3D.position,
            property: "x",
            to: pendingIdleSlot.x,
            duration: 0.8,
            easing: Tween.easeInOutQuad
        });
        AnimationPresets.to(actor, {
            object: actor.object3D.position,
            property: "z",
            to: pendingIdleSlot.z,
            duration: 0.8,
            easing: Tween.easeInOutQuad,
            onComplete: () => {

                // The crossing becomes passable only when the visible actor
                // has actually finished stepping out of it.
                this.graph.setNodeAgentResting(
                    pendingIdleNodeId,
                    actor,
                    true
                );
                actor.setState(EntityState.DWELLING);
                this.refresh();

            }
        });

        context.pendingIdleSlot = null;
        context.pendingIdleNodeId = null;

    }

    cancelPendingParking(context) {

        context.pendingIdleSlot = null;
        context.pendingIdleNodeId = null;
        context.idleDelayRemaining = 0;

    }

    requestImmediateNodeClearance(nodeId, requestingActor) {

        for (const occupant of this.graph.getNodeOccupants(nodeId)) {

            if (occupant === requestingActor) continue;

            const context = this.contexts.get(occupant);

            // Someone is trying to pass through this actor's destination.
            // Skip the normal dwell delay and step aside immediately.
            if (context?.nodeMode !== NavigationNodeMode.DWELL) continue;

            if (!context.clearanceRequesters.has(requestingActor)) {

                context.clearanceRequesters.add(requestingActor);
                this.onDwellClearanceRequested(
                    occupant,
                    requestingActor,
                    nodeId
                );

            }

            if (!context.pendingIdleSlot) continue;

            context.idleDelayRemaining = 0;
            this.applyPendingParking(context);

        }

    }

    onDwellClearanceRequested(dwellActor, transitActor, nodeId) {

        // Future animation hook: look back, acknowledge the approaching actor
        // and perform a deliberate side-step before yielding the route.
        console.log(
            `[Navigation] ${dwellActor.name} yields node "${nodeId}" ` +
            `to ${transitActor.name}.`
        );

    }

    centerActorForDeparture(context) {

        const { actor } = context;

        const currentNodeId = actor.navigation.getTraversalState().currentNodeId;

        if (currentNodeId) {

            // Returning toward the center makes this actor part of traffic
            // again, so the node must stop being passable immediately.
            this.graph.setNodeAgentResting(currentNodeId, actor, false);

        }

        this.cancelPendingParking(context);

        // object3D already occupies the resting spot in world space. Once the
        // route is authorized, Locomotion moves directly from there to the next
        // graph node and owns all turning; no visual recentering is necessary.
        actor.cancelTweens(actor.object3D.position, ["x", "z"]);
        context.centeringForDeparture = false;
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

    // -----------------------------
    // Lifecycle
    // -----------------------------

    update(delta) {

        this.traffic.update();

        for (const context of this.contexts.values()) {

            const { actor } = context;

            if (context.pendingIdleSlot) {

                context.idleDelayRemaining -= delta;

                if (context.idleDelayRemaining <= 0) {

                    context.idleDelayRemaining = 0;
                    this.applyPendingParking(context);

                }

            }

            if (context.blockedElapsed !== null) {

                context.blockedElapsed += delta;

                if (context.blockedElapsed >= context.blockedTimeout) {

                    context.blockedElapsed = null;
                    this.abandonBlockedDestination(context);

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

                actor.resume();
                continue;

            }

            if (context.pendingPosition) {

                this.moveToClosestNode(actor, context.pendingPosition);

            }

        }

    }

    releaseClearanceRequests(requestingActor, reachedNodeId = null) {

        for (const context of this.contexts.values()) {

            if (!context.clearanceRequesters.has(requestingActor)) continue;

            if (reachedNodeId) {

                const dwellNodeId = context.actor.navigation
                    .getTraversalState().currentNodeId;

                if (dwellNodeId !== reachedNodeId) continue;

            }

            context.clearanceRequesters.delete(requestingActor);

        }

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
                    context.pendingPosition
                );

                if (!replanned) {

                    context.actor.pause();
                    context.blockedElapsed ??= 0;

                }

            }

        }

    }

    abandonBlockedDestination(context) {

        context.pendingPosition = null;
        context.destinationId = null;
        context.recoveryPending = true;
        this.graph.releaseReservations(context.actor);
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

    refresh() {

        this.helper?.refresh();
        this.onChanged?.();

    }

}






