import * as THREE from "three";
import { Entity } from "../core/Entity";

export class Floor extends Entity {

    constructor() {

        super("Floor");

        this.object3D = new THREE.Mesh(

            new THREE.PlaneGeometry(20, 20),

            new THREE.MeshStandardMaterial({
                color: 0x6ea96e
            })

        );

        this.object3D.rotation.x = -Math.PI / 2;

        this.object3D.receiveShadow = true;

        this.object3D.castShadow = true;

        // The floor is a click target, but it has no visual hover effect.
        this.makeInteractable();

        // Scene injects this callback so the floor does not depend on Player.
        this.destinationHandler = null;

    }

    // -----------------------------
    // Interaction
    // -----------------------------

    setDestinationHandler(handler) {

        this.destinationHandler = handler;

    }

    onPointerInteract(object, hit) {

        if (hit?.point) {

            this.destinationHandler?.(hit.point);

        }

    }

    // -----------------------------
    // Lifecycle
    // -----------------------------

    update() {

    }

}
