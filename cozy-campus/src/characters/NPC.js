import * as THREE from "three";
import { Character } from "./Character";

export class NPC extends Character {

    constructor(name = "NPC") {

        super(name);

        const visual = new THREE.Mesh(
            new THREE.CylinderGeometry(0.45, 0.45, 1.7, 16),
            new THREE.MeshStandardMaterial({ color: 0xff8a2a })
        );

        visual.castShadow = true;
        this.setVisual(visual, { floorOffset: 0.85 });

    }

}
