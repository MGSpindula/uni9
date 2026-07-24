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

    registerActor(actor, adapter) {

        if (!actor) {

            throw new Error(
                "InteractionSystem.registerActor " +
                "requires an actor."
            );

        }

        const normalized = typeof adapter === "function"
            ? { navigate: adapter, evaluate: null }
            : adapter;

        if (typeof normalized?.navigate !== "function") {

            throw new Error(
                `Actor "${actor.name}" ` +
                `requires a navigation adapter.`
            );

        }

        this.actorNavigators.set(
            actor,
            normalized
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
                null,

            excludePoints:
                request.excludePoints ??
                [],

            excludePointIds:
                request.excludePointIds ??
                []
        });

    }

    findCandidates(request) {

        return this.query.findCandidates({
            actor: request.actor,
            target: request.target ?? null,
            interactionId: request.interactionId ?? null,
            tags: request.tags ?? [],
            available: true,
            includeTemporarilyUnavailable:
                request.includeTemporarilyUnavailable ?? false,
            excludePoint: request.excludePoint ?? null,
            excludePoints: request.excludePoints ?? [],
            excludePointIds: request.excludePointIds ?? []
        });

    }

    evaluate(actor, candidate) {

        const adapter = this.actorNavigators.get(actor);

        return adapter?.evaluate?.(candidate) ?? {
            reachable: true,
            pathCost: Math.sqrt(candidate.distanceSquared),
            congestion: candidate.temporarilyAvailable ? 0 : 1,
            waitPenalty: 0
        };

    }

    request(request) {

        const actor =
            request?.actor;

        if (!actor) {

            return false;

        }

        const adapter =
            this.actorNavigators.get(
                actor
            );

        if (!adapter) {

            console.log(
                `[InteractionSystem] ` +
                `"${actor.name}" has no ` +
                `navigation adapter.`
            );

            return false;

        }

        const match = request.match ?? this.find(request);

        if (!match) {

            return false;

        }

        return this.requestMatch(actor, match, request);

    }

    requestMatch(actor, match, request = {}) {

        const adapter = this.actorNavigators.get(actor);

        if (!adapter || !match) return false;

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

        const accepted = adapter.navigate({
            point,
            onArrive
        });

        if (accepted) request.onAccepted?.(match);

        return accepted;

    }

    dispose() {

        this.actorNavigators.clear();
        this.targets.clear();

    }

}
