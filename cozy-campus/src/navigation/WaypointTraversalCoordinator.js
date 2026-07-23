import { AnimationPresets } from "../core/AnimationPresets";
import { EntityState } from "../core/EntityState";
import { Tween } from "../core/Tween";
import { WaitReason } from "./WaitReason";

// Finaliza travessias já autorizadas. Planejamento e reserva acontecem antes;
// este coordenador transforma a chegada física em ocupação, liberação e fase.
export class WaypointTraversalCoordinator {

    constructor(navigation) {

        this.navigation = navigation;

    }

    canAcceptArrival(context, waypoint, completedConnection) {

        if (!completedConnection || !waypoint?.id) return true;

        const nav = this.navigation;
        const { actor } = context;
        nav.traffic.claimPhysicalArrival(waypoint.id, actor);

        if (!nav.traffic.hasArrivalGrant(waypoint.id, actor)) {
            nav.traffic.setWaitReason(
                actor,
                waypoint.id,
                WaitReason.ENDPOINT_WAIT
            );
            return false;
        }

        if (!nav.traffic.canCrossNode(waypoint.id, actor)) {
            nav.traffic.setWaitReason(
                actor,
                waypoint.id,
                WaitReason.NODE_OCCUPIED
            );
            return false;
        }

        return true;

    }

    rejectInvalidSegment(actor, fromId, toId) {

        const nav = this.navigation;
        const context = nav.requireContext(actor);

        console.log(
            `[Navigation] ${actor.name} discarded stale segment ` +
            `"${fromId}" -> "${toId}".`
        );

        actor.cancel();
        actor.setState(EntityState.WAITING);
        context.wait.retryElapsed = 0;

        // A intenção permanece; o retry normal recalcula a rota a partir da
        // posição topológica real do ator.
        nav.refresh();

    }

    handleReached(context, waypoint, completedConnection) {

        const nav = this.navigation;
        const { actor } = context;
        const interactionResult = nav.interactions.handleWaypoint(
            context,
            waypoint
        );

        if (interactionResult === "waiting") return false;
        if (interactionResult) return;
        if (!waypoint.id) return;

        if (context.traversal.interactionPoint) {
            nav.leaveInteractionPoint(context);
        }

        const isFinalRouteWaypoint =
            actor.navigation.getNextWaypoint() === null;
        const reachedDestination =
            waypoint.id === context.intent.destinationId ||
            (
                actor.navigationIntentPolicy !== "persistent" &&
                isFinalRouteWaypoint &&
                context.intent.position !== null &&
                context.intent.interaction === null
            );

        if (reachedDestination && waypoint.id !== context.intent.destinationId) {
            console.log(
                `[NavigationRecovery] ${actor.name} treats final waypoint ` +
                `"${waypoint.id}" as its destination after intent ` +
                `synchronization was lost.`
            );
        }

        if (completedConnection) {

            context.traversal.laneCurve = false;
            nav.routeGeometry.clearActiveLaneCurve(actor);
            context.traversal.arrivalFromNodeId = completedConnection.fromId;
            context.traversal.kind = "flat";
            actor.traversalType = "flat";
            nav.trafficState.releaseConnection(
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

        const crossing = !reachedDestination &&
            actor.navigation.getNextWaypoint() !== null;

        if (!nav.trafficState.occupyNode(waypoint.id, actor, { crossing })) {

            actor.setState(EntityState.WAITING);
            console.log(
                `[NavigationReservation] ${actor.name} reached ` +
                `"${waypoint.id}" but waits for its reservation to become ` +
                `occupiable.`
            );
            nav.refresh();
            return false;

        }

        nav.traffic.completeNodeArrival(waypoint.id, actor);

        if (context.intent.closedLoop?.phase === "entering" &&
            waypoint.id === context.intent.closedLoop.entryNodeId) {
            context.intent.position = null;
            context.intent.destinationId = null;
            context.wait.retryElapsed = 0;
            nav.startClosedLoopPriming(context);
            nav.refresh();
            return;
        }

        if (waypoint.closedLoopPrimingEnd &&
            context.intent.closedLoop?.phase === "priming") {

            const loop = context.intent.closedLoop;
            loop.nodeIds = [
                ...loop.nodeIds.slice(1),
                loop.nodeIds[0]
            ];
            loop.entryNodeId = waypoint.id;
            loop.primingTargetId = null;
            nav.startClosedLoopLap(context);
            nav.refresh();
            return;

        }

        if (waypoint.closedLoopLapEnd && context.intent.closedLoop) {
            nav.completeClosedLoopLap(context, waypoint);
            nav.refresh();
            return;
        }

        if (reachedDestination) {

            context.intent.position = null;
            context.intent.destinationId = null;
            actor.setState(EntityState.IDLE);

            console.warn(
                `[Navigation] "${waypoint.id}" was used as a terminal ` +
                `destination. Navigation nodes must only be used for transit.`
            );

            nav.trafficState.releaseNode(waypoint.id, actor);
            actor.navigation.setCurrentNode(waypoint.id);

        } else {
            actor.setState(EntityState.WALKING);
        }

        nav.refresh();

    }

}
