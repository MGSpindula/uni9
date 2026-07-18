import { InteractionPlan } from "./InteractionPlan";
import { MoveToInteractionAction } from "./actions/MoveToInteractionAction";
import { EnterInteractionAction } from "./actions/EnterInteractionAction";

export class InteractionPlanner {

    constructor(interactionQuery) {

        this.interactionQuery =
            interactionQuery;

    }

    plan(intent) {

        if (!intent ||
            intent.type !== "INTERACT") {

            return null;

        }

        const match =
            this.interactionQuery.findNearest({
                actor: intent.actor,
                target: intent.target,
                interactionId:
                    intent.interactionId,
                tags: intent.tags,
                available: true
            });

        if (!match) {

            return null;

        }

        return {
            target: match.target,
            definition: match.definition,
            point: match.point,

            plan: new InteractionPlan([
                new MoveToInteractionAction(
                    match.point
                ),
                new EnterInteractionAction(
                    match.definition
                )
            ])
        };

    }

}