export class World {
    constructor({ scene, services }) {
        this.scene = scene; this.services = services;
        this.entities = []; this.characters = []; this.controllers = [];
        this.targets = [];
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
        this.targets.push(entity);
    }
    dispose() {
        for (const actor of this.characters) {
            this.services.interactions.unregisterActor(actor);
            this.services.characterNavigation.unregisterActor(actor);
        }
        for (const target of this.targets) {
            this.services.interactions.unregisterTarget(target);
            for (const point of target.interactionPoints) {
                this.services.navigationConnector.unregister(point);
            }
        }
        for (const entity of this.entities) {
            entity.unregister?.(this.services.registry); entity.dispose?.();
            this.scene.remove(entity.object3D);
        }
        this.entities.length = 0; this.characters.length = 0; this.controllers.length = 0;
        this.targets.length = 0;
    }
}
