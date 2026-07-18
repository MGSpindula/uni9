import {
    EntityState
} from "../core/EntityState";

export class NPCController {

    constructor({
        npc,
        navigationSystem,
        interactionBehavior
    }) {

        this.npc = npc;

        this.navigationSystem =
            navigationSystem;

        this.interactionBehavior =
            interactionBehavior;

        this.elapsed = 0;

        this.actionDuration = 5;
        this.retryDuration = 2;

        this.nextDecisionIn = 0;

    }

    update(delta) {

        if (
            this.npc.isState(
                EntityState.WALKING
            ) ||
            this.npc.isState(
                EntityState.WAITING
            ) ||
            this.npc.isState(
                EntityState.STOPPING
            )
        ) {

            return;

        }

        this.elapsed += delta;

        const activePoint =
            this.navigationSystem
                .getOccupiedInteractionPoint(
                    this.npc
                );

        if (activePoint) {

            if (
                this.elapsed <
                this.actionDuration
            ) {

                return;

            }

            this.elapsed = 0;

            this.tryChooseAction({
                excludePoint:
                    activePoint
            });

            return;

        }

        if (
            this.elapsed <
            this.nextDecisionIn
        ) {

            return;

        }

        this.elapsed = 0;

        this.tryChooseAction();

    }

    tryChooseAction({
        excludePoint = null
    } = {}) {

        const accepted =
            this.interactionBehavior
                .tryStart(
                    this.npc,
                    {
                        excludePoint
                    }
                );

        this.nextDecisionIn =
            accepted
                ? 0
                : this.retryDuration;

        return accepted;

    }

}