import { EntityState } from "../core/EntityState";
import { AnimationPresets } from "../core/AnimationPresets";
import { Tween } from "../core/Tween";
import { NavigationNodeMode } from "./NavigationNodeMode";
import * as THREE from "three";

export class CharacterNavigationSystem {

    constructor({ graph, connector, helper, onChanged = null }) {

        this.graph = graph;
        this.connector = connector;
        this.helper = helper;
        this.onChanged = onChanged;
        this.contexts = new Map();
        this.activeEncounters = [];

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
        this.activeEncounters = this.activeEncounters.filter(encounter =>
            encounter.first !== actor && encounter.second !== actor
        );
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
    // Commands shared by Player and NPCs
    // -----------------------------

    moveToClosestNode(actor, position) {

        const context = this.requireContext(actor);

        if (context.clearanceRequesters.size > 0) return false;

        const candidate = this.findBestPlan(context, position);

        if (!candidate) {

            console.log(
                `[Navigation] No reachable node for ${actor.name}.`
            );
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
            ...this.createTraversalWaypoints(
                context,
                candidate.plan.nodeIds
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

        if (context.clearanceRequesters.size > 0) return false;

        if (!point.accessible || !this.connector.connect(point)) return false;

        const directRoute = this.createDirectConnectionRoute(actor, point);

        if (directRoute) {

            if (!this.connector.reserveRoutePoints(directRoute, actor)) {

                return false;

            }

            this.beginInteractionRoute(context, point, onArrive);
            this.helper?.highlightInteractionPoint(point.id);
            actor.followWaypoints(directRoute.waypoints);

            return true;

        }

        const routes = this.getOrigins(context)
            // When interrupted in the middle of an edge, rejoin the graph at
            // the nearest reachable endpoint before considering the approach.
            .sort((first, second) => first.accessCost - second.accessCost)
            .map(origin => ({
                origin,
                route: this.connector.createRoute(point, origin.id, actor)
            }))
            .filter(candidate => candidate.route);

        if (routes.length === 0) return false;

        // Route cost must not select the farther endpoint merely because it is
        // globally shorter. Finishing the current edge is a separate rule.
        const candidate = routes[0];

        if (!this.connector.reserveRoutePoints(candidate.route, actor)) {

            return false;

        }

        this.prepareOrigin(context, candidate.origin.id);

        this.beginInteractionRoute(context, point, onArrive);

        this.helper?.highlightInteractionPoint(point.id);
        actor.followWaypoints([
            ...this.connector.createExitWaypoints(
                context.interactionPoint,
                candidate.origin.id
            ),
            ...this.omitCurrentNodeWaypoint(
                context,
                candidate.route.waypoints
            )
        ]);

        return true;

    }

    beginInteractionRoute(context, point, onArrive) {

        context.pendingPosition = null;
        context.nodeMode = NavigationNodeMode.TRANSIT;
        context.destinationId = null;
        context.pendingInteraction = { point, onArrive };
        context.retryElapsed = 0;
        context.blockedElapsed = null;
        context.recoveryPending = false;
        this.cancelPendingParking(context);

    }

    createDirectConnectionRoute(actor, point) {

        const traversal = actor.navigation.getTraversalState();

        if (!traversal.currentConnection) return null;

        const accessPoint = point.via ?? point;
        const access = this.connector.connect(accessPoint);
        const currentIds = [
            traversal.currentConnection.fromId,
            traversal.currentConnection.toId
        ];
        const usesCurrentConnection =
            access?.nodeIds?.length === 2 &&
            currentIds.every(id => access.nodeIds.includes(id));

        if (!usesCurrentConnection) return null;

        const waypoints = [];

        // Keep this marker even when the actor already sits on the projection:
        // reaching it releases the occupied graph connection topologically.
        waypoints.push({
            id: null,
            position: access.projectedPosition.clone(),
            leavingGraph: true
        });

        if (accessPoint !== point) {

            waypoints.push({
                id: null,
                position: accessPoint.getWorldPosition(),
                interactionPoint: accessPoint
            });

        }

        waypoints.push({
            id: null,
            position: point.getWorldPosition(),
            interactionPoint: point
        });

        return { waypoints };

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
            best.accessCost + best.plan.cost
                ? current
                : best
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

            const traversal = actor.navigation.getTraversalState();

            if (!traversal.currentConnection) return;

            this.graph.releaseReservations(actor);
            this.graph.reserveNode(originId, actor);
            return;

        }

        this.graph.releaseReservations(actor);
        this.graph.reserveNode(originId, actor);
        actor.navigation.setCurrentNode(originId);
        this.refresh();

    }

    // -----------------------------
    // Traversal and occupancy
    // -----------------------------

    tryStartConnection(actor, fromId, toId) {

        const context = this.requireContext(actor);

        const laneIndex = this.graph.reserveConnectionLane(
            fromId,
            toId,
            actor
        );

        if (laneIndex === null) return false;

        this.requestImmediateNodeClearance(toId, actor);

        if (!this.graph.reserveNode(toId, actor)) {

            const reciprocal = this.graph.hasReciprocalLaneReservation(
                fromId,
                toId,
                actor
            );

            if (!reciprocal) {

                const connection = this.graph.requireConnection(fromId, toId);

                // Keep only a multi-lane head-on intention. It lets an actor at
                // the opposite endpoint announce that it is leaving. A parked
                // actor has no reciprocal intention and remains impassable.
                if (!connection.passingAllowed ||
                    connection.lanes.length < 2) {

                    this.graph.releaseConnection(fromId, toId, actor);

                }

                return false;

            }

        }

        // All traffic resources are secured. The logical root may start moving
        // now while the parked visual blends directly back onto the graph axis.
        this.centerActorForDeparture(context);

        this.graph.occupyConnectionLane(
            fromId,
            toId,
            actor,
            laneIndex
        );
        this.graph.releaseNode(fromId, actor);

        this.refresh();

        return true;

    }

    tryEnterConnectionFromInteraction(actor, { fromId, toId }) {

        const traversal = actor.navigation.getTraversalState();

        if (traversal.currentConnection) return true;

        const laneIndex = this.graph.reserveConnectionLane(
            fromId,
            toId,
            actor
        );

        if (laneIndex === null) return false;

        if (!this.graph.reserveNode(toId, actor)) {

            this.graph.releaseConnection(fromId, toId, actor);
            return false;

        }

        this.graph.occupyConnectionLane(
            fromId,
            toId,
            actor,
            laneIndex
        );
        actor.navigation.beginConnection(fromId, toId);
        this.centerActorForDeparture(this.requireContext(actor));
        this.refresh();

        return true;

    }

    moveVisualToConnectionLane(actor, fromId, toId, laneIndex) {

        if (!actor.visual) return;

        AnimationPresets.to(actor, {
            object: actor.visual.position,
            property: "x",
            to: this.graph.getConnectionLaneOffset(
                fromId,
                toId,
                laneIndex
            ),
            duration: 0.25,
            easing: Tween.easeInOutQuad
        });

    }

    moveVisualToCenter(actor) {

        if (!actor.visual || Math.abs(actor.visual.position.x) <= 0.001) {

            return;

        }

        AnimationPresets.to(actor, {
            object: actor.visual.position,
            property: "x",
            to: 0,
            duration: 0.35,
            easing: Tween.easeInOutQuad
        });

    }

    handleWaypointReached(context, waypoint, completedConnection) {

        const { actor } = context;

        if (waypoint.leavingGraph) {

            const traversal = actor.navigation.getTraversalState();
            const nodeId = traversal.currentNodeId;

            if (nodeId) this.graph.releaseNode(nodeId, actor);

            if (traversal.currentConnection) {

                this.graph.releaseConnection(
                    traversal.currentConnection.fromId,
                    traversal.currentConnection.toId,
                    actor
                );
                actor.navigation.leaveConnection();

            }

            this.refresh();
            return;

        }

        if (waypoint.leavingInteraction) {

            if (context.interactionPoint) {

                this.leaveInteractionPoint(context);

            }

            this.refresh();
            return;

        }

        if (waypoint.interactionPoint) {

            if (context.interactionPoint !== waypoint.interactionPoint) {

                if (context.interactionPoint) {

                    this.leaveInteractionPoint(context);

                }

                this.connector.occupyPoint(waypoint.interactionPoint, actor);
                context.interactionPoint = waypoint.interactionPoint;

            }

            const interaction = context.pendingInteraction;

            if (!context.preparingInteraction &&
                interaction?.point.via === waypoint.interactionPoint) {

                context.preparingInteraction = true;
                actor.pause();

                interaction.point.entity?.prepareInteraction(
                    actor,
                    waypoint.interactionPoint,
                    interaction.point,
                    () => {

                        context.preparingInteraction = false;
                        actor.resume();

                    }
                );

            }

            if (interaction?.point === waypoint.interactionPoint) {

                context.pendingInteraction = null;
                actor.object3D.rotation.y =
                    waypoint.interactionPoint.getWorldRotationY();
                interaction.onArrive?.();
                context.activeInteraction = {
                    target: waypoint.interactionPoint.entity,
                    point: waypoint.interactionPoint
                };

            }

            this.refresh();
            return;

        }

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

    createTraversalWaypoints(context, nodeIds) {

        const traversal = context.actor.navigation.getTraversalState();
        const startsAtCurrentNode =
            !context.interactionPoint &&
            traversal.currentNodeId === nodeIds[0];

        // currentNodeId is topological ownership, not necessarily the actor's
        // world position. A resting actor may be beside that node, so targeting
        // it again would force an unwanted return to center before departure.
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

        this.updateTrafficAvoidance();

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

    updateTrafficAvoidance() {

        const observedPairs = [];
        const visitedConnections = new Set();

        for (const node of this.graph.nodes.values()) {

            for (const connection of node.connections.values()) {

                if (visitedConnections.has(connection)) continue;

                visitedConnections.add(connection);

                const forward = [];
                const reverse = [];

                for (const lane of connection.lanes) {

                    for (const actor of lane.occupants) {

                        const direction = lane.directions.get(actor);
                        const entry = { actor, laneIndex: lane.index, direction };

                        if (direction?.fromId === connection.fromId) {

                            forward.push(entry);

                        } else if (direction) {

                            reverse.push(entry);

                        }

                    }

                }

                for (const first of forward) {

                    for (const second of reverse) {

                        observedPairs.push({ connection, first, second });

                    }

                }

            }

        }

        for (const pair of observedPairs) {

            const existing = this.activeEncounters.find(encounter =>
                encounter.connection === pair.connection &&
                encounter.first === pair.first.actor &&
                encounter.second === pair.second.actor
            );
            const distance = this.getPlanarActorDistance(
                pair.first.actor,
                pair.second.actor
            );
            const crossed = this.haveActorsCrossed(pair);

            if (!existing && !crossed && distance <= 2.5) {

                this.activeEncounters.push({
                    connection: pair.connection,
                    first: pair.first.actor,
                    second: pair.second.actor,
                    crossed: false
                });
                this.moveVisualToConnectionLane(
                    pair.first.actor,
                    pair.first.direction.fromId,
                    pair.first.direction.toId,
                    pair.first.laneIndex
                );
                this.moveVisualToConnectionLane(
                    pair.second.actor,
                    pair.second.direction.fromId,
                    pair.second.direction.toId,
                    pair.second.laneIndex
                );

            } else if (existing && crossed) {

                existing.crossed = true;

            }

        }

        this.activeEncounters = this.activeEncounters.filter(encounter => {

            const pair = observedPairs.find(candidate =>
                candidate.connection === encounter.connection &&
                candidate.first.actor === encounter.first &&
                candidate.second.actor === encounter.second
            );
            const finished = !pair || (
                encounter.crossed &&
                this.getPlanarActorDistance(
                    encounter.first,
                    encounter.second
                ) >= 1.2
            );

            if (finished) {

                this.moveVisualToCenter(encounter.first);
                this.moveVisualToCenter(encounter.second);

            }

            return !finished;

        });

    }

    haveActorsCrossed({ connection, first, second }) {

        const from = this.graph.requireNode(connection.fromId).position;
        const to = this.graph.requireNode(connection.toId).position;
        const directionX = to.x - from.x;
        const directionZ = to.z - from.z;
        const forwardProgress =
            (first.actor.object3D.position.x - from.x) * directionX +
            (first.actor.object3D.position.z - from.z) * directionZ;
        const reverseProgress =
            (second.actor.object3D.position.x - from.x) * directionX +
            (second.actor.object3D.position.z - from.z) * directionZ;

        return forwardProgress >= reverseProgress;

    }

    getPlanarActorDistance(first, second) {

        const deltaX = first.object3D.position.x - second.object3D.position.x;
        const deltaZ = first.object3D.position.z - second.object3D.position.z;

        return Math.hypot(deltaX, deltaZ);

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
