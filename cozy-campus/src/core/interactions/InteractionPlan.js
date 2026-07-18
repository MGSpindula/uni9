export class InteractionPlan {

    constructor(actions = []) {

        this.actions = [...actions];

    }

    execute(context) {

        let index = 0;

        const executeNext = () => {

            if (index >= this.actions.length) {

                return true;

            }

            const action =
                this.actions[index];

            index += 1;

            return action.execute(
                context,
                executeNext
            );

        };

        return executeNext();

    }

}