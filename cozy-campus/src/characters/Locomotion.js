import * as THREE from "three";

export class Locomotion {

    constructor(object3D, { speed = 3, turnSpeed = 8, arrivalDistance = 0.05 } = {}) {

        // Locomotion owns physical displacement, never animation selection.
        this.object3D = object3D;
        this.speed = speed;
        this.turnSpeed = turnSpeed;
        this.arrivalDistance = arrivalDistance;

        this.direction = new THREE.Vector3();
        this.lookTarget = new THREE.Object3D();

    }

    // -----------------------------
    // Movement
    // -----------------------------

    moveTo(target, delta) {

        this.direction.subVectors(target, this.object3D.position);
        this.direction.y = 0;

        const distance = this.direction.length();

        if (distance <= this.arrivalDistance) {

            // The navigation target lives on the floor; keep the character height.
            this.object3D.position.x = target.x;
            this.object3D.position.z = target.z;
            return true;

        }

        this.direction.normalize();
        this.rotateTowards(target, delta);

        const distanceThisFrame = Math.min(this.speed * delta, distance);

        this.object3D.position.addScaledVector(
            this.direction,
            distanceThisFrame
        );

        return distanceThisFrame === distance;

    }

    // -----------------------------
    // Rotation
    // -----------------------------

    rotateTowards(target, delta) {

        // Keeping the target at the current height prevents the character from tilting.
        this.lookTarget.position.copy(this.object3D.position);
        this.lookTarget.lookAt(target.x, this.object3D.position.y, target.z);

        this.object3D.quaternion.slerp(
            this.lookTarget.quaternion,
            Math.min(this.turnSpeed * delta, 1)
        );

    }

}
