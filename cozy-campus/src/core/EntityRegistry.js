export class EntityRegistry {

    constructor() {

        // Object3D -> Entity lookup used after a raycast.
        this.map = new WeakMap();

        // Entity -> Object3D collection used to unregister an entity at once.
        this.objectsByEntity = new Map();

    }

    register(entity, object) {

        this.map.set(object, entity);

        if (!this.objectsByEntity.has(entity)) {

            this.objectsByEntity.set(entity, new Set());

        }

        this.objectsByEntity.get(entity).add(object);

    }

    // -----------------------------
    // Registration
    // -----------------------------

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

    // -----------------------------
    // Lookup
    // -----------------------------

    get(object) {

        while (object) {

            const entity = this.map.get(object);

            if (entity) return entity;

            object = object.parent;

        }

        return null;

    }

}
