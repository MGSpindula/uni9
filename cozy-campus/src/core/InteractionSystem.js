import { InteractionIntent } from "./interactions/InteractionIntent";
import { InteractionQuery } from "./interactions/InteractionQuery";
import { InteractionPlanner } from "./interactions/InteractionPlanner";

export class InteractionSystem {

    constructor() {

        // Actor -> navigation adapter.
        this.actorNavigators = new Map();

        // Entities that offer InteractionDefinitions.
        this.targets = new Set();

        this.query =
            new InteractionQuery(
                this.targets
            );

        this.planner =
            new InteractionPlanner(
                this.query
            );

    }

    // -----------------------------
    // Actors
    // -----------------------------

    registerActor(actor, navigate) {

        if (!actor) {

            throw new Error(
                "InteractionSystem.registerActor requires an actor."
            );

        }

        if (typeof navigate !== "function") {

            throw new Error(
                `Actor "${actor.name}" requires a navigation adapter.`
            );

        }

        this.actorNavigators.set(
            actor,
            navigate
        );

    }

    unregisterActor(actor) {

        this.actorNavigators.delete(actor);

    }

    // -----------------------------
    // Targets
    // -----------------------------

    registerTarget(target) {

        if (!target) return;

        const definitions =
            target.getInteractionDefinitions?.() ?? [];

        if (definitions.length === 0) {

            return;

        }

        this.targets.add(target);

    }

    unregisterTarget(target) {

        this.targets.delete(target);

    }

    // -----------------------------
    // Intent execution
    // -----------------------------

    request(intentData) {

        const intent =
            intentData instanceof InteractionIntent
                ? intentData
                : new InteractionIntent(intentData);

        const navigate =
            this.actorNavigators.get(
                intent.actor
            );

        if (!navigate) {

            console.log(
                `[InteractionSystem] Actor ` +
                `"${intent.actor?.name ?? "unknown"}" ` +
                `has no navigation adapter.`
            );

            return false;

        }

        const result =
            this.planner.plan(intent);

        if (!result) {

            return false;

        }

        const context = {
            actor: intent.actor,
            target: result.target,
            definition: result.definition,
            point: result.point,
            intent,
            navigate
        };

        const accepted =
            result.plan.execute(context);

        return accepted !== false;

    }

    // -----------------------------
    // Runtime queries
    // -----------------------------

    findActiveInteraction(actor) {

        for (const target of this.targets) {

            if (!target.isInteractingWith?.(actor)) {

                continue;

            }

            return {
                actor,
                target
            };

        }

        return null;

    }

    dispose() {

        this.actorNavigators.clear();
        this.targets.clear();

    }

}