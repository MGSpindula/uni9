import * as THREE from "three";
import { Character } from "./Character";

export class NPC extends Character {

    constructor(name = "NPC", { color = 0xff8a2a } = {}) {

        super(name);

        this.navigationPriority = 0;

        // NPC behavior is allowed to replace an unreachable task after the
        // recovery timeout. Until then it uses the exact same persistent queue
        // and retry mechanics as the Player.
        this.navigationIntentPolicy = "replaceable";

        const visual = new THREE.Mesh(
            new THREE.CylinderGeometry(0.45, 0.45, 1.7, 16),
            new THREE.MeshStandardMaterial({ color })
        );

        visual.castShadow = true;
        this.setVisual(visual, { floorOffset: 0.85 });
        this.addForwardHelper();

    }

}
