import * as THREE from "three";

// Predictive brake only. CharacterCollisionSolver owns physical separation.
// Keeping those jobs separate prevents collision recovery from becoming a
// second navigation state machine that can pause and lose an actor's route.
export class CharacterCollisionFailsafe {

    constructor(owner, {
        detectionRadius = 2.4,
        predictionTime = 0.28,
        safetyPadding = 0.05
    } = {}) {

        this.owner = owner;
        this.detectionRadius = detectionRadius;
        this.predictionTime = predictionTime;
        this.safetyPadding = safetyPadding;
        this.waitingFor = new Map();
        this.velocity = new THREE.Vector3();
        this.otherVelocity = new THREE.Vector3();
        this.relativePosition = new THREE.Vector3();
        this.relativeVelocity = new THREE.Vector3();

    }

    canMove(actor, target) {

        this.getIntendedVelocity(actor, target, this.velocity);
        let blocker = null;
        let closestClearance = Infinity;

        for (const other of this.owner.contexts.keys()) {

            if (other === actor || !other.isActive()) continue;

            const verticalSeparation = Math.abs(
                actor.object3D.position.y - other.object3D.position.y
            );
            const collisionHeight = Math.min(
                actor.collisionHeight ?? 1.2,
                other.collisionHeight ?? 1.2
            );

            if (verticalSeparation > collisionHeight) continue;

            const currentDistance = actor.object3D.position.distanceTo(
                other.object3D.position
            );

            if (currentDistance > this.detectionRadius) continue;

            // Two reserved lanes are already the collision solution. Do not
            // apply a second, lane-unaware predictive brake while both actors
            // are traversing the same connection on different sides.
            if (this.useDifferentLanes(actor, other)) continue;

            const requiredClearance =
                (actor.collisionRadius ?? 0.36) +
                (other.collisionRadius ?? 0.36) +
                this.safetyPadding;

            // Once circles overlap, movement must remain enabled: walking away
            // can resolve it and the solver guarantees physical separation at
            // the end of this frame. Braking both here creates a deadlock.
            if (currentDistance < requiredClearance) continue;

            const otherTarget = other.navigation.getCurrentWaypoint()?.position;
            this.getIntendedVelocity(other, otherTarget, this.otherVelocity);
            const clearance = this.getPredictedClearance(actor, other);

            if (clearance >= requiredClearance ||
                !this.shouldYield(actor, other)) continue;

            if (clearance < closestClearance) {

                blocker = other;
                closestClearance = clearance;

            }

        }

        if (!blocker) {

            this.clearWait(actor);
            return true;

        }

        const previous = this.waitingFor.get(actor);
        this.waitingFor.set(actor, blocker);

        if (previous !== blocker) {

            console.log(
                `[CollisionFailsafe] ${actor.name} waits for ${blocker.name}; ` +
                `predicted clearance ${closestClearance.toFixed(2)}.`
            );

        }

        return false;

    }

    getIntendedVelocity(actor, target, result) {

        result.set(0, 0, 0);

        if (!target || actor.navigation.isPaused()) return result;

        result.subVectors(target, actor.object3D.position).setY(0);

        if (result.lengthSq() <= 0.0001) return result.set(0, 0, 0);

        return result.normalize().multiplyScalar(actor.locomotion.speed);

    }

    useDifferentLanes(actor, other) {

        const first = actor.navigation.getTraversalState().currentConnection;
        const second = other.navigation.getTraversalState().currentConnection;

        if (!first || !second) return false;

        const sameConnection =
            (first.fromId === second.fromId && first.toId === second.toId) ||
            (first.fromId === second.toId && first.toId === second.fromId);

        if (!sameConnection) return false;

        const firstLane = this.owner.graph.getConnectionLaneIndex(
            first.fromId,
            first.toId,
            actor
        );
        const secondLane = this.owner.graph.getConnectionLaneIndex(
            second.fromId,
            second.toId,
            other
        );

        return firstLane !== null &&
            secondLane !== null &&
            firstLane !== secondLane;

    }

    getPredictedClearance(actor, other) {

        this.relativePosition.subVectors(
            other.object3D.position,
            actor.object3D.position
        ).setY(0);
        this.relativeVelocity.subVectors(
            this.otherVelocity,
            this.velocity
        ).setY(0);

        const speedSquared = this.relativeVelocity.lengthSq();
        const closestTime = speedSquared > 0.0001
            ? THREE.MathUtils.clamp(
                -this.relativePosition.dot(this.relativeVelocity) /
                    speedSquared,
                0,
                this.predictionTime
            )
            : 0;

        return this.relativePosition.addScaledVector(
            this.relativeVelocity,
            closestTime
        ).length();

    }

    shouldYield(actor, other) {

        const actorPriority = this.getCommitmentPriority(actor);
        const otherPriority = this.getCommitmentPriority(other);

        if (actorPriority !== otherPriority) return actorPriority < otherPriority;
        if (this.waitingFor.get(other) === actor) return false;

        const actorMoving = this.velocity.lengthSq() > 0.0001;
        const otherMoving = this.otherVelocity.lengthSq() > 0.0001;

        if (!actorMoving) return false;
        if (!otherMoving) return true;

        // Registration order is only a deterministic tie-breaker. Player and
        // NPC otherwise obey the same collision and intent rules.
        const actors = [...this.owner.contexts.keys()];
        return actors.indexOf(actor) > actors.indexOf(other);

    }

    getCommitmentPriority(actor) {

        const context = this.owner.contexts.get(actor);

        if (!context) return 0;
        if (context.activeInteraction) return 5;

        const interaction = context.pendingInteraction?.point;
        const approach = interaction?.via;
        const reserved = Boolean(
            interaction?.reservations.has(actor) ||
            interaction?.occupants.has(actor) ||
            approach?.reservations.has(actor) ||
            approach?.occupants.has(actor)
        );

        if (reserved) return 4;
        if (context.interactionPoint) return 3;
        if (context.dwellSpot?.occupant === actor) return 2;
        if (context.dwellSpot?.reservedBy === actor) return 1;
        return 0;

    }

    clearWait(actor) {

        const blocker = this.waitingFor.get(actor);

        if (!blocker) return;

        this.waitingFor.delete(actor);
        console.log(
            `[CollisionFailsafe] ${actor.name} may continue; ` +
            `${blocker.name} is clear.`
        );

    }

    unregister(actor) {

        this.cancel(actor);

        for (const [waitingActor, blocker] of this.waitingFor) {

            if (blocker === actor) this.clearWait(waitingActor);

        }

    }

    cancel(actor) {

        this.clearWait(actor);

    }

}
