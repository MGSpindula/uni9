export class UseAvailableInteractionBehavior {

    constructor({
        interactionSystem,
        tags = []
    }) {

        this.interactionSystem =
            interactionSystem;

        this.tags = [...tags];

    }

    tryStart(
        actor,
        {
            excludePoint = null
        } = {}
    ) {

        return this.interactionSystem
            .request({
                actor,
                tags:
                    this.tags,

                excludePoint
            });

    }

    isActive(actor) {

        return this.interactionSystem
            .isActorUsingTarget(actor);

    }

}