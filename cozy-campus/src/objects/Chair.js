import * as THREE from "three";
import { AnimationPresets } from "../core/AnimationPresets";
import { Entity } from "../core/Entity";
import { EntityState } from "../core/EntityState";
import { Tween } from "../core/Tween";
import { InteractionDefinition } from "../core/interactions/InteractionDefinition";
import { InteractionPoint } from "../navigation/InteractionPoint";

export class Chair extends Entity {

    constructor() {

        super("Chair");

        this.cooldown = 0;
        this.seatHeight = 1;
        this.seatTransitionDuration = 0.50;

        // This static prop does not need a separate visual child yet: its root is also
        // its visual hierarchy. Add one before using cosmetic animations while it moves.
        this.object3D = new THREE.Group();
        this.legsGroup = new THREE.Group();

        this.object3D.add(this.legsGroup);
        this.object3D.position.set(-0.5, 0, 2.8);
        this.object3D.rotateOnAxis(new THREE.Vector3(0, 1, 0), -Math.PI / 4);

        this.createSeat();
        this.createBack();
        this.createLegs();
        this.createInteractionPoints();
        this.createInteractionDefinitions();

        this.enableOutline();

    }

    // -----------------------------
    // Construction
    // -----------------------------

    createSeat() {

        this.seat = new THREE.Mesh(
            new THREE.BoxGeometry(1.5, 0.2, 1.5),
            new THREE.MeshStandardMaterial({ color: 0x8b4513 })
        );

        this.seat.name = "Seat";
        this.seat.position.y = 1;
        this.seat.castShadow = true;

        this.object3D.add(this.seat);
        this.makeInteractable(this.seat);

    }

    createBack() {

        this.back = new THREE.Mesh(
            new THREE.BoxGeometry(1.5, 1.8, 0.2),
            new THREE.MeshStandardMaterial({ color: 0x8b4513 })
        );

        this.back.position.set(0, 1.8, -0.65);
        this.back.castShadow = true;

        this.object3D.add(this.back);

    }

    createLegs() {

        const geometry = new THREE.BoxGeometry(0.15, 1, 0.15);
        const material = new THREE.MeshStandardMaterial({ color: 0x4b2500 });
        const legs = [
            ["FrontLeftLeg", -0.6, 0.5, -0.6],
            ["FrontRightLeg", 0.6, 0.5, -0.6],
            ["BackLeftLeg", -0.6, 0.5, 0.6],
            ["BackRightLeg", 0.6, 0.5, 0.6]
        ];

        for (const [name, x, y, z] of legs) {

            const leg = new THREE.Mesh(geometry, material);

            leg.name = name;
            leg.position.set(x, y, z);
            leg.castShadow = true;

            this.legsGroup.add(leg);

        }

    }

    createInteractionPoints() {

        // Local position in front of the chair. Blender empties will eventually
        // provide this transform without changing the navigation code.
        this.approachPoint =
            this.addInteractionPoint(
                new InteractionPoint(
                    "chair-01:approach",
                    {
                        position:
                            new THREE.Vector3(
                                0,
                                0,
                                1
                            ),

                        rotationY:
                            Math.PI,

                        maxConnectionDistance:
                            2.5,

                        terminal:
                            false,

                        metadata: {
                            action: "sit",
                            role: "approach"
                        }
                    }
                )
            );

        // This second empty represents being at/in the chair. It is reached
        // through approachPoint, but occupies a different navigation resource.
        this.interactionPoint =
            this.addInteractionPoint(
                new InteractionPoint(
                    "chair-01:action",
                    {
                        position:
                            new THREE.Vector3(
                                0,
                                0,
                                0
                            ),

                        rotationY: 0,

                        via:
                            this.approachPoint,

                        terminal:
                            true,

                        metadata: {
                            action: "sit",
                            role: "action",
                            showDirection: true,
                            preserveFacing: true
                        }
                    }
                )
            );

    }

    createInteractionDefinitions() {

        this.addInteractionDefinition(
            new InteractionDefinition({
                id: "sit",

                tags: [
                    "npc-action",
                    "sit",
                    "rest"
                ],

                point: this.interactionPoint,

                requirements: [
                    ({ actor }) =>
                        actor !== null &&
                        actor !== undefined
                ],

                available: ({ target }) =>
                    target.canInteract() &&
                    !target.hasInteractingActors(),

                execute: ({
                    actor,
                    target,
                    point
                }) => {

                    target.beginInteraction(
                        actor,
                        point
                    );

                }
            })
        );

    }

    // -----------------------------
    // Interaction hooks
    // -----------------------------

    onHover(mesh) {

        mesh.material.emissive.set(0x444444);

        AnimationPresets.scaleTo(this, {
            target: this.object3D,
            to: new THREE.Vector3(1.2, 1.2, 1.2),
            duration: 0.5,
            easing: Tween.easeOutBack
        });

    }

    onUnhover(mesh) {

        mesh.material.emissive.set(0x000000);

        if (!this.isState(EntityState.COOLDOWN)) {

            AnimationPresets.scaleTo(this, {
                target: this.object3D,
                to: new THREE.Vector3(1, 1, 1),
                duration: 0.5,
                easing: Tween.easeOutBack
            });

        }

    }

    onPointerInteract() {

        if (!this.canInteract()) {

            return null;

        }

        return {
            type: "INTERACT",
            interactionId: "sit"
        };

    }

    performInteraction(actor = null) {

        console.log(
            `[Entity Interaction] ${actor?.name ?? "An actor"} uses Chair.`
        );

        this.disableInteraction();
        this.setState(EntityState.DISABLED);

        // This method runs after arrival, when the entity is actually using the
        // chair. The same distinction applies to picking up, opening or holding
        // other objects. It can:
        // - change EntityState;
        // - play visual or skeletal animations;
        // - enable/disable interaction or collision;
        // - change materials, lights, sounds or other entity properties;
        // - notify other gameplay systems that the chair action occurred.
        // It does not represent a mouse event and may also be called by scripts,
        // NPC behavior, quests or other internal game systems. External usage:
        // Player and NPCs arrive through the same callback, so both receive
        // this height change. A future sitting animation replaces these direct
        // y assignments here, not in PlayerController or NPC behavior.

    }

    onPrepareInteraction(actor, approachPoint, targetPoint, onComplete) {

        if (!actor) {

            onComplete?.();
            return;

        }

        const seatPosition = targetPoint.getWorldPosition();

        // Mock sit animation: it starts at approach, raises the actor and moves
        // the logical root to seat. onComplete lets navigation reach seat and
        // only then trigger performInteraction(). A future bone/root animation
        // replaces these tweens while preserving this callback contract.
        AnimationPresets.to(actor, {
            object: actor.object3D.position,
            property: "x",
            to: seatPosition.x,
            duration: this.seatTransitionDuration,
            easing: Tween.easeInOutQuad
        });
        AnimationPresets.to(actor, {
            object: actor.object3D.position,
            property: "y",
            to: this.seatHeight,
            duration: this.seatTransitionDuration,
            easing: Tween.easeOutCubic
        });
        AnimationPresets.to(actor, {
            object: actor.object3D.position,
            property: "z",
            to: seatPosition.z,
            duration: this.seatTransitionDuration,
            easing: Tween.easeInOutQuad,
            onComplete
        });

    }

    onPrepareInteractionExit(actor, point, approachPoint, onComplete) {

        if (!actor || !approachPoint) {

            onComplete?.();
            return;

        }

        const approachPosition = approachPoint.getWorldPosition();
        const exitDirection = approachPoint.getWorldDirection().negate();

        // Logical facing changes instantly; the future stand-up clip will hide
        // this root change on the visual skeleton.
        actor.object3D.lookAt(
            actor.object3D.position.x + exitDirection.x,
            actor.object3D.position.y,
            actor.object3D.position.z + exitDirection.z
        );

        // Mock stand-up/jump-to-floor animation. It owns seat -> approach and
        // navigation cannot continue beyond approach before onComplete.
        AnimationPresets.to(actor, {
            object: actor.object3D.position,
            property: "x",
            to: approachPosition.x,
            duration: this.seatTransitionDuration,
            easing: Tween.easeInOutQuad
        });
        AnimationPresets.to(actor, {
            object: actor.object3D.position,
            property: "y",
            to: 0,
            duration: this.seatTransitionDuration,
            easing: Tween.easeInCubic
        });
        AnimationPresets.to(actor, {
            object: actor.object3D.position,
            property: "z",
            to: approachPosition.z,
            duration: this.seatTransitionDuration,
            easing: Tween.easeInOutQuad,
            onComplete
        });

    }

    onInteractionEnded(actor) {

        if (actor) {

            // AnimationPresets replaces any existing tween on this same y
            // property, so leaving halfway through sitting reverses smoothly.
            AnimationPresets.to(actor, {
                object: actor.object3D.position,
                property: "y",
                to: 0,
                duration: this.seatTransitionDuration,
                easing: Tween.easeInOutQuad
            });

        }

        if (!this.hasInteractingActors()) {

            this.enableInteraction();
            this.setState(EntityState.IDLE);

        }

    }

    // -----------------------------
    // Animations
    // -----------------------------

    animateColors() {

        const red = new THREE.Color(0xff0000);
        const duration = 2;

        this.tweenColor(this.seat.material.color, undefined, red, duration);
        this.tweenColor(this.back.material.color, undefined, red, duration);

        for (const leg of this.legsGroup.children) {

            this.tweenColor(leg.material.color, undefined, red, duration);

        }

    }

    animateLeg() {

        const leg = this.object3D.getObjectByName("FrontLeftLeg");

        AnimationPresets.to(this, {
            object: leg.rotation,
            property: "z",
            to: 0.5,
            duration: 0.5
        });

    }

    animateJump() {

        AnimationPresets.jump(this, {
            target: this.object3D,
            height: 3,
            upDuration: 1,
            downDuration: 1
        });

    }

    animateBounce() {

        AnimationPresets.scaleBounce(this, {
            target: this.object3D,
            multiplier: 1.2,
            outDuration: 0.5,
            returnDuration: 0.5
        });

    }

    // -----------------------------
    // State hooks
    // -----------------------------

    onStateChanged(previous, current) {

    }

    // -----------------------------
    // Lifecycle
    // -----------------------------

    update(delta) {

        super.update(delta);

        // Optional cooldown pattern kept as a reference. To use it, set the
        // entity to COOLDOWN and assign this.cooldown when an action starts.
        // The current chair uses DISABLED while an actor occupies interactionPoint,
        // so this block remains inactive during normal sitting.
        if (!this.isState(EntityState.COOLDOWN)) return;

        this.cooldown -= delta;

        if (this.cooldown <= 0) {

            this.enableInteraction();
            this.setState(EntityState.IDLE);

        }

    }

}
