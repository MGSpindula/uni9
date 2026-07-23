import { EntityState } from "../core/EntityState";
import { WaitReason } from "./WaitReason";

// Recovery não escolhe comportamento novo. Ele preserva ou abandona a intenção
// conforme a política do ator e devolve o controle ao planner/controller.
export class NavigationRecoveryPolicy {

    constructor(navigation) {

        this.navigation = navigation;
        this.graph = navigation.graph;
        this.connector = navigation.connector;
        this.interactionTraffic = navigation.interactionTraffic;
        this.traffic = navigation.traffic;
        this.collisionFailsafe = navigation.collisionFailsafe;

    }

    monitorNavigationProgress(context, delta) {

        const { actor } = context;
        const traversal = actor.navigation.getTraversalState();
        const hasIntent = Boolean(
            context.intent.interaction || context.intent.position
        );

        // Collision negotiation owns this lack of progress. Never cancel and
        // rebuild the route here: doing so merely recreates the same physical
        // encounter, loses reservations and can turn two nearby actors into a
        // permanent replan loop. CollisionFailsafe chooses a stable winner;
        // CollisionSolver creates space and rejoins the SAME route.
        if (
            this.collisionFailsafe
                .isWaiting(actor)
        ) {

            context.wait.collisionElapsed +=
                delta;

            context.recovery.elapsed =
                0;

            context.recovery.position
                .copy(
                    actor.object3D.position
                );

            const encounter =
                this.collisionFailsafe
                    .getEncounter(
                        actor
                    );

            if (!encounter) {

                return false;

            }

            const solverStalled =
                (
                    encounter.stalledElapsed ??
                    0
                ) >= 0.75;

            const timedOut =
                context.wait.collisionElapsed >=
                context.wait.collisionTimeout;

            /*
             * Nunca apague a rota enquanto os corpos
             * ainda participam do mesmo encounter.
             */
            if (
                encounter.nodeId &&
                (
                    solverStalled ||
                    timedOut
                )
            ) {

                return this.navigation
                    .evacuateStaleNode(
                        encounter.nodeId
                    );

            }

            if (
                solverStalled ||
                timedOut
            ) {

                return this.navigation
                    .resolveStaleCollision(
                        encounter
                    );

            }

            return false;

        }

        context.wait.collisionElapsed = 0;

        // No movement is expected while DepartureQueue owns the actor. Running
        // recovery here would cancel a valid request and enqueue it again at
        // the tail, which can starve both Player and NPC indefinitely.
        if (this.traffic.isQueued(actor)) {

            if (!actor.navigation.hasPath()) {

                const interactionExitOwnsQueue =
                    context.interaction.active &&
                    (context.interaction.leaving ||
                        context.intent.deferredCommand);

                if (interactionExitOwnsQueue) {

                    // Interaction exit intentionally reserves traffic before
                    // the stand-up/release animation creates a navigation
                    // path. This is a committed exit, not a stale queue row.
                    context.recovery.elapsed = 0;
                    context.recovery.position.copy(actor.object3D.position);
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

                context.recovery.elapsed = 0;
                context.recovery.position.copy(actor.object3D.position);
                return false;

            }

            context.recovery.elapsed = 0;
            context.recovery.position.copy(actor.object3D.position);
            return false;

        }

        const mayRecover = hasIntent &&
            !context.interaction.entering &&
            !context.interaction.leaving &&
            !context.interaction.exitCommitted;

        if (!mayRecover) {

            context.recovery.elapsed = 0;
            context.recovery.position.copy(actor.object3D.position);
            return false;

        }

        const progress = context.recovery.position.distanceTo(
            actor.object3D.position
        );

        if (progress >= 0.025) {

            context.recovery.elapsed = 0;
            context.recovery.position.copy(actor.object3D.position);
            return false;

        }

        context.recovery.elapsed += delta;

        if (context.recovery.elapsed < context.recovery.timeout) return false;

        context.recovery.elapsed = 0;
        context.recovery.position.copy(actor.object3D.position);
        this.restartIntentFromNearestAccess(context);
        return true;

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

        const requiredTimeouts = actor.navigationIntentPolicy === "persistent"
            ? 2
            : 1;

        if ((!replaceableWait && !persistentReplan) ||
            wait.timeoutCount < requiredTimeouts) {

            return false;

        }

        const context = this.navigation.requireContext(actor);

        if (context.interaction.exitCommitted) {

            // The actor may already be between action, approach and graph.
            // Clearing its route here would strand it off-graph. Traffic keeps
            // the queue and the ordinary retry loop preserves the later goal.
            context.wait.collisionElapsed = 0;
            context.recovery.elapsed = 0;
            return true;

        }

        /*
        * Um NPC replaceable que não conseguiu chegar
        * ao InteractionPoint precisa evitar esse mesmo
        * ponto na próxima escolha de comportamento.
        *
        * Capture a referência antes de limpar o intent.
        */
        const rejectedPoint =
            replaceableWait

                ? context.intent
                    .interaction
                    ?.point ??
                null

                : null;

        if (rejectedPoint) {

            actor.navigationAvoidInteractionPoint =
                rejectedPoint;

            actor.navigationAvoidInteractionPointId =
                rejectedPoint.id;

        }

        console.warn(
            `[NavigationRecovery] ${actor.name} abandons a stale traffic wait ` +
            `at "${wait.resourceId}" and releases its route.`
        );

        actor.onTrafficRerouteRequested?.({ ...wait });

        this.traffic.cancel(actor);
        this.interactionTraffic.releaseReservations(actor);
        this.navigation.trafficState.releaseReservations(actor);
        this.navigation.routeGeometry.clearActiveLaneCurve(actor);
        actor.navigation.clearRoute();
        actor.locomotion.resetCurve();
        context.traversal.laneCurve = false;
        context.traversal.interactionCurve = false;
        context.wait.retryElapsed = 0;

        if (actor.navigationIntentPolicy === "persistent") {

            actor.setState(EntityState.WAITING);
            this.navigation.retryPreservedIntent(context, { maxDetourFactor: 6 });

        }

        this.navigation.refresh();
        return true;

    }

    abandonReplaceableRoute(context) {

        const { actor } = context;

        if (context.interaction.exitCommitted) {

            // Losing this path would strand the actor between an interaction
            // and the graph. Preserve the committed exit; once clearance is
            // restored, the existing route or retry loop can continue it.
            context.wait.collisionElapsed = 0;
            context.recovery.elapsed = 0;

            if (actor.navigation.hasPath()) actor.resume();
            else actor.pause();

            return false;

        }

        this.navigation.cancelClosedLoop(context, "navigation-recovery");

        if (context.interaction.active) {

            // The attempted next task may be replaceable, but the interaction
            // physically occupied right now is not. Cancel only the pending
            // departure and let the controller make another decision later.
            this.traffic.cancel(actor);
            this.interactionTraffic.releaseReservations(actor);
            this.navigation.trafficState.releaseReservations(actor);
            this.navigation.routeGeometry.clearActiveLaneCurve(actor);
            this.collisionFailsafe.cancel(actor);
            actor.navigation.clearRoute();
            actor.locomotion.resetCurve();

            context.intent.position = null;
            context.intent.interaction = null;
            context.intent.destinationId = null;
            context.intent.deferredCommand = null;
            context.turnaround.active = false;
            context.traversal.laneCurve = false;
            context.traversal.interactionCurve = false;
            context.wait.retryElapsed = 0;
            context.recovery.elapsed = 0;
            context.wait.collisionElapsed = 0;
            context.recovery.position.copy(actor.object3D.position);
            actor.setState(EntityState.IDLE);
            this.navigation.refresh();
            return true;

        }

        const rejectedPoint = context.intent.interaction?.point ?? null;

        actor.navigationAvoidInteractionPoint = rejectedPoint;
        actor.navigationAvoidInteractionPointId = rejectedPoint?.id ?? null;

        this.traffic.cancel(actor);
        this.interactionTraffic.releaseReservations(actor);
        this.navigation.trafficState.releaseReservations(actor);
        this.navigation.routeGeometry.clearActiveLaneCurve(actor);
        this.collisionFailsafe.cancel(actor);
        actor.navigation.clearRoute();
        actor.locomotion.resetCurve();

        context.intent.position = null;
        context.intent.interaction = null;
        context.intent.destinationId = null;
        context.intent.deferredCommand = null;
        context.turnaround.active = false;
        context.traversal.laneCurve = false;
        context.traversal.interactionCurve = false;
        context.wait.retryElapsed = 0;
        context.recovery.elapsed = 0;
        context.wait.collisionElapsed = 0;
        context.recovery.position.copy(actor.object3D.position);
        actor.setState(EntityState.IDLE);

        return true;

    }

    recoverOrphanedActor(context, delta) {

        const { actor } = context;
        const hasOwner = Boolean(
            actor.navigation.hasPath() ||
            context.intent.position ||
            context.intent.interaction ||
            context.intent.deferredCommand ||
            context.interaction.active ||
            context.intent.closedLoop ||
            this.traffic.isQueued(actor) ||
            context.turnaround.active ||
            context.interaction.entering ||
            context.interaction.leaving
        );

        if (!actor.isState(EntityState.WAITING) || hasOwner) {

            context.recovery.orphanedElapsed = 0;
            return false;

        }

        context.recovery.orphanedElapsed += delta;

        if (context.recovery.orphanedElapsed < 0.5) return false;

        context.recovery.orphanedElapsed = 0;
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
        this.interactionTraffic.releaseReservations(actor);
        this.navigation.trafficState.releaseReservations(actor);
        this.navigation.routeGeometry.clearActiveLaneCurve(actor);
        actor.navigation.clearRoute();
        actor.setState(EntityState.WAITING);
        context.traversal.laneCurve = false;
        context.traversal.interactionCurve = false;
        context.wait.retryElapsed = 0;
        this.navigation.refresh();

    }

    restartIntentFromNearestAccess(context) {

        this.navigation.metrics.increment("routeRecoveries");

        const { actor } = context;
        const interactionIntent = context.intent.interaction
            ? { ...context.intent.interaction }
            : null;
        const positionIntent = context.intent.position?.clone() ?? null;

        if (interactionIntent && this.navigation.isActorAtInteractionPoint(
            actor,
            interactionIntent.point
        )) {

            console.log(
                `[NavigationRecovery] ${actor.name} was already at ` +
                `"${interactionIntent.point.id}"; completing arrival locally.`
            );
            return this.navigation.completeInteractionAtCurrentPosition(
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
        this.navigation.trafficState.releaseAgent(actor);
        this.interactionTraffic.releaseAgent(actor);
        this.traffic.cancel(actor);
        this.navigation.routeGeometry.clearActiveLaneCurve(actor);
        actor.navigation.cancel();
        actor.navigation.setCurrentNode(null);

        context.intent.position = null;
        context.intent.destinationId = null;
        context.intent.interaction = null;
        context.traversal.interactionPoint = null;
        context.traversal.laneCurve = false;
        context.traversal.interactionCurve = false;
        context.traversal.transitTangent = null;
        context.traversal.arrivalFromNodeId = null

        const origin = [...this.graph.nodes.values()]
            .filter(node =>
                !node.blocked &&
                [...node.connections.values()].some(connection =>
                    !connection.blocked
                ) &&
                (!node.exclusive ||
                    this.navigation.trafficState.isNodeAvailable(
                        node.id,
                        actor
                    ))
            )
            .sort((first, second) =>
                this.navigation.routeGeometry.getPlanarDistanceSquared(
                    actor.object3D.position,
                    first.position
                ) -
                this.navigation.routeGeometry.getPlanarDistanceSquared(
                    actor.object3D.position,
                    second.position
                )
            )[0];

        let accepted = false;

        if (origin) {

            actor.navigation.setCurrentNode(origin.id);
            this.navigation.trafficState.occupyNode(origin.id, actor);

            accepted = interactionIntent
                ? this.navigation.moveToInteractionPoint(
                    actor,
                    interactionIntent.point,
                    interactionIntent.onArrive,
                    { skipTurnaround: true }
                )
                : positionIntent
                    ? this.navigation.moveToClosestNode(actor, positionIntent, {
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
            context.intent.position = positionIntent;
            context.intent.interaction = interactionIntent;
            context.intent.destinationId = null;
            context.wait.retryElapsed = 0;
            actor.setState(EntityState.WAITING);
            console.log(
                `[NavigationRecovery] ${actor.name} still intends to reach ` +
                `its target and will retry.`
            );
            return false;

        }

        // An autonomous controller may abandon the task and choose another.
        context.intent.position = null;
        context.intent.interaction = null;
        context.intent.destinationId = null;
        actor.cancel();
        console.log(
            `[NavigationRecovery] ${actor.name} could not recover; ` +
            `the old target was abandoned.`
        );
        return false;

    }

    abandonBlockedIntent(context) {

        if (context.actor.navigationIntentPolicy === "persistent") {

            // A hard block has no known release time. Keep the Player command
            // pending instead of converting a navigation condition into a
            // silent input failure. Topology changes and the retry loop will
            // rebuild the route when it becomes possible again.
            context.wait.blockedElapsed = null;
            context.wait.retryElapsed = 0;
            context.actor.setState(EntityState.WAITING);
            this.navigation.trafficState.releaseReservations(context.actor);
            this.interactionTraffic.releaseReservations(context.actor);
            console.log(
                `[Navigation] ${context.actor.name} keeps its blocked intent ` +
                `and will retry.`
            );
            return;

        }

        context.intent.position = null;
        context.intent.destinationId = null;
        context.intent.interaction = null;
        context.interaction.entering = false;
        context.recovery.pending = true;
        this.navigation.trafficState.releaseReservations(context.actor);
        this.interactionTraffic.releaseReservations(context.actor);
        console.log(
            `[Navigation] ${context.actor.name} abandoned a blocked intent.`
        );
        this.tryRecoverToNearestNode(context);

    }

    tryRecoverToNearestNode(context) {

        this.navigation.metrics.increment("routeRecoveries");

        const { actor } = context;
        const traversal = actor.navigation.getTraversalState();

        if (traversal.currentNodeId) {

            const current = this.graph.requireNode(traversal.currentNodeId);

            if (!current.blocked) {

                context.recovery.pending = false;
                actor.cancel();
                this.navigation.helper?.highlightNode(current.id);
                return true;

            }

            const path = this.navigation.pathfinder.findNearestAvailablePath(
                current.id,
                actor
            );

            if (!path) return false;

            const destinationId = path.nodeIds.at(-1);

            context.recovery.pending = false;
            context.intent.destinationId = destinationId;
            this.navigation.helper?.highlightNode(destinationId);
            actor.followWaypoints(
                this.navigation.createTraversalWaypoints(context, path.nodeIds)
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
                !node.blocked &&
                this.navigation.trafficState.isNodeAvailable(node.id, actor)
            )
            .sort((first, second) =>
                this.navigation.routeGeometry.getPlanarDistanceSquared(
                    actor.object3D.position,
                    first.position
                ) -
                this.navigation.routeGeometry.getPlanarDistanceSquared(
                    actor.object3D.position,
                    second.position
                )
            )[0];

        if (!endpoint) return false;

        context.recovery.pending = false;
        context.intent.destinationId = endpoint.id;
        this.navigation.trafficState.reserveNode(endpoint.id, actor);
        this.navigation.helper?.highlightNode(endpoint.id);
        actor.followWaypoints(
            this.navigation.createTraversalWaypoints(context, [endpoint.id])
        );

        return true;

    }

}
