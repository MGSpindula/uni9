export class MoveToInteractionAction {

    constructor(point) {

        this.point = point;

    }

    execute(context, next) {

        return context.navigate({
            actor: context.actor,
            target: context.target,
            point: this.point,
            onArrive: next
        });

    }

}