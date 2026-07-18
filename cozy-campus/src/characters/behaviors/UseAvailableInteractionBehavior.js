import { InteractionIntent } from "../../core/interactions/InteractionIntent";

export class UseAvailableInteractionBehavior {

    constructor({
        interactionSystem,
        tags = []
    }) {

        this.interactionSystem =
            interactionSystem;

        this.tags = [...tags];

    }

    findTarget(actor) {

        return this.interactionSystem
            .query
            .findNearest({
                actor,
                tags: this.tags,
                available: true
            });

    }

    tryStart(actor) {

        const match =
            this.findTarget(actor);

        if (!match) {

            return false;

        }

        const intent =
            new InteractionIntent({
                actor,
                target: match.target,
                interactionId:
                    match.definition.id,
                tags: this.tags
            });

        return this.interactionSystem.request(
            intent
        );

    }

    isActive(actor) {

        return Boolean(
            this.interactionSystem
                .findActiveInteraction(actor)
        );

    }

}