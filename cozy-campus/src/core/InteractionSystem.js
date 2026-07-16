export class InteractionSystem {

    constructor() {

        // Each actor supplies its own navigation adapter. Player, NPCs and
        // remote actors can therefore use the same interaction request format.
        this.actorNavigators = new Map();

    }

    registerActor(actor, navigate) {

        this.actorNavigators.set(actor, navigate);

    }

    unregisterActor(actor) {

        this.actorNavigators.delete(actor);

    }

    request({ actor, target, point, action }) {

        const navigate = this.actorNavigators.get(actor);

        if (!navigate) {

            console.log(
                `[InteractionSystem] Actor "${actor?.name ?? "unknown"}" has no navigation adapter.`
            );
            return false;

        }

        if (!target || !point?.accessible) {

            console.log("[InteractionSystem] Invalid interaction target or point.");
            return false;

        }

        // Example for an NPC or external system:
        // interactionSystem.request({
        //     actor: npc,
        //     target: chair,
        //     point: chair.seatPoint,
        //     action: ({ actor, point }) =>
        //         chair.beginInteraction(actor, point)
        // });
        const accepted = navigate({
            actor,
            target,
            point,
            onArrive: () => action?.({ actor, target, point })
        });

        return accepted !== false;

    }

}
