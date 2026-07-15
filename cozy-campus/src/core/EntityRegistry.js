export class EntityRegistry {

    constructor() {

        this.map = new WeakMap();

    }

    register(entity, object) {

        this.map.set(object, entity);

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