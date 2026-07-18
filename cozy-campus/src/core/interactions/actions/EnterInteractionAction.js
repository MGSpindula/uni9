export class EnterInteractionAction {

    constructor(definition) {

        this.definition = definition;

    }

    execute(context, next) {

        const currentContext = {
            ...context,
            definition: this.definition,
            point: this.definition.point
        };

        if (!this.definition.canExecute(currentContext)) {

            return false;

        }

        this.definition.execute(currentContext);

        next();

        return true;

    }

}