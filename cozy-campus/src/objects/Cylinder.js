import * as THREE from "three";
import { Entity } from "../core/Entity";

export class Cylinder extends Entity {

    constructor() {

        super("Cylinder");

        this.object3D = new THREE.Mesh(

            new THREE.CylinderGeometry(
                0.4,
                0.4,
                2,
                32
            ),

            new THREE.MeshStandardMaterial({
                color: 0xffff66
            })

        );

        this.object3D.position.set(0, 1, -3);

        this.object3D.castShadow = true;

    }

    // -----------------------------
    // Lifecycle
    // -----------------------------


    update() {

    }

}
