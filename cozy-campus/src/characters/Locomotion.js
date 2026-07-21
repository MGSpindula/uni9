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
        this.activeCurve = null;
        this.curveDistance = 0;

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

    beginFrame() {

        // Character calls this even while paused. Consequently WAITING and
        // IDLE or interacting actors naturally report zero movement instead of retaining the
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

        this.resetCurve();

        this.direction.subVectors(target, this.object3D.position);

        // Ground-bound traversal follows the horizontal projection of the
        // route. CharacterGrounding samples the actual mesh and exclusively
        // supplies Y, preventing Bézier handles from dipping under a slope.
        if (followSurface) this.direction.y = 0;

        const distance = this.direction.length();

        if (distance <= this.arrivalDistance) {

            if (followSurface) {

                this.object3D.position.x = target.x;
                this.object3D.position.z = target.z;

            } else {

                this.object3D.position.copy(target);

            }
            this.recordMovement(distance, delta);
            return true;

        }

        this.direction.normalize();
        if (rotate) this.motion.turning = this.rotateTowards(target, delta);

        const distanceThisFrame = Math.min(this.speed * delta, distance);

        this.object3D.position.addScaledVector(
            this.direction,
            distanceThisFrame
        );

        this.recordMovement(distanceThisFrame, delta);

        return distanceThisFrame === distance;

    }

    moveAlongCurve(curve, delta, {
        rotate = true,
        followSurface = false,
        startDistance = 0,
        stopDistance = null,
        finishCurve = true
    } = {}) {

        if (this.activeCurve !== curve) {

            this.activeCurve = curve;
            // A route can be rebuilt while collision/traffic recovery keeps
            // the actor midway through it. Project the real body onto the new
            // curve instead of restarting at distance zero and walking back.
            this.curveDistance = this.findClosestCurveDistance(curve, {
                minimum: startDistance,
                maximum: stopDistance ?? curve.getLength()
            });

        }

        const length = curve.getLength();

        if (length <= Number.EPSILON) return true;

        const targetDistance = Math.min(
            stopDistance ?? length,
            length
        );
        const nextDistance = Math.min(
            this.curveDistance + this.speed * delta,
            targetDistance
        );
        const progress = nextDistance / length;
        const target = curve.getPointAt(progress);
        const tangent = curve.getTangentAt(progress);
        const distanceMoved = nextDistance - this.curveDistance;

        if (followSurface) {

            this.object3D.position.x = target.x;
            this.object3D.position.z = target.z;

        } else {

            this.object3D.position.copy(target);

        }

        if (rotate && tangent.lengthSq() > 0.0001) {

            this.motion.turning = this.rotateTowards(
                this.object3D.position.clone().add(tangent),
                delta
            );

        }

        this.curveDistance = nextDistance;
        this.recordMovement(distanceMoved, delta);

        if (nextDistance < targetDistance) return false;

        // A route-wide spline has semantic anchors along one persistent
        // curve. Reaching a node pauses at its distance but does not reset the
        // curve; after traffic accepts the next segment locomotion continues
        // from this exact arc-length position.
        if (finishCurve || targetDistance >= length) this.resetCurve();
        return true;

    }

    resetCurve() {

        this.activeCurve = null;
        this.curveDistance = 0;

    }

    findClosestCurveDistance(curve, {
        minimum = 0,
        maximum = null
    } = {}) {

        const length = curve.getLength();

        // A spline with a single repeated point has no meaningful progress.
        // Returning here also avoids dividing by zero while projecting the
        // actor after traffic or collision recovery rebuilds its route.
        if (length <= Number.EPSILON) return 0;

        const minimumProgress = THREE.MathUtils.clamp(
            minimum / length,
            0,
            1
        );
        const maximumProgress = THREE.MathUtils.clamp(
            (maximum ?? length) / length,
            minimumProgress,
            1
        );
        const samples = Math.max(64, Math.ceil(length * 12));
        let bestProgress = minimumProgress;
        let bestDistance = Infinity;

        for (let index = 0; index <= samples; index++) {

            const progress = THREE.MathUtils.lerp(
                minimumProgress,
                maximumProgress,
                index / samples
            );
            const point = curve.getPointAt(progress);
            const distance = point.distanceToSquared(this.object3D.position);

            if (distance >= bestDistance) continue;

            bestDistance = distance;
            bestProgress = progress;

        }

        // Refine the best sampled interval without allocating a physics body
        // or performing an expensive generic closest-point search.
        const searchStep = (maximumProgress - minimumProgress) / samples;
        let lower = Math.max(
            minimumProgress,
            bestProgress - searchStep
        );
        let upper = Math.min(
            maximumProgress,
            bestProgress + searchStep
        );

        for (let iteration = 0; iteration < 7; iteration++) {

            const first = lower + (upper - lower) / 3;
            const second = upper - (upper - lower) / 3;
            const firstDistance = curve.getPointAt(first)
                .distanceToSquared(this.object3D.position);
            const secondDistance = curve.getPointAt(second)
                .distanceToSquared(this.object3D.position);

            if (firstDistance <= secondDistance) upper = second;
            else lower = first;

        }

        return (lower + upper) * 0.5 * length;

    }

    recordMovement(distanceMoved, delta) {

        // Contact correction and tiny avoidance nudges should not be treated
        // as a full locomotion step, otherwise walk-cycle feedback jitters.
        const effectiveDistance = distanceMoved < 0.012 ? 0 : distanceMoved;

        this.motion.distanceMoved = effectiveDistance;
        this.motion.speed = delta > 0 ? distanceMoved / delta : 0;
        this.motion.normalizedSpeed = this.speed > 0
            ? Math.min(this.motion.speed / this.speed, 1)
            : 0;
        this.motion.moving = effectiveDistance > 0;
        if (!this.motion.moving) {
            this.motion.speed = 0;
            this.motion.normalizedSpeed = 0;
        }

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

    isBlockedBySlope() {

        return false;

    }

}
