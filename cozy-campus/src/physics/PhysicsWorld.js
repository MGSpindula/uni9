import * as CANNON from "cannon-es";
import * as THREE from "three";

// Cannon owns only physical separation. Navigation remains authoritative for
// destinations, reservations and route progress.
export class PhysicsWorld {

    constructor(owner, {
        fixedTimeStep = 1 / 60,
        maxSubSteps = 3,
        contactSkin = 0.025,
        manualContactSeparation = false
    } = {}) {

        this.owner = owner;
        this.fixedTimeStep = fixedTimeStep;
        this.maxSubSteps = maxSubSteps;
        this.contactSkin = contactSkin;
        this.manualContactSeparation =
            manualContactSeparation;
        this.world = new CANNON.World();
        this.world.gravity.set(0, 0, 0);
        this.world.broadphase = new CANNON.SAPBroadphase(this.world);
        this.world.defaultContactMaterial.friction = 0;
        this.world.defaultContactMaterial.restitution = 0;
        this.characterMaterial = new CANNON.Material("character");
        this.actorBodies = new Map();

        this.world.addContactMaterial(new CANNON.ContactMaterial(
            this.characterMaterial,
            this.characterMaterial,
            {
                friction: 0,
                restitution: 0,
                contactEquationStiffness: 1e7,
                contactEquationRelaxation: 4
            }
        ));

    }

    registerActor(actor) {

        const radius = actor.collisionRadius ?? 0.36;
        const body = new CANNON.Body({
            mass: 1,
            material: this.characterMaterial,
            type: CANNON.Body.DYNAMIC,
            fixedRotation: true,
            linearDamping: 0.05,
            angularDamping: 1,
            allowSleep: false
        });

        body.addShape(new CANNON.Sphere(radius + this.contactSkin));
        body.position.set(
            actor.object3D.position.x,
            actor.object3D.position.y + radius,
            actor.object3D.position.z
        );
        body.velocity.set(0, 0, 0);
        body.angularVelocity.set(0, 0, 0);
        body.characterRadius = radius;
        body.collisionResponse = true;
        this.world.addBody(body);
        this.actorBodies.set(actor, body);

    }

    unregisterActor(actor) {

        const body = this.actorBodies.get(actor);

        if (!body) return;

        this.world.removeBody(body);
        this.actorBodies.delete(actor);

    }

    solve(delta) {

        const safeDelta = Math.max(delta, 1 / 120);

        for (const [actor, body] of this.actorBodies) {

            if (!actor.isActive()) continue;

            // Navigation/locomotion own intent. Cannon only separates overlaps
            // from the already chosen frame position. Use velocity-to-target
            // instead of teleporting X/Z so contacts are resolved in-between.
            const targetX = actor.object3D.position.x;
            const targetZ = actor.object3D.position.z;
            const deltaX = targetX - body.position.x;
            const deltaZ = targetZ - body.position.z;

            // Commands like spawn/warp may intentionally jump far; snap those
            // to keep navigation deterministic while still letting normal walk
            // movement use physical contact resolution.
            if (Math.hypot(deltaX, deltaZ) > 1.25) {

                body.position.x = targetX;
                body.position.z = targetZ;
                body.velocity.x = 0;
                body.velocity.z = 0;

            } else {

                body.velocity.x = deltaX / safeDelta;
                body.velocity.z = deltaZ / safeDelta;

            }

            body.position.y = actor.object3D.position.y + body.characterRadius;
            body.velocity.y = 0;
            body.angularVelocity.set(0, 0, 0);
            body.wakeUp();

        }

        this.world.step(this.fixedTimeStep, delta, this.maxSubSteps);

        for (const [actor, body] of this.actorBodies) {

            if (!actor.isActive()) continue;

            actor.object3D.position.x = body.position.x;
            actor.object3D.position.z = body.position.z;

        }

        if (this.manualContactSeparation) {

            this.separateContacts();

        }

    }

    separateContacts() {

        const actors = [...this.actorBodies.entries()]
            .filter(([actor]) => actor.isActive());

        for (let firstIndex = 0; firstIndex < actors.length; firstIndex++) {

            const [firstActor, firstBody] = actors[firstIndex];

            for (let secondIndex = firstIndex + 1;
                secondIndex < actors.length;
                secondIndex++) {

                const [secondActor, secondBody] = actors[secondIndex];
                const firstRadius = this.getActorRadius(firstActor);
                const secondRadius = this.getActorRadius(secondActor);
                const minimumDistance =
                    firstRadius + secondRadius + this.contactSkin;
                let deltaX = secondBody.position.x - firstBody.position.x;
                let deltaZ = secondBody.position.z - firstBody.position.z;
                let distance = Math.hypot(deltaX, deltaZ);

                if (distance >= minimumDistance) continue;

                if (distance < 0.0001) {

                    const sign = firstIndex % 2 === 0 ? 1 : -1;
                    deltaX = sign;
                    deltaZ = 0;
                    distance = 1;

                }

                const correction = (minimumDistance - distance) / distance;
                const correctionShare = 0.5;
                const moveX = deltaX * correction * correctionShare;
                const moveZ = deltaZ * correction * correctionShare;

                firstBody.position.x -= moveX;
                firstBody.position.z -= moveZ;
                secondBody.position.x += moveX;
                secondBody.position.z += moveZ;

                firstActor.object3D.position.x = firstBody.position.x;
                firstActor.object3D.position.z = firstBody.position.z;
                secondActor.object3D.position.x = secondBody.position.x;
                secondActor.object3D.position.z = secondBody.position.z;

            }

        }

    }

    findEscapePosition(actor, target = null, distance = 0.9) {

        const origin = actor.object3D.position;
        const radius = this.getActorRadius(actor);
        const forward = target
            ? target.clone().sub(origin)
            : new THREE.Vector3(0, 0, 1).applyQuaternion(actor.object3D.quaternion);
        forward.y = 0;

        if (forward.lengthSq() < 0.0001) {

            forward.set(0, 0, 1).applyQuaternion(actor.object3D.quaternion);
            forward.y = 0;

        }

        forward.normalize();
        const left = forward.clone();
        left.set(-forward.z, 0, forward.x);
        const right = left.clone().negate();
        const step = Math.max(distance, radius * 2.2);
        const leftCandidate = origin.clone().addScaledVector(left, step);
        const rightCandidate = origin.clone().addScaledVector(right, step);
        const leftClearance = this.getClearanceForPosition(actor, leftCandidate);
        const rightClearance = this.getClearanceForPosition(actor, rightCandidate);

        return leftClearance >= rightClearance
            ? leftCandidate
            : rightCandidate;

    }

    findRetreatPosition(actor, target, distance = 1.1) {

        const origin = actor.object3D.position;
        const away = origin.clone().sub(target).setY(0);

        if (away.lengthSq() < 0.0001) {

            away.set(0, 0, -1);

        }

        const radius = this.getActorRadius(actor);
        const step = Math.max(distance, radius * 2.6);

        return origin.clone().addScaledVector(away.normalize(), step);

    }

    getClearanceForPosition(actor, position) {

        let minimum = Infinity;

        for (const [other, body] of this.actorBodies) {

            if (other === actor || !other.isActive()) continue;

            const distance = Math.hypot(
                position.x - body.position.x,
                position.z - body.position.z
            ) - this.getActorRadius(actor) - this.getActorRadius(other);
            minimum = Math.min(minimum, distance);

        }

        return minimum;

    }

    getActorRadius(actor) {

        const body = this.actorBodies.get(actor);

        return body?.characterRadius ?? actor.collisionRadius ?? 0.36;

    }

}
