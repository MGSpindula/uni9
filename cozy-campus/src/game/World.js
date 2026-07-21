export class World {
    constructor({ scene, services }) {
        this.scene = scene; this.services = services;
        this.entities = []; this.characters = []; this.controllers = [];
    }
    add(entity) {
        this.entities.push(entity); this.scene.add(entity.object3D);
        entity.register(this.services.registry); return entity;
    }
    registerCharacter(character, { spawnId = null, grounding = null } = {}) {
        character.setGrounding(grounding);
        this.services.characterNavigation.registerActor(character, { spawnId });
        this.services.interactions.registerActor(character, {
            navigate: request => this.services.characterNavigation.moveToInteraction(character, request.point, request.onArrive),
            evaluate: candidate => this.services.characterNavigation.evaluateInteraction(character, candidate.point)
        });
        this.characters.push(character);
    }
    registerTarget(entity) {
        for (const point of entity.interactionPoints) this.services.navigationConnector.register(point);
        this.services.interactions.registerTarget(entity);
    }
    dispose() {
        for (const actor of this.characters) {
            this.services.interactions.unregisterActor(actor);
            this.services.characterNavigation.unregisterActor(actor);
        }
        for (const entity of this.entities) {
            this.services.interactions.unregisterTarget(entity);
            entity.unregister?.(this.services.registry); entity.dispose?.();
            this.scene.remove(entity.object3D);
        }
        this.entities.length = 0; this.characters.length = 0; this.controllers.length = 0;
    }
}
