export class InteractionIntent {

    constructor({
        actor,
        target = null,
        interactionId = null,
        tags = []
    }) {

        if (!actor) {

            throw new Error(
                "InteractionIntent requires an actor."
            );

        }

        this.type = "INTERACT";

        this.actor = actor;
        this.target = target;
        this.interactionId = interactionId;
        this.tags = [...tags];

    }

}