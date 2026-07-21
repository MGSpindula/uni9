export class InteractionDefinition {

    constructor({
        id,
        tags = [],
        point,
        requirements = [],
        available = null,
        execute = null,
        utility = 0,
        cooldown = 8,
        repetitionKey = null,
        metadata = {}
    }) {

        if (!id) {

            throw new Error(
                "InteractionDefinition requires an id."
            );

        }

        if (!point) {

            throw new Error(
                `InteractionDefinition "${id}" ` +
                `requires an InteractionPoint.`
            );

        }

        if (!point.terminal) {

            throw new Error(
                `InteractionDefinition "${id}" ` +
                `cannot use a non-terminal ` +
                `approach point.`
            );

        }

        this.id = id;

        this.tags =
            new Set(tags);

        this.point = point;

        this.requirements = [
            ...requirements
        ];

        this.available =
            available;

        this.executeCallback =
            execute;

        // Behavioral metadata is independent from animation/pose tags. A
        // complex task may use utility as a function of needs, schedules or
        // quests and group several definitions under one repetitionKey.
        this.utility = utility;
        this.cooldown = cooldown;
        this.repetitionKey = repetitionKey ?? id;
        this.metadata = { ...metadata };

    }

    hasTags(tags = []) {

        return tags.every(tag =>
            this.tags.has(tag)
        );

    }

    canExecute(context) {

        if (
            !this.point.isAvailable(
                context.actor
            )
        ) {

            return false;

        }

        if (
            this.available &&
            this.available(context) === false
        ) {

            return false;

        }

        return this.requirements.every(
            requirement =>
                requirement(context) !==
                false
        );

    }

    canConsider(context) {

        // Requirements are structural/behavioral constraints (role, quest,
        // inventory, schedule). `available` is deliberately not checked here:
        // occupancy and temporary target state belong in the congestion score.
        return this.requirements.every(
            requirement => requirement(context) !== false
        );

    }

    getUtility(context) {

        const value = typeof this.utility === "function"
            ? this.utility(context)
            : this.utility;

        return Number.isFinite(value) ? value : 0;

    }

    execute(context) {

        if (!this.executeCallback) {

            return true;

        }

        return (
            this.executeCallback(context) !==
            false
        );

    }

}
