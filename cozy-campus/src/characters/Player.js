import * as THREE from "three";
import { Character } from "./Character";

export class Player extends Character {

    constructor() {

        super("Player");

        // Override da política de dwell: o player pode ficar no ponto em que
        // parou mesmo sem DwellSpot. Troque para false se o controle futuro
        // exigir que ele sempre procure um local de espera autorizado.
        this.canDwellWithoutSpot = true;

        const visual = new THREE.Mesh(
            new THREE.CylinderGeometry(0.45, 0.45, 1.7, 16),
            new THREE.MeshStandardMaterial({ color: 0x4d8edb })
        );

        visual.castShadow = true;
        this.setVisual(visual, { floorOffset: 0.85 });
        this.addForwardHelper();
        this.object3D.position.set(0, 0, -1);

    }

}
