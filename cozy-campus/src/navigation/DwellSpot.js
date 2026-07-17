import * as THREE from "three";

export class DwellSpot {

    constructor(id, nodeId, {
        position = new THREE.Vector3(),
        rotationY = 0,
        pose = "stand",
        metadata = {}
    } = {}) {

        this.id = id;
        this.nodeId = nodeId;
        this.position = position.clone();
        this.rotationY = rotationY;
        this.pose = pose;
        this.metadata = { ...metadata };
        this.occupant = null;
        this.reservedBy = null;
        this.availableAfter = 0;

    }

    isAvailable(actor = null) {

        return (this.occupant === actor ||
            (!this.occupant && Date.now() >= this.availableAfter)) &&
            (!this.reservedBy || this.reservedBy === actor);

    }

    getDirection(target = new THREE.Vector3()) {

        // Dwell spots are authored in world space. Their local +Z is the same
        // forward convention used by Character and THREE.Object3D.lookAt().
        return target.set(0, 0, 1).applyAxisAngle(
            new THREE.Vector3(0, 1, 0),
            this.rotationY
        ).normalize();

    }

}
