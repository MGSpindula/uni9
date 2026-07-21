import { EntityState } from "../core/EntityState";
import { WaitReason } from "./WaitReason";

// Recovery não escolhe comportamento novo. Ele preserva ou abandona a intenção
// conforme a política do ator e devolve o controle ao planner/controller.
export class NavigationRecoveryPolicy {

    constructor(navigation) {

        this.navigation = navigation;
        this.graph = navigation.graph;
        this.connector = navigation.connector;
        this.traffic = navigation.traffic;
        this.collisionFailsafe = navigation.collisionFailsafe;

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

        const context = this.navigation.requireContext(actor);

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
        this.navigation.trafficState.releaseReservations(actor);
        this.navigation.routeGeometry.clearActiveLaneCurve(actor);
        actor.navigation.clearRoute();
        actor.locomotion.resetCurve();
        context.traversingLaneCurve = false;
        context.traversingInteractionCurve = false;
        context.retryElapsed = 0;

        if (actor.navigationIntentPolicy === "persistent") {

            actor.setState(EntityState.WAITING);
            this.navigation.retryPreservedIntent(context, { maxDetourFactor: 6 });

        } else {

            // Autonomous actors may abandon one ambient action. Their
            // controller receives IDLE and chooses a new task next update.
            this.abandonReplaceableRoute(context);

        }

        this.navigation.refresh();
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

        this.navigation.cancelClosedLoop(context, "navigation-recovery");

        if (context.activeInteraction) {

            // The attempted next task may be replaceable, but the interaction
            // physically occupied right now is not. Cancel only the pending
            // departure and let the controller make another decision later.
            this.traffic.cancel(actor);
            this.connector.releaseReservations(actor);
            this.navigation.trafficState.releaseReservations(actor);
            this.navigation.routeGeometry.clearActiveLaneCurve(actor);
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
            this.navigation.refresh();
            return true;

        }

        const rejectedPoint = context.pendingInteraction?.point ?? null;

        actor.navigationAvoidInteractionPoint = rejectedPoint;
        actor.navigationAvoidInteractionPointId = rejectedPoint?.id ?? null;

        this.traffic.cancel(actor);
        this.connector.releaseReservations(actor);
        this.navigation.trafficState.releaseReservations(actor);
        this.navigation.routeGeometry.clearActiveLaneCurve(actor);
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
            context.closedLoop ||
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
        this.navigation.trafficState.releaseReservations(actor);
        this.navigation.routeGeometry.clearActiveLaneCurve(actor);
        actor.navigation.clearRoute();
        actor.setState(EntityState.WAITING);
        context.traversingLaneCurve = false;
        context.traversingInteractionCurve = false;
        context.retryElapsed = 0;
        this.navigation.refresh();

    }

    restartIntentFromNearestAccess(context) {

        const { actor } = context;
        const interactionIntent = context.pendingInteraction
            ? { ...context.pendingInteraction }
            : null;
        const positionIntent = context.pendingPosition?.clone() ?? null;

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
        this.connector.releaseAgent(actor);
        this.traffic.cancel(actor);
        this.navigation.routeGeometry.clearActiveLaneCurve(actor);
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

    abandonBlockedIntent(context) {

        if (context.actor.navigationIntentPolicy === "persistent") {

            // A hard block has no known release time. Keep the Player command
            // pending instead of converting a navigation condition into a
            // silent input failure. Topology changes and the retry loop will
            // rebuild the route when it becomes possible again.
            context.blockedElapsed = null;
            context.retryElapsed = 0;
            context.actor.setState(EntityState.WAITING);
            this.navigation.trafficState.releaseReservations(context.actor);
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
        this.navigation.trafficState.releaseReservations(context.actor);
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
                this.navigation.helper?.highlightNode(current.id);
                return true;

            }

            const path = this.navigation.pathfinder.findNearestAvailablePath(
                current.id,
                actor
            );

            if (!path) return false;

            const destinationId = path.nodeIds.at(-1);

            context.recoveryPending = false;
            context.destinationId = destinationId;
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

        context.recoveryPending = false;
        context.destinationId = endpoint.id;
        this.navigation.trafficState.reserveNode(endpoint.id, actor);
        this.navigation.helper?.highlightNode(endpoint.id);
        actor.followWaypoints(
            this.navigation.createTraversalWaypoints(context, [endpoint.id])
        );

        return true;

    }

}
