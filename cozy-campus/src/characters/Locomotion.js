import * as THREE from "three";

export class Locomotion {

    constructor(object3D, {
        speed = 3,
        turnSpeed = 8,
        arrivalDistance = 0.05,
        maxStepHeight = 0.35
    } = {}) {

        // Locomotion owns physical displacement, never animation selection.
        this.object3D = object3D;
        this.speed = speed;
        this.turnSpeed = turnSpeed;
        this.arrivalDistance = arrivalDistance;

        this.direction = new THREE.Vector3();
        this.lookTarget = new THREE.Object3D();
        this.maxStepHeight = maxStepHeight;
        this.physicsBody = null;
        this.slopeDetector = null;
        this.walkingHeight = 0;
        this.blockedBySlope = false;

    }

    setPhysicsBody(body, { walkingHeight = 0 } = {}) {

        this.physicsBody = body;
        this.walkingHeight = walkingHeight;

    }

    setSlopeDetector(detector) {

        this.slopeDetector = detector;

    }

    isBlockedBySlope() {

        return this.blockedBySlope;

        // Reused every frame. Navigation and animation may read this snapshot,
        // but Locomotion remains the only system allowed to write it.
        this.motion = {
            distanceMoved: 0,
            speed: 0,
            normalizedSpeed: 0,
            moving: false,
            turning: false
        };

    }

    // -----------------------------
    // Movement
    // -----------------------------

<<<<<<< HEAD
    beginFrame() {

        // Character calls this even while paused. Consequently WAITING and
        // DWELLING naturally report zero movement instead of retaining the
        // velocity from the last walking frame.
        this.motion.distanceMoved = 0;
        this.motion.speed = 0;
        this.motion.normalizedSpeed = 0;
        this.motion.moving = false;
        this.motion.turning = false;

    }

    moveTo(target, delta, {
        rotate = true,
        followSurface = false
    } = {}) {
=======
    moveTo(target, delta) {
        this.blockedBySlope = false;
>>>>>>> b09e5f4 (Save uncommitted changes)

        this.direction.subVectors(target, this.object3D.position);

        // Ground-bound traversal follows the horizontal projection of the
        // route. CharacterGrounding samples the actual mesh and exclusively
        // supplies Y, preventing Bézier handles from dipping under a slope.
        if (followSurface) this.direction.y = 0;

        const distance = this.direction.length();

        if (distance <= this.arrivalDistance) {

<<<<<<< HEAD
            if (followSurface) {

                this.object3D.position.x = target.x;
                this.object3D.position.z = target.z;

            } else {

                this.object3D.position.copy(target);

            }
            this.recordMovement(distance, delta);
=======
            // The navigation target lives on the floor; keep the character height.
            this.object3D.position.x = target.x;
            this.object3D.position.z = target.z;

            if (this.physicsBody) {

                this.physicsBody.velocity.x = 0;
                this.physicsBody.velocity.z = 0;

            }

>>>>>>> b09e5f4 (Save uncommitted changes)
            return true;

        }

        this.direction.normalize();
        if (rotate) this.motion.turning = this.rotateTowards(target, delta);

        const distanceThisFrame = Math.min(this.speed * delta, distance);
        const speedPerSecond = distanceThisFrame / Math.max(delta, 0.0001);
        const velocity = this.direction.clone().multiplyScalar(speedPerSecond);

        if (this.slopeDetector) {

            const slopeInfo = this.slopeDetector.detectSlope(
                this.object3D.position,
                this.direction,
                1.25
            );

            if (!slopeInfo.isClimbable) {
                this.blockedBySlope = true;

                if (this.physicsBody) {

                    this.physicsBody.velocity.x = 0;
                    this.physicsBody.velocity.z = 0;

                }

                return false;

            }

            const speedMultiplier =
                this.slopeDetector.getMovementSpeedMultiplier(slopeInfo.slopeAngle) *
                this.slopeDetector.getGravityMultiplier(slopeInfo.slopeAngle);

            velocity.multiplyScalar(speedMultiplier);

        }

        if (this.physicsBody) {

            this.physicsBody.velocity.x = velocity.x;
            this.physicsBody.velocity.z = velocity.z;
            this.applyGrounding(delta);

        } else {

            this.object3D.position.addScaledVector(
                this.direction,
                distanceThisFrame
            );
            this.applyGrounding(delta);

        }

        this.recordMovement(distanceThisFrame, delta);

        return distanceThisFrame === distance;

    }

<<<<<<< HEAD
    recordMovement(distanceMoved, delta) {

        this.motion.distanceMoved = distanceMoved;
        this.motion.speed = delta > 0 ? distanceMoved / delta : 0;
        this.motion.normalizedSpeed = this.speed > 0
            ? Math.min(this.motion.speed / this.speed, 1)
            : 0;
        this.motion.moving = distanceMoved > 0;

    }

    separateFrom(direction, distance, delta) {

        if (distance <= 0 || direction.lengthSq() <= 0.0001) return 0;

        const distanceThisFrame = Math.min(distance, this.speed * 0.5 * delta);

        this.object3D.position.addScaledVector(
            direction.normalize(),
            distanceThisFrame
        );
        this.recordMovement(distanceThisFrame, delta);
        return distanceThisFrame;
=======
    applyGrounding(delta) {

        if (!this.slopeDetector) return;

        const projected = this.object3D.position.clone();
        const groundY = this.slopeDetector.getGroundHeight(
            projected,
            this.object3D.position.y
        );
        const nextY = groundY + this.walkingHeight;
        const stepDelta = nextY - this.object3D.position.y;

        // Prevent stepping onto very high ledges in one frame.
        if (stepDelta > this.maxStepHeight) {

            if (this.physicsBody) {

                this.physicsBody.velocity.x = 0;
                this.physicsBody.velocity.z = 0;

            }

            return;

        }

        if (this.physicsBody) {

            const climbVelocity = stepDelta > 0
                ? stepDelta / Math.max(delta, 0.0001)
                : 0;
            this.physicsBody.velocity.y = Math.max(
                this.physicsBody.velocity.y,
                climbVelocity
            );

        } else {

            this.object3D.position.y += stepDelta * Math.min(delta * 12, 1);

        }
>>>>>>> b09e5f4 (Save uncommitted changes)

    }

    // -----------------------------
    // Rotation
    // -----------------------------

    rotateTowards(target, delta) {

        // Keeping the target at the current height prevents the character from tilting.
        this.lookTarget.position.copy(this.object3D.position);
        this.lookTarget.lookAt(target.x, this.object3D.position.y, target.z);

        const angleBefore = this.object3D.quaternion.angleTo(
            this.lookTarget.quaternion
        );

        this.object3D.quaternion.slerp(
            this.lookTarget.quaternion,
            Math.min(this.turnSpeed * delta, 1)
        );

        return angleBefore > 0.01;

    }

    alignToDirection(direction, delta, threshold = 0.01) {

        this.lookTarget.position.copy(this.object3D.position).add(direction);
        this.lookTarget.position.y = this.object3D.position.y;

        const targetQuaternion = this.lookTarget.quaternion;

        // Object3D.lookAt() updates its quaternion from its position. Keep the
        // helper object at the actor position and look one unit forward.
        this.lookTarget.position.copy(this.object3D.position);
        this.lookTarget.lookAt(
            this.object3D.position.x + direction.x,
            this.object3D.position.y,
            this.object3D.position.z + direction.z
        );

        const angleBefore = this.object3D.quaternion.angleTo(targetQuaternion);

        this.object3D.quaternion.slerp(
            targetQuaternion,
            Math.min(this.turnSpeed * delta, 1)
        );

        this.motion.turning ||= angleBefore > threshold;

        return 1 - Math.abs(
            this.object3D.quaternion.dot(targetQuaternion)
        ) <= threshold;

    }

    getMotionState() {

        return this.motion;

    }

}
