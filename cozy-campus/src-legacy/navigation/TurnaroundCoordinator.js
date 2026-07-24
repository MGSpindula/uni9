import { EntityState } from "../core/EntityState";

// Coordena a pausa deliberada antes de trocar uma rota pelo sentido oposto.
// Esta classe não planeja caminhos: ela apenas preserva e executa o comando
// que já foi validado pelo CharacterNavigationSystem.
export class TurnaroundCoordinator {

    constructor(navigation) {

        this.navigation = navigation;

    }

    shouldTurnAround(actor, requestedPosition) {

        if (!actor.isState(EntityState.WALKING)) return false;

        const waypoint = actor.navigation.getCurrentWaypoint();

        if (!waypoint) return false;

        const currentDirection = waypoint.position.clone()
            .sub(actor.object3D.position)
            .setY(0);
        const requestedDirection = requestedPosition.clone()
            .sub(actor.object3D.position)
            .setY(0);

        if (currentDirection.lengthSq() < 0.0001 ||
            requestedDirection.lengthSq() < 0.0001) return false;

        return currentDirection.normalize().dot(
            requestedDirection.normalize()
        ) < -0.1;

    }

    begin(context, command) {

        // Futuramente o timer poderá ser substituído pelo onComplete da
        // animação de virar no lugar. O comando já está validado e não é perdido.
        context.intent.deferredCommand = command;
        context.turnaround.active = true;
        context.turnaround.elapsed = 0;
        context.actor.pause();
        this.onRequested(context.actor);

    }

    onRequested(actor) {

        console.log(`[Navigation] ${actor.name} prepares to turn around.`);

    }

    execute(context, { skipInteractionExit = false } = {}) {

        const command = context.intent.deferredCommand;

        if (!command) return false;

        context.intent.deferredCommand = null;

        const accepted = command.type === "interaction"
            ? this.navigation.moveToInteractionPoint(
                context.actor,
                command.point,
                command.onArrive,
                {
                    replaceIntent: !command.intentPrepared,
                    skipTurnaround: true,
                    skipInteractionExit,
                    preparedRouteCandidate:
                        command.preparedRouteCandidate ?? null
                }
            )
            : this.navigation.moveToClosestNode(
                context.actor,
                command.position,
                {
                    replaceIntent: !command.intentPrepared,
                    skipTurnaround: true,
                    skipInteractionExit,
                    preparedCandidate: command.preparedCandidate ?? null
                }
            );

        if (!accepted) {

            context.intent.deferredCommand = command;
            context.actor.pause();

        }

        return accepted;

    }

}
