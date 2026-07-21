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

        const temporarilyRejected =
            actor.navigationAvoidInteractionPoint ?? null;
        const excludePoints = [
            excludePoint,
            temporarilyRejected
        ].filter(Boolean);
        const excludePointIds = [
            excludePoint?.id,
            actor.navigationAvoidInteractionPointId
        ].filter(Boolean);
        const accepted = this.interactionSystem
            .request({
                actor,
                tags:
                    this.tags,

                excludePoints,
                excludePointIds
            });

        // Once another valid activity has been selected, the old point may be
        // considered again in a later behavior cycle. When no alternative
        // exists, the NPC stays IDLE and retries without occupying a queue.
        if (accepted) {

            actor.navigationAvoidInteractionPoint = null;
            actor.navigationAvoidInteractionPointId = null;

        }

        return accepted;

    }

}
