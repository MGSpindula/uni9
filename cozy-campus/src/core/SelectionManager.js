export class SelectionManager {

    constructor() {

        this.effects = [];

        this.entity = null;
        this.object = null;

    }

    addEffect(effect) {

        this.effects.push(effect);

    }

    setHovered(entity, object) {

        if (

            entity === this.entity &&

            object === this.object

        ) {

            return;

        }

        this.clear();

        this.entity = entity;
        this.object = object;

        entity.hover(object);

        for (const effect of this.effects) {

            effect.hover(entity, object);

        }

    }

    clear() {

        if (!this.entity) {

            return;

        }

        this.entity.unhover(
            this.object
        );

        for (const effect of this.effects) {

            effect.unhover(

                this.entity,

                this.object

            );

        }

        this.entity = null;
        this.object = null;

    }

    getEntity() {

        return this.entity;

    }

    getObject() {

        return this.object;

    }

}