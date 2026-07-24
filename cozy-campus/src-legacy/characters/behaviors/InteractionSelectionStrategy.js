// Scores already-enumerated interactions. Lower scores are preferred.
// `utility` is intentionally open-ended: a future task planner can express
// hunger, schedule, quest priority or social intent without teaching this
// strategy what "sit", "work" or "talk" means.
export class InteractionSelectionStrategy {

    constructor({
        pathWeight = 0.50,
        congestionWeight = 0.20,
        repetitionWeight = 0.15,
        variationWeight = 0.15
    } = {}) {

        this.weights = {
            path: pathWeight,
            congestion: congestionWeight,
            repetition: repetitionWeight,
            variation: variationWeight
        };

    }

    rank({ actor, candidates, memory, evaluate }) {

        const decisionIndex = memory.beginDecision();
        const evaluated = candidates
            .filter(candidate => !memory.isCoolingDown(candidate))
            .map(candidate => {

                const navigation = evaluate(candidate);

                if (!navigation?.reachable) return null;

                return {
                    ...candidate,
                    navigation,
                    pathCost: navigation.pathCost,
                    congestion: Math.max(
                        navigation.congestion ?? 0,
                        navigation.waitPenalty ?? 0
                    ),
                    repetition: memory.getRepetitionPenalty(candidate),
                    variation: this.getDeterministicVariation(
                        actor,
                        candidate,
                        decisionIndex
                    ),
                    utility: candidate.definition.getUtility({
                        actor,
                        target: candidate.target,
                        definition: candidate.definition,
                        point: candidate.point,
                        navigation,
                        memory
                    })
                };

            })
            .filter(Boolean);

        if (evaluated.length === 0) return [];

        const costs = evaluated.map(candidate => candidate.pathCost);
        const minimumCost = Math.min(...costs);
        const maximumCost = Math.max(...costs);
        const costRange = maximumCost - minimumCost;

        for (const candidate of evaluated) {

            candidate.normalizedPathCost = costRange > 0
                ? (candidate.pathCost - minimumCost) / costRange
                : 0;
            candidate.score =
                candidate.normalizedPathCost * this.weights.path +
                candidate.congestion * this.weights.congestion +
                candidate.repetition * this.weights.repetition +
                candidate.variation * this.weights.variation -
                candidate.utility;

        }

        return evaluated.sort((first, second) =>
            first.score - second.score ||
            first.definition.id.localeCompare(second.definition.id)
        );

    }

    getDeterministicVariation(actor, candidate, decisionIndex) {

        const input = `${actor.name}:${candidate.definition.id}:` +
            `${candidate.point.id}:${decisionIndex}`;
        let hash = 2166136261;

        for (let index = 0; index < input.length; index++) {
            hash ^= input.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }

        return (hash >>> 0) / 0xffffffff;

    }

}
