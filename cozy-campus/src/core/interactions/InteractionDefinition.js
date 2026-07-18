export class InteractionDefinition {

    constructor({
        id,
        tags = [],
        point,
        requirements = [],
        available = null,
        execute
    }) {

        if (!id) {

            throw new Error(
                "InteractionDefinition requires an id."
            );

        }

        if (!point) {

            throw new Error(
                `InteractionDefinition "${id}" requires an InteractionPoint.`
            );

        }

        if (typeof execute !== "function") {

            throw new Error(
                `InteractionDefinition "${id}" requires an execute function.`
            );

        }

        this.id = id;
        this.tags = new Set(tags);
        this.point = point;
        this.requirements = [...requirements];
        this.available = available;
        this.executeCallback = execute;

    }

    // -----------------------------
    // Query
    // -----------------------------

    hasTags(tags = []) {

        return tags.every(tag =>
            this.tags.has(tag)
        );

    }

    canExecute(context) {

        if (!this.point.accessible) {

            return false;

        }

        if (this.available &&
            !this.available(context)) {

            return false;

        }

        return this.requirements.every(
            requirement =>
                requirement(context) !== false
        );

    }

    // -----------------------------
    // Execution
    // -----------------------------

    execute(context) {

        return this.executeCallback(context);

    }

}