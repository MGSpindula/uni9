import * as THREE from "three";
import { Entity } from "../core/Entity";
import { EntityState } from "../core/EntityState";
import { Tween } from "../core/Tween";

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

        this.object3D.position.set(-2, 0.5, 0);

        this.object3D.castShadow = true;

        this.makeInteractable();

        this.enableOutline();

    }

    onHover(mesh) {

        mesh.material.emissive.set(0x444444);

        this.changeRotationSpeed(5);


    }

    onUnhover(mesh) {

        mesh.material.emissive.set(0x000000);

        if (!this.isState(EntityState.DISABLED)) this.changeRotationSpeed(1);


    }

    onInteract(mesh) {

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

    changeRotationSpeed(speed, duration = 0.5) {

        this.tween({

            object: this,
            property: "rotationSpeed",

            from: this.rotationSpeed,
            to: speed,

            duration: duration,

            easing: Tween.easeOutQuad

        });

    }


    update(delta) {

        super.update(delta);

        this.object3D.rotation.y +=
            this.rotationSpeed * delta;

    }

}