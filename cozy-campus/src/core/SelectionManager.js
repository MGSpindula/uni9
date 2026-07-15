import { Raycast } from "./Raycast";

export class SelectionManager {

    constructor(camera, scene, registry, element) {

        this.raycast = new Raycast(camera, scene, element);
        this.registry = registry;
        this.effects = [];

        this.entity = null;
        this.object = null;
        this.selectedEntity = null;
        this.selectedObject = null;

    }

    addEffect(effect) {

        this.effects.push(effect);

    }

    removeEffect(effect) {

        this.effects = this.effects.filter(item => item !== effect);

    }

    handleMouseMove(event) {

        const hit = this.raycast.getHit(event, this.registry);

        if (!hit || !hit.entity.canInteract()) {

            this.clearHover();
            return false;

        }

        this.setHovered(hit.entity, hit.object);
        return true;

    }

    handleClick(event) {

        const hit = this.raycast.getHit(event, this.registry);

        if (!hit || !hit.entity.canInteract()) {

            return false;

        }

        hit.entity.interact(hit.object);
        return true;

    }

    setHovered(entity, object) {

        if (entity === this.entity && object === this.object) {

            return;

        }

        this.clearHover();

        this.entity = entity;
        this.object = object;

        entity.hover(object);

        for (const effect of this.effects) {

            effect.hover(entity, object);

        }

    }

    clearHover() {

        if (!this.entity) {

            return;

        }

        this.entity.unhover(this.object);

        for (const effect of this.effects) {

            effect.unhover(this.entity, this.object);

        }

        this.entity = null;
        this.object = null;

    }

    // Backward-compatible name while callers migrate to clearHover().
    clear() {

        this.clearHover();

    }

    getEntity() {

        return this.entity;

    }

    getObject() {

        return this.object;

    }

    select(entity = this.entity, object = this.object) {

        this.selectedEntity = entity;
        this.selectedObject = object;

    }

    clearSelection() {

        this.selectedEntity = null;
        this.selectedObject = null;

    }

}
