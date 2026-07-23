import * as THREE from "three";
import { AnimationPresets } from "../core/AnimationPresets";
import { Entity } from "../core/Entity";
import { EntityState } from "../core/EntityState";

export class Cube extends Entity {

    constructor() {

        super("Cube");

        this.setState(EntityState.IDLE);

        this.rotationSpeed = 1;

        this.object3D = new THREE.Mesh(

            new THREE.BoxGeometry(),

            new THREE.MeshStandardMaterial({

                color: 0xff5555,

            })

        );

        this.object3D.position.set(4, 0.5, 0);

        this.object3D.castShadow = true;

        this.makeInteractable();

        this.enableOutline();

    }

    // -----------------------------
    // Interaction hooks
    // -----------------------------

    onHover(mesh) {

        mesh.material.emissive.set(0x444444);

        this.changeRotationSpeed(5);


    }

    onUnhover(mesh) {

        mesh.material.emissive.set(0x000000);

        if (!this.isState(EntityState.DISABLED)) this.changeRotationSpeed(1);


    }

    onPointerInteract(mesh) {

        this.performInteraction(mesh);

    }

    performInteraction(mesh) {

        this.disableInteraction();

        this.setState(EntityState.DISABLED);

        this.changeRotationSpeed(0, 2);

    }

    onStateChanged(previous, current) {

        console.log(previous, "->", current);

        switch (current) {

            case EntityState.IDLE:

                this.object3D.material.color.set(0x8b4513);

                break;

            case EntityState.DISABLED:

                this.object3D.material.color.set(0xff0000);

                break;

        }

    }

    // -----------------------------
    // Animation
    // -----------------------------

    changeRotationSpeed(speed, duration = 0.5) {

        AnimationPresets.to(this, {
            object: this,
            property: "rotationSpeed",
            to: speed,
            duration
        });

    }

    // -----------------------------
    // Lifecycle
    // -----------------------------

    requiresContinuousRender() {

        // rotationSpeed is a procedural animation applied directly in update();
        // it therefore needs to keep requesting frames even without a Tween.
        return super.requiresContinuousRender() ||
            Math.abs(this.rotationSpeed) > Number.EPSILON;

    }

    update(delta) {

        super.update(delta);

        this.object3D.rotation.y +=
            this.rotationSpeed * delta;

    }

}
