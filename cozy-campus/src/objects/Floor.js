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


    }

    update() {

    }

}