import { InteractionSelectionStrategy } from "./InteractionSelectionStrategy";
import { ShortTermBehaviorMemory } from "./ShortTermBehaviorMemory";

// Chooses an interaction, but does not encode what that interaction means.
// A chair, conversation, work shift or multi-step task can all provide tags,
// utility, cooldown and repetitionKey through InteractionDefinition.
export class UseAvailableInteractionBehavior {

    constructor({
        interactionSystem,
        tags = [],
        strategy = new InteractionSelectionStrategy(),
        memoryOptions = {}
    }) {

        this.interactionSystem = interactionSystem;
        this.tags = [...tags];
        this.strategy = strategy;
        this.memoryOptions = { ...memoryOptions };
        this.memories = new WeakMap();

    }

    update(actor, delta) {

        this.getMemory(actor).update(delta);

    }

    getMemory(actor) {

        let memory = this.memories.get(actor);

        if (!memory) {
            memory = new ShortTermBehaviorMemory(this.memoryOptions);
            this.memories.set(actor, memory);
        }

        return memory;

    }

    tryStart(actor, { excludePoint = null } = {}) {

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

        // Compatibility for small external/test adapters that only implement
        // request(). The real InteractionSystem uses the scored candidate path.
        if (!this.interactionSystem.findCandidates) {
            const accepted = this.interactionSystem.request({
                actor,
                tags: this.tags,
                excludePoints,
                excludePointIds
            });

            if (accepted) {
                actor.navigationAvoidInteractionPoint = null;
                actor.navigationAvoidInteractionPointId = null;
            }

            return accepted;
        }

        const candidates = this.interactionSystem.findCandidates({
            actor,
            tags: this.tags,
            includeTemporarilyUnavailable: true,
            excludePoints,
            excludePointIds
        });
        const memory = this.getMemory(actor);
        const ranked = this.strategy.rank({
            actor,
            candidates,
            memory,
            evaluate: candidate =>
                this.interactionSystem.evaluate(actor, candidate)
        });

        for (const candidate of ranked) {

            const accepted = this.interactionSystem.request({
                actor,
                match: candidate,
                onAccepted: selected => {
                    memory.remember(selected, selected.definition.cooldown);
                }
            });

            if (!accepted) continue;

            actor.lastBehaviorDecision = {
                interactionId: candidate.definition.id,
                pointId: candidate.point.id,
                score: candidate.score,
                pathCost: candidate.pathCost,
                congestion: candidate.congestion,
                repetition: candidate.repetition,
                utility: candidate.utility
            };
            actor.navigationAvoidInteractionPoint = null;
            actor.navigationAvoidInteractionPointId = null;
            return true;

        }

        actor.lastBehaviorDecision = null;
        return false;

    }

}
