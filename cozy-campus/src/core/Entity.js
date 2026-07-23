import * as THREE from "three";
import { EntityState } from "./EntityState";
import { Tween } from "./Tween";

export class Entity {

    constructor(name = "Entity") {

        this.name = name;

        // Root transform representing the entity in the world.
        // Navigation, physics, collisions and multiplayer state should use this node.
        this.object3D = null;

        // Optional visual child of object3D. Procedural/model animations should target
        // this node so they do not compete with gameplay movement on object3D.
        this.visual = null;

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

        // Optional local approach points used before an interaction executes.
        this.interactionPoints = [];

        // Interactions offered by this entity.
        this.interactionDefinitions = new Map();

        // Actors currently engaged with this entity.
        this.interactingActors = new Set();

        this.effects = [];

        this.outline = false;

    }

    // -----------------------------
    // Registry
    // -----------------------------

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

    unregister(registry) {

        registry.unregister(this);

    }

    // -----------------------------
    // Effects
    // -----------------------------

    addEffect(effect) {

        this.effects.push(effect);

    }

    removeEffect(effect) {

        this.effects =
            this.effects.filter(e => e !== effect);

    }

    enableOutline() {

        this.outline = true;

    }

    disableOutline() {

        this.outline = false;

    }

    hasOutline() {

        return this.outline;

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

    addInteractionPoint(point) {

        point.attach(this);

        this.interactionPoints.push(point);

        return point;

    }

    addInteractionDefinition(definition) {

        if (!definition?.id) {

            throw new Error(
                `Entity "${this.name}" received an invalid interaction definition.`
            );

        }

        if (this.interactionDefinitions.has(definition.id)) {

            throw new Error(
                `Entity "${this.name}" already has interaction ` +
                `"${definition.id}".`
            );

        }

        this.interactionDefinitions.set(
            definition.id,
            definition
        );

        return definition;

    }

    getInteractionDefinition(id) {

        return this.interactionDefinitions.get(id) ?? null;

    }

    getInteractionDefinitions() {

        return [
            ...this.interactionDefinitions.values()
        ];

    }

    hasInteractionDefinition(id) {

        return this.interactionDefinitions.has(id);

    }

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

        for (const effect of this.effects) {

            effect.hover(this, object);

        }

        this.onHover(object);

    }


    onHover(object) {

    }

    unhover(object) {

        for (const effect of this.effects) {

            effect.unhover(this, object);

        }

        this.onUnhover(object);

    }

    onUnhover(object) {

    }

    pointerInteract(object, hit = null) {

        // Entry point used exclusively by mouse/pointer selection.
        return this.onPointerInteract(object, hit);

    }

    onPointerInteract(object, hit) {

    }

    performInteraction() {

        // Internal 3D/entity behavior. Subclasses decide when and how to run it;
        // navigation arrival must not implicitly simulate another mouse event.

    }

    beginInteraction(actor, point = null) {

        if (actor) this.interactingActors.add(actor);

        this.performInteraction(actor, point);

    }

    prepareInteraction(
        actor,
        approachPoint,
        targetPoint,
        onComplete = null
    ) {

        // Transition executed at the approach point before the actor moves to
        // the final point. A subclass may tween now and later wait for a bone
        // animation such as sitting, reaching, picking up or leaning.
        this.onPrepareInteraction(
            actor,
            approachPoint,
            targetPoint,
            onComplete
        );

    }

    onPrepareInteraction(actor, approachPoint, targetPoint, onComplete) {

        onComplete?.();

    }

    prepareInteractionExit(
        actor,
        point,
        approachPoint,
        onComplete = null
    ) {

        // Runs before navigation leaves a persistent interaction. The object
        // may play a stand-up, release or turn-around clip and must signal when
        // the actor is ready to travel back through the approach point.
        this.onPrepareInteractionExit(
            actor,
            point,
            approachPoint,
            onComplete
        );

    }

    onPrepareInteractionExit(actor, point, approachPoint, onComplete) {

        onComplete?.();

    }

    endInteraction(actor, point = null) {

        // Counterpart of performInteraction() for persistent uses such as
        // sitting, holding or operating an object.
        this.interactingActors.delete(actor);
        this.onInteractionEnded(actor, point);

    }

    onInteractionEnded(actor, point) {

    }

    hasInteractingActors() {

        return this.interactingActors.size > 0;

    }

    // -----------------------------
    // Animation
    // -----------------------------

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

    cancelTweens(object, properties = null) {

        const propertySet = properties ? new Set(properties) : null;

        this.tweens = this.tweens.filter(tween =>
            tween.object !== object ||
            (propertySet && !propertySet.has(tween.property))
        );

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

    // -----------------------------
    // Rendering
    // -----------------------------

    requiresContinuousRender() {

        // GameLoop may skip drawing a frame when the world is visually still.
        // Override this method when an entity owns a continuous procedural
        // animation that is not represented by a Tween or AnimationMixer.
        return this.tweens.length > 0;

    }

    // -----------------------------
    // Lifecycle
    // -----------------------------

    update(delta) {

        this.updateTweens(delta);

    }

}
