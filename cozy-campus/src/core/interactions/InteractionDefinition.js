export class InteractionDefinition {

    constructor({
        id,
        tags = [],
        point,
        requirements = [],
        available = null,
        execute = null
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