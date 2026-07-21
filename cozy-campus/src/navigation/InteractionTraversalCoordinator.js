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
        this.traffic = navigation.traffic;
        this.interactions = navigation.interactions;

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

                this.navigation.executeDeferredCommand(context, {
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
                this.navigation.executeDeferredCommand(context, {
                    skipInteractionExit: true
                });

            }
        );

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

    completeInteractionAtCurrentPosition(context, point, onArrive) {

        const { actor } = context;

        this.traffic.cancel(actor);
        this.navigation.trafficState.releaseReservations(actor);
        this.connector.releaseReservations(actor);
        this.navigation.routeGeometry.clearActiveLaneCurve(actor);
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

        this.navigation.refresh();
        return true;

    }

}
