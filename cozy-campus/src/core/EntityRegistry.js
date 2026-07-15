export class EntityRegistry {

    constructor() {

        this.map = new WeakMap();
        this.objectsByEntity = new Map();

    }

    register(entity, object) {

        this.map.set(object, entity);

        if (!this.objectsByEntity.has(entity)) {

            this.objectsByEntity.set(entity, new Set());

        }

        this.objectsByEntity.get(entity).add(object);

    }

    unregister(entity, object = null) {

        const objects = object ? [object] : this.objectsByEntity.get(entity) ?? [];

        for (const registeredObject of objects) {

            if (this.map.get(registeredObject) === entity) {

                this.map.delete(registeredObject);

            }

            this.objectsByEntity.get(entity)?.delete(registeredObject);

        }

        if (this.objectsByEntity.get(entity)?.size === 0) {

            this.objectsByEntity.delete(entity);

        }

    }

    get(object) {

        while (object) {

            const entity = this.map.get(object);

            if (entity) return entity;

            object = object.parent;

        }

        return null;

    }

}
