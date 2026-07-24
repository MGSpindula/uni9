import { Raycast } from "./Raycast";

export class SelectionManager {

    constructor(camera, registry, element, { onChanged = null } = {}) {

        this.raycast =
            new Raycast(
                camera,
                element
            );

        this.registry = registry;
        this.element = element;
        this.onChanged = onChanged;

        this.effects = [];

        this.entity = null;
        this.object = null;

        this.selectedEntity = null;
        this.selectedObject = null;

        // O último mousemove recebido será processado no próximo frame.
        this.pendingPointerEvent = null;

        // Cache do último raycast.
        this.lastHit = null;
        this.lastRaycastClientX = null;
        this.lastRaycastClientY = null;

    }

    // -----------------------------
    // Effects
    // -----------------------------

    addEffect(effect) {

        this.effects.push(effect);

    }

    removeEffect(effect) {

        this.effects =
            this.effects.filter(
                item => item !== effect
            );

    }

    // -----------------------------
    // Pointer queue
    // -----------------------------

    handleMouseMove(event) {

        this.pendingPointerEvent = event;

    }

    update() {

        if (!this.pendingPointerEvent) {

            return;

        }

        const event =
            this.pendingPointerEvent;

        this.pendingPointerEvent = null;

        const hit =
            this.resolveHit(event);

        if (!hit || !hit.entity.canInteract()) {

            this.clearHover();
            this.element.style.cursor = "default";
            return;

        }

        this.setHovered(
            hit.entity,
            hit.object
        );

        this.element.style.cursor = "pointer";

    }

    handleClick(event) {

        // Normalmente o mousemove anterior já resolveu este ponto.
        // Se ainda há um movimento pendente, ele é processado agora.
        if (this.pendingPointerEvent) {

            const pendingEvent =
                this.pendingPointerEvent;

            this.pendingPointerEvent = null;

            this.lastHit =
                this.resolveHit(pendingEvent);

        }

        const hit =
            this.resolveHit(event);

        if (!hit || !hit.entity.canInteract()) {

            return false;

        }

        return hit;

    }

    resolveHit(event) {

        const samePointerPosition =
            event.clientX === this.lastRaycastClientX &&
            event.clientY === this.lastRaycastClientY;

        if (samePointerPosition) {

            return this.lastHit;

        }

        this.lastRaycastClientX =
            event.clientX;

        this.lastRaycastClientY =
            event.clientY;

        this.lastHit =
            this.raycast.getHit(
                event,
                this.registry
            );

        return this.lastHit;

    }

    // -----------------------------
    // Hover
    // -----------------------------

    setHovered(entity, object) {

        if (entity === this.entity &&
            object === this.object) {

            return;

        }

        this.clearHover();

        this.entity = entity;
        this.object = object;

        entity.hover(object);

        for (const effect of this.effects) {

            effect.hover(
                entity,
                object
            );

        }

        this.onChanged?.();

    }

    clearHover() {

        if (!this.entity) {

            return;

        }

        this.entity.unhover(this.object);

        for (const effect of this.effects) {

            effect.unhover(
                this.entity,
                this.object
            );

        }

        this.entity = null;
        this.object = null;
        this.onChanged?.();

    }

    clear() {

        this.clearHover();

    }

    getEntity() {

        return this.entity;

    }

    getObject() {

        return this.object;

    }

    // -----------------------------
    // Selection
    // -----------------------------

    select(
        entity = this.entity,
        object = this.object
    ) {

        this.selectedEntity = entity;
        this.selectedObject = object;
        this.onChanged?.();

    }

    clearSelection() {

        this.selectedEntity = null;
        this.selectedObject = null;
        this.onChanged?.();

    }

    dispose() {

        this.clearHover();
        this.clearSelection();

        this.effects.length = 0;
        this.pendingPointerEvent = null;
        this.lastHit = null;

        this.element.style.cursor = "default";

    }

}
