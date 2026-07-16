import * as THREE from "three";
import { Entity } from "../core/Entity";

export class Sphere extends Entity {

    constructor() {

        super("Sphere");

        this.object3D = new THREE.Mesh(

            new THREE.SphereGeometry(
                0.6,
                32,
                32
            ),

            new THREE.MeshStandardMaterial({
                color: 0x5599ff
            })

        );

        this.object3D.position.set(2, 0.6, 0);

        this.object3D.castShadow = true;

    }

    // -----------------------------
    // Lifecycle
    // -----------------------------

    update() {

    }

}
