// Small per-actor episodic memory. It is deliberately independent from any
// concrete activity such as sit/lean: tasks may share a repetitionKey even
// when they use different InteractionDefinitions and destinations.
export class ShortTermBehaviorMemory {

    constructor({ historyDuration = 45, maximumEntries = 12 } = {}) {

        this.historyDuration = historyDuration;
        this.maximumEntries = maximumEntries;
        this.time = 0;
        this.decisionIndex = 0;
        this.recentInteractions = [];
        this.cooldowns = new Map();

    }

    update(delta) {

        this.time += delta;
        const oldest = this.time - this.historyDuration;

        this.recentInteractions = this.recentInteractions
            .filter(entry => entry.time >= oldest);

        for (const [key, expiresAt] of this.cooldowns) {
            if (expiresAt <= this.time) this.cooldowns.delete(key);
        }

    }

    beginDecision() {

        return this.decisionIndex++;

    }

    remember(candidate, cooldown = 0) {

        const entry = {
            id: candidate.definition.id,
            pointId: candidate.point.id,
            repetitionKey: candidate.definition.repetitionKey,
            time: this.time
        };

        this.recentInteractions.unshift(entry);
        this.recentInteractions.length = Math.min(
            this.recentInteractions.length,
            this.maximumEntries
        );

        if (cooldown > 0) {
            this.cooldowns.set(candidate.definition.id, this.time + cooldown);
        }

    }

    isCoolingDown(candidate) {

        return (this.cooldowns.get(candidate.definition.id) ?? 0) > this.time;

    }

    getRepetitionPenalty(candidate) {

        let penalty = 0;

        for (const entry of this.recentInteractions) {

            const age = this.time - entry.time;
            const recency = Math.max(0, 1 - age / this.historyDuration);

            if (entry.id === candidate.definition.id) {
                penalty = Math.max(penalty, recency);
            } else if (entry.repetitionKey ===
                candidate.definition.repetitionKey) {
                penalty = Math.max(penalty, recency * 0.6);
            }

        }

        return penalty;

    }

}
