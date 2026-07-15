import * as THREE from "three";
import { EntityState } from "./EntityState";
import { Tween } from "./Tween";

export class Entity {

    constructor(name = "Entity") {

        this.name = name;

        // Root Three.js object representing this entity.
        this.object3D = null;

        // Whether this entity updates every frame.
        // Set to false to "pause" the entity without removing it.
        this.active = true;

        // Whether this entity can be hovered or clicked.
        // Input.js should ignore entities whose interactable flag is false.
        this.interactable = true;

        // Whether this entity is visible.
        // This also updates object3D.visible automatically.
        this.visible = true;

        // Current state of this entity.
        this.state = EntityState.IDLE;

        this.tweens = [];

        this.interactableObjects = [];

    }

    makeInteractable(object = this.object3D) {

        if (!this.interactableObjects) {

            this.interactableObjects = [];

        }

        this.interactableObjects.push(object);

    }

    register(registry) {

        for (const object of this.interactableObjects) {

            registry.register(this, object);

        }

    }


    // -----------------------------
    // States
    // -----------------------------

    setState(state) {

        if (this.state === state) {

            return;

        }

        const previous = this.state;

        this.state = state;

        this.onStateChanged(previous, state);

    }

    isState(state) {

        return this.state === state;

    }

    onStateChanged(previous, current) {

    }


    // -----------------------------
    // Active
    // -----------------------------

    activate() {

        this.active = true;

    }

    deactivate() {

        this.active = false;

    }

    isActive() {

        return this.active;

    }


    // -----------------------------
    // Interaction
    // -----------------------------

    enableInteraction() {

        this.interactable = true;

    }

    disableInteraction() {

        this.interactable = false;

    }

    canInteract() {

        return this.interactable;

    }


    // -----------------------------
    // Visibility
    // -----------------------------

    show() {

        this.visible = true;

        if (this.object3D) {

            this.object3D.visible = true;

        }

    }

    hide() {

        this.visible = false;

        if (this.object3D) {

            this.object3D.visible = false;

        }

    }

    isVisible() {

        return this.visible;

    }


    // -----------------------------
    // Events
    // -----------------------------

    hover(object) {

    }

    unhover(object) {

    }

    interact(object) {

    }


    tween(options) {

        const tween = new Tween(options);

        if (options.object && options.property) {

            this.tweens = this.tweens.filter(
                existing =>
                    existing.object !== options.object ||
                    existing.property !== options.property
            );

        }

        this.tweens.push(tween);

        return tween;

    }

    tweenColor(color, from = color.clone(), to, duration = 1) {

        ["r", "g", "b"].forEach(channel => {

            this.tween({

                object: color,
                property: channel,

                from: from[channel],
                to: to[channel],

                duration

            });

        });

    }

    tweenScale(scale, from = scale.clone(), to, duration = 1, easing = Tween.linear, onComplete = null) {

        let completed = 0;

        const axes = ["x", "y", "z"];

        axes.forEach(axis => {

            this.tween({

                object: scale,
                property: axis,

                from: from[axis],
                to: to[axis],

                duration,
                easing,

                onComplete: () => {

                    completed++;

                    if (completed === axes.length && onComplete) {

                        onComplete();

                    }

                }

            });

        });

    }

    updateTweens(delta) {

        for (let i = this.tweens.length - 1; i >= 0; i--) {

            this.tweens[i].update(delta);

            if (this.tweens[i].finished) {

                this.tweens.splice(i, 1);

            }

        }

    }

    update(delta) {

        this.updateTweens(delta);

    }

}