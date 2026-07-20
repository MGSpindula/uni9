import {
    InteractionQuery
} from "./interactions/InteractionQuery";

export class InteractionSystem {

    constructor() {

        this.actorNavigators =
            new Map();

        this.targets =
            new Set();

        this.query =
            new InteractionQuery(
                this.targets
            );

    }

    registerActor(actor, navigate) {

        if (!actor) {

            throw new Error(
                "InteractionSystem.registerActor " +
                "requires an actor."
            );

        }

        if (
            typeof navigate !==
            "function"
        ) {

            throw new Error(
                `Actor "${actor.name}" ` +
                `requires a navigation adapter.`
            );

        }

        this.actorNavigators.set(
            actor,
            navigate
        );

    }

    unregisterActor(actor) {

        this.actorNavigators.delete(
            actor
        );

    }

    registerTarget(target) {

        if (!target) return false;

        const definitions =
            target
                .getInteractionDefinitions?.() ??
            [];

        if (
            definitions.length === 0
        ) {

            return false;

        }

        this.targets.add(target);

        return true;

    }

    unregisterTarget(target) {

        this.targets.delete(target);

    }

    find(request) {

        return this.query.findNearest({
            actor:
                request.actor,

            target:
                request.target ?? null,

            interactionId:
                request.interactionId ??
                null,

            tags:
                request.tags ?? [],

            available:
                true,

            excludePoint:
                request.excludePoint ??
                null
        });

    }

    request(request) {

        const actor =
            request?.actor;

        if (!actor) {

            return false;

        }

        const navigate =
            this.actorNavigators.get(
                actor
            );

        if (!navigate) {

            console.log(
                `[InteractionSystem] ` +
                `"${actor.name}" has no ` +
                `navigation adapter.`
            );

            return false;

        }

        const match =
            this.find(request);

        if (!match) {

            return false;

        }

        const {
            target,
            definition,
            point
        } = match;

        const onArrive = () => {

            const context = {
                actor,
                target,
                definition,
                point
            };

            if (
                !definition.canExecute(
                    context
                )
            ) {

                return false;

            }

            return definition.execute(
                context
            );

        };

        return navigate({
            point,
            onArrive
        });

    }

    dispose() {

        this.actorNavigators.clear();
        this.targets.clear();

    }

}