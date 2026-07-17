import * as THREE from "three";

// Cheap kinematic circle solver for the XZ plane. Behavioral systems decide
// who waits or avoids; this guarantees that their final frame positions do not
// retain a small visual penetration.
export class CharacterCollisionSolver {

    constructor(owner, {
        iterations = 2,
        skin = 0.015,
        helperHeight = 0.035
    } = {}) {

        this.owner = owner;
        this.iterations = iterations;
        this.skin = skin;
        this.helperHeight = helperHeight;
        this.helpers = new Map();
        this.actors = [];
        this.initialPositions = new Map();
        this.direction = new THREE.Vector3();
        this.escapeDirection = new THREE.Vector3();

    }

    register(actor) {

        const radius = actor.collisionRadius ?? 0.36;
        const points = [];

        for (let index = 0; index < 32; index++) {

            const angle = index / 32 * Math.PI * 2;
            points.push(new THREE.Vector3(
                Math.cos(angle) * radius,
                this.helperHeight,
                Math.sin(angle) * radius
            ));

        }

        const geometry = new THREE.BufferGeometry().setFromPoints(points);
        const color = actor.visual?.material?.color ?? new THREE.Color(0xffffff);
        const material = new THREE.LineBasicMaterial({
            color,
            depthTest: false,
            transparent: true,
            opacity: 0.9
        });
        const helper = new THREE.LineLoop(geometry, material);

        helper.name = `${actor.name}:CollisionCircleHelper`;
        helper.renderOrder = 1200;
        helper.raycast = () => {};
        actor.object3D.add(helper);
        this.helpers.set(actor, helper);
        this.initialPositions.set(actor, new THREE.Vector3());

    }

    unregister(actor) {

        const helper = this.helpers.get(actor);

        if (!helper) return;

        actor.object3D.remove(helper);
        helper.geometry.dispose();
        helper.material.dispose();
        this.helpers.delete(actor);
        this.initialPositions.delete(actor);

    }

    solve() {

        // Reuse the array, map and vectors because this method runs every
        // frame. Allocating them here produced avoidable garbage-collection
        // spikes as the number of characters increased.
        const actors = this.actors;
        actors.length = 0;

        for (const actor of this.owner.contexts.keys()) {

            if (!actor.isActive()) continue;
            actors.push(actor);
            this.initialPositions.get(actor).copy(actor.object3D.position);

        }

        for (let iteration = 0; iteration < this.iterations; iteration++) {

            for (let firstIndex = 0;
                firstIndex < actors.length;
                firstIndex++) {

                for (let secondIndex = firstIndex + 1;
                    secondIndex < actors.length;
                    secondIndex++) {

                    this.solvePair(
                        actors[firstIndex],
                        actors[secondIndex]
                    );

                }

            }

        }

        for (const actor of actors) {

            const displacement = actor.object3D.position.distanceTo(
                this.initialPositions.get(actor)
            );

            // The solver may move a walking actor away from its sampled
            // Bézier. Rebuild only after all pair corrections, once per frame,
            // so Navigation continues from the actual physical position.
            if (displacement >= 0.02 &&
                actor.navigation.hasPath() &&
                !actor.navigation.isPaused()) {

                this.owner.recoverAfterCollisionDisplacement(actor);

            } else if (displacement >= 0.02 &&
                !actor.navigation.hasPath()) {

                this.owner.recoverDisplacedDwellActor(actor);

            }

        }

    }

    solvePair(first, second) {

        const verticalSeparation = Math.abs(
            first.object3D.position.y - second.object3D.position.y
        );
        const collisionHeight = Math.min(
            first.collisionHeight ?? 1.2,
            second.collisionHeight ?? 1.2
        );

        if (verticalSeparation > collisionHeight) return;

        const minimumDistance =
            (first.collisionRadius ?? 0.36) +
            (second.collisionRadius ?? 0.36) +
            this.skin;

        this.direction.subVectors(
            first.object3D.position,
            second.object3D.position
        ).setY(0);

        const distanceSquared = this.direction.lengthSq();

        if (distanceSquared >= minimumDistance ** 2) return;

        let distance = Math.sqrt(distanceSquared);

        if (distance <= 0.0001) {

            // Registration order provides a deterministic axis for perfectly
            // coincident centers and avoids NaN propagation.
            this.direction.set(1, 0, 0);
            distance = 0;

        } else {

            this.direction.multiplyScalar(1 / distance);

        }

        const penetration = minimumDistance - distance;
        const [firstWeight, secondWeight] = this.getCorrectionWeights(
            first,
            second
        );

        first.object3D.position.addScaledVector(
            this.direction,
            penetration * firstWeight
        );
        second.object3D.position.addScaledVector(
            this.direction,
            -penetration * secondWeight
        );

    }

    getCorrectionWeights(first, second) {

        const firstPriority = this.owner.collisionFailsafe
            .getCommitmentPriority(first);
        const secondPriority = this.owner.collisionFailsafe
            .getCommitmentPriority(second);

        if (firstPriority > secondPriority) return [0, 1];
        if (secondPriority > firstPriority) return [1, 0];

        // Equal commitments share the correction. Actor type is irrelevant;
        // Player and NPC both keep their intent and resume their own route.
        return [0.5, 0.5];

    }

    findEscapePosition(actor, target = null, distance = 0.9) {

        this.escapeDirection.subVectors(
            target ?? actor.object3D.position.clone().add(
                new THREE.Vector3(0, 0, 1)
            ),
            actor.object3D.position
        ).setY(0);

        if (this.escapeDirection.lengthSq() < 0.0001) {

            this.escapeDirection.set(0, 0, 1);

        }

        this.escapeDirection.normalize();
        const left = new THREE.Vector3(
            -this.escapeDirection.z,
            0,
            this.escapeDirection.x
        );
        const right = left.clone().negate();
        const candidates = [left, right].map(direction =>
            actor.object3D.position.clone().addScaledVector(direction, distance)
        );
        const others = [...this.owner.contexts.keys()]
            .filter(other => other !== actor && other.isActive());
        const clearance = position => others.reduce(
            (minimum, other) => Math.min(
                minimum,
                position.distanceToSquared(other.object3D.position)
            ),
            Infinity
        );

        return clearance(candidates[0]) >= clearance(candidates[1])
            ? candidates[0]
            : candidates[1];

    }

    findRetreatPosition(actor, target, distance = 1.1) {

        this.escapeDirection.subVectors(
            actor.object3D.position,
            target
        ).setY(0);

        if (this.escapeDirection.lengthSq() < 0.0001) {

            this.escapeDirection.set(0, 0, -1);

        }

        return actor.object3D.position.clone().addScaledVector(
            this.escapeDirection.normalize(),
            distance
        );

    }

}
