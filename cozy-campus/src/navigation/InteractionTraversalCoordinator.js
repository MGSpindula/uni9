import { EntityState } from "../core/EntityState";
import { AnimationPresets } from "../core/AnimationPresets";
import { Tween } from "../core/Tween";

// Coordena a transação física de entrada/saída de InteractionPoints. Enquanto
// uma saída está committed, a ocupação só é liberada depois do onComplete.
export class InteractionTraversalCoordinator {

    constructor(navigation) {

        this.navigation = navigation;
        this.graph = navigation.graph;
        this.connector = navigation.connector;
        this.interactionTraffic = navigation.interactionTraffic;
        this.traffic = navigation.traffic;
        this.interactions = navigation.interactions;

    }

    beginInteractionExit(
        context,
        command
    ) {

        if (
            context.interaction.leaving
        ) {

            context.intent.deferredCommand =
                command;

            return;

        }

        if (
            context.interaction.exitCommitted
        ) {

            context.intent.deferredCommand =
                command;

            if (
                !context.actor.navigation
                    .hasPath()
            ) {

                this.navigation
                    .executeDeferredCommand(
                        context,
                        {
                            skipInteractionExit:
                                true
                        }
                    );

            }

            return;

        }

        const actor =
            context.actor;

        const interaction =
            context.interaction.active;

        const actionPoint =
            interaction.point;

        const approachPoint =
            actionPoint.via ??
            actionPoint;

        const requiresApproachReservation =
            approachPoint !== actionPoint;

        const exitWaypoints =
            this.connector
                .createExitWaypoints(
                    actionPoint,
                    command.originId,
                    {
                        nextNodeId:
                            command.nextNodeId ??
                            null
                    }
                );

        const trafficWaypoint =
            exitWaypoints.find(
                waypoint =>
                    waypoint.connectionEntry ||
                    waypoint.nodeEntry
            ) ??
            null;

        const trafficEntry =
            trafficWaypoint
                ?.connectionEntry ??
            trafficWaypoint
                ?.nodeEntry ??
            null;

        context.intent.deferredCommand =
            command;

        actor.pause();

        /*
         * Reserva primeiro o ApproachPoint.
         *
         * O ActionPoint permanece ocupado pelo
         * ator durante todo o preflight.
         */
        if (
            requiresApproachReservation &&
            context.traversal
                .interactionExitPoint !==
            approachPoint
        ) {

            if (
                !this.interactionTraffic
                    .reservePoint(
                        approachPoint,
                        actor
                    )
            ) {

                context.wait.retryElapsed =
                    0;

                return;

            }

            /*
             * interactionExitPoint representa
             * tanto uma reserva quanto uma
             * ocupação do staging point.
             *
             * releasePoint() limpa ambas.
             */
            context.traversal
                .interactionExitPoint =
                approachPoint;

        }

        /*
         * Depois reserva lane ou nodeEntry.
         *
         * Se falhar, desfaz a reserva do Approach,
         * mas não libera o ActionPoint ocupado.
         */
        if (
            !this.traffic
                .preflightInteractionExit(
                    actor,
                    trafficEntry
                )
        ) {

            if (
                requiresApproachReservation &&
                context.traversal
                    .interactionExitPoint ===
                approachPoint
            ) {

                this.interactionTraffic
                    .releasePoint(
                        approachPoint,
                        actor
                    );

                context.traversal
                    .interactionExitPoint =
                    null;

            }

            context.wait.retryElapsed =
                0;

            return;

        }

        context.interaction
            .exitCommitted =
            true;

        context.interaction
            .leaving =
            true;

        context.interaction
            .exitElapsed =
            0;

        interaction.target
            ?.prepareInteractionExit(
                actor,
                actionPoint,
                approachPoint,
                () => {

                    if (
                        !context.interaction
                            .leaving
                    ) {

                        return;

                    }

                    context.interaction
                        .leaving =
                        false;

                    context.interaction
                        .exitElapsed =
                        0;

                    this.navigation
                        .executeDeferredCommand(
                            context,
                            {
                                skipInteractionExit:
                                    true
                            }
                        );

                }
            );

    }

    completeInteractionExit(context) {

        this.leaveInteractionPoint(context);
        this.releaseInteractionExitPoint(context);
        context.interaction.exitCommitted = false;

    }

    finishActiveInteraction(context) {

        const interaction = context.interaction.active;

        if (!interaction) return;

        interaction.target?.endInteraction(
            context.actor,
            interaction.point
        );
        context.interaction.active = null;

    }

    leaveInteractionPoint(context) {

        if (!context.traversal.interactionPoint) return;

        if (context.interaction.active?.point === context.traversal.interactionPoint) {

            this.finishActiveInteraction(context);

        }

        this.interactionTraffic.releasePoint(
            context.traversal.interactionPoint,
            context.actor
        );

        context.traversal.interactionPoint = null;

    }

    releaseInteractionExitPoint(context) {

        if (!context.traversal.interactionExitPoint) return;

        this.interactionTraffic.releasePoint(
            context.traversal.interactionExitPoint,
            context.actor
        );

        context.traversal.interactionExitPoint = null;

    }

    completeInteractionAtCurrentPosition(context, point, onArrive) {

        const { actor } = context;

        this.traffic.cancel(actor);
        this.navigation.trafficState.releaseReservations(actor);
        this.interactionTraffic.releaseReservations(actor);
        this.navigation.routeGeometry.clearActiveLaneCurve(actor);
        actor.navigation.clearRoute();
        actor.locomotion.resetCurve();

        context.intent.position = null;
        context.intent.destinationId = null;
        context.intent.interaction = { point, onArrive };
        context.intent.deferredCommand = null;
        context.traversal.laneCurve = false;
        context.traversal.interactionCurve = false;
        context.recovery.elapsed = 0;
        context.recovery.position.copy(actor.object3D.position);

        this.interactions.handleWaypoint(context, {
            id: null,
            position: point.getWorldPosition(),
            interactionPoint: point
        });

        this.navigation.refresh();
        return true;

    }

}
