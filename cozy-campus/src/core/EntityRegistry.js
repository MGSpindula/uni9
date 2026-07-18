export class EntityRegistry {

    constructor() {

        // Object3D -> Entity.
        this.map = new WeakMap();

        // Entity -> Object3D collection.
        this.objectsByEntity = new Map();

        // Somente estas raízes serão consultadas pelo Raycaster.
        this.raycastTargets = new Set();

    }

    // -----------------------------
    // Registration
    // -----------------------------

    register(entity, object) {

        if (!entity || !object) return;

        this.map.set(object, entity);
        this.raycastTargets.add(object);

        if (!this.objectsByEntity.has(entity)) {

            this.objectsByEntity.set(
                entity,
                new Set()
            );

        }

        this.objectsByEntity
            .get(entity)
            .add(object);

    }

    unregister(entity, object = null) {

        const registeredObjects = object
            ? [object]
            : this.objectsByEntity.get(entity) ?? [];

        for (const registeredObject of registeredObjects) {

            if (this.map.get(registeredObject) === entity) {

                this.map.delete(registeredObject);

            }

            this.raycastTargets.delete(
                registeredObject
            );

            this.objectsByEntity
                .get(entity)
                ?.delete(registeredObject);

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

    getRaycastTargets() {

        return [...this.raycastTargets];

    }

    clear() {

        this.map = new WeakMap();
        this.objectsByEntity.clear();
        this.raycastTargets.clear();

    }

}