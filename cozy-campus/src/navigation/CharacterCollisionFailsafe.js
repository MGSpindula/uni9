import * as THREE from "three";

// Predictive right-of-way guard. It decides who should slow down before
// contact; Cannon remains responsible only for residual physical separation.
export class CharacterCollisionFailsafe {

    constructor(owner, {
        detectionRadius = 2.4,
        predictionTime = 0.34,
        safetyPadding = 0.1
    } = {}) {

        this.owner = owner;
        this.detectionRadius = detectionRadius;
        this.predictionTime = predictionTime;
        this.safetyPadding = safetyPadding;
        this.waitingFor = new Map();
        this.passing = new Map();
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
            if (this.useDifferentLanes(actor, other)) continue;

            const requiredClearance =
                (actor.collisionRadius ?? 0.36) +
                (other.collisionRadius ?? 0.36) +
                this.safetyPadding;

            const otherTarget = other.navigation.getCurrentWaypoint()?.position;
            this.getIntendedVelocity(other, otherTarget, this.otherVelocity);
            // Once two circles are already touching, use the current clearance
            // so one actor yields immediately instead of both pushing forever.
            const clearance = currentDistance < requiredClearance
                ? currentDistance
                : this.getPredictedClearance(actor, other);

            const shouldYield = this.shouldYield(actor, other);
            const passingTarget = !shouldYield
                ? this.getPassingTarget(
                    actor,
                    other,
                    target,
                    requiredClearance,
                    { requireAhead: true }
                )
                : null;

            if (passingTarget) {

                this.clearWait(actor);
                return {
                    allowed: true,
                    target: passingTarget,
                    temporary: true
                };

            }

            if (clearance < requiredClearance && shouldYield) {

                const lateralTarget = this.getLocalLateralTarget(
                    actor,
                    other,
                    target,
                    true
                );

                if (lateralTarget) {

                    this.clearWait(actor);
                    return {
                        allowed: true,
                        target: lateralTarget,
                        temporary: true
                    };

                }

            }

            if (clearance >= requiredClearance || !shouldYield) continue;

            const yieldingTarget = this.getPassingTarget(
                actor,
                other,
                target,
                requiredClearance,
                { requireAhead: false }
            );

            if (yieldingTarget) {

                this.clearWait(actor);
                return {
                    allowed: true,
                    target: yieldingTarget,
                    temporary: true
                };

            }

            if (clearance < closestClearance) {

                blocker = other;
                closestClearance = clearance;

            }

        }

        if (!blocker) {

            this.clearWait(actor);
            this.passing.delete(actor);
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

    getLocalLateralTarget(actor, other, target, shouldYield) {

        if (!target) return null;

        const relative = other.object3D.position
            .clone()
            .sub(actor.object3D.position)
            .setY(0);
        const forward = this.velocity.clone().setY(0);

        if (forward.lengthSq() < 0.0001) {
            forward.copy(relative);
        }
        if (forward.lengthSq() < 0.0001) return null;

        forward.normalize();
        const side = new THREE.Vector3(
            forward.z,
            0,
            -forward.x
        );
        const step = Math.max(
            (actor.collisionRadius ?? 0.42) +
                (other.collisionRadius ?? 0.42) +
                0.04,
            0.9
        );
        const forwardStep = shouldYield
            ? actor.locomotion.speed * 0.12
            : actor.locomotion.speed * 0.24;
        const origin = actor.object3D.position;
        const previous = this.passing.get(actor);
        const fixedSide = previous?.other === other && previous.lateral
            ? previous.side
            : null;
        const left = origin.clone()
            .addScaledVector(side, step)
            .addScaledVector(forward, forwardStep);
        const right = origin.clone()
            .addScaledVector(side, -step)
            .addScaledVector(forward, forwardStep);
        const leftClearance = this.owner.physics.getClearanceForPosition(
            actor,
            left
        );
        const rightClearance = this.owner.physics.getClearanceForPosition(
            actor,
            right
        );
        const useLeft = fixedSide ?? leftClearance >= rightClearance;
        const candidate = useLeft ? left : right;
        const candidateClearance = useLeft
            ? leftClearance
            : rightClearance;

        // Cannon still owns the final contact correction. The local maneuver
        // only starts when the chosen side is already physically open.
        if (candidateClearance < 0.04) return null;

        if (!shouldYield) {
            const approaching = relative.dot(forward) > -0.1;
            if (!approaching) return null;
        }

        this.passing.set(actor, {
            other,
            target: candidate,
            lateral: true,
            side: useLeft
        });
        return candidate;

    }

    getPassingTarget(
        actor,
        other,
        target,
        requiredClearance,
        { requireAhead = true } = {}
    ) {

        if (!target || (requireAhead &&
            this.getCommitmentPriority(actor) <
            this.getCommitmentPriority(other))) {

            return null;

        }

        const first = actor.navigation.getTraversalState().currentConnection;
        const second = other.navigation.getTraversalState().currentConnection;

        if (!first || !second) return null;

        const sameConnection =
            (
                first.fromId === second.fromId &&
                first.toId === second.toId
            ) ||
            (
                !requireAhead &&
                first.fromId === second.toId &&
                first.toId === second.fromId
            );

        if (!sameConnection) return null;

        const connection = this.owner.graph.requireConnection(
            first.fromId,
            first.toId
        );
        const laneIndex = this.owner.graph.getConnectionLaneIndex(
            first.fromId,
            first.toId,
            actor
        );
        const otherLaneIndex = this.owner.graph.getConnectionLaneIndex(
            second.fromId,
            second.toId,
            other
        );

        if (laneIndex === null || otherLaneIndex !== laneIndex) return null;

        const alternateLane = connection.lanes.find(lane =>
            lane.index !== laneIndex
        );

        if (!alternateLane || alternateLane.occupants.size > 0) {

            return null;

        }

        const direction = this.owner.graph
            .requireNode(first.toId)
            .position.clone()
            .sub(this.owner.graph.requireNode(first.fromId).position)
            .setY(0);

        if (direction.lengthSq() < 0.0001) return null;
        direction.normalize();

        const relative = other.object3D.position
            .clone()
            .sub(actor.object3D.position)
            .setY(0);
        const along = relative.dot(direction);

        // Passing is only useful when the other actor is ahead in the same
        // direction. Yielding may use the same lateral maneuver for head-on
        // traffic, but never changes the authored route.
        if (requireAhead && (along < -0.1 || along > 2.4)) return null;

        const side = new THREE.Vector3(
            direction.z,
            0,
            -direction.x
        );
        const laneOffset = (alternateLane.index - laneIndex) *
            connection.laneWidth;
        const localOffset = side.clone().multiplyScalar(laneOffset);
        const passDistance = requireAhead
            ? Math.max(
                connection.laneWidth,
                actor.locomotion.speed * this.predictionTime
            )
            : Math.min(
                connection.laneWidth * 0.5,
                actor.locomotion.speed * this.predictionTime
            );
        const candidate = actor.object3D.position.clone()
            .addScaledVector(direction, passDistance)
            .add(localOffset);
        const candidateClearance = this.owner.physics.getClearanceForPosition(
            actor,
            candidate
        );

        // Keep a small margin for a passing maneuver. The full predictive
        // safety padding is for braking, while Cannon handles residual contact.
        if (candidateClearance < Math.min(requiredClearance, 0.86)) {
            return null;
        }

        const previous = this.passing.get(actor);
        if (requireAhead && previous && previous.other === other &&
            along > (actor.collisionRadius ?? 0.42) * 2.2) {

            this.passing.delete(actor);
            return null;

        }

        this.passing.set(actor, { other, target: candidate });
        return candidate;

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

        const actors = [...this.owner.contexts.keys()];
        return actors.indexOf(actor) > actors.indexOf(other);

    }

    getCommitmentPriority(actor) {

        const context = this.owner.contexts.get(actor);

        if (!context) return 0;
        if (actor.name === "Player") return 6;
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
        this.passing.delete(actor);

        for (const [waitingActor, blocker] of this.waitingFor) {

            if (blocker === actor) this.clearWait(waitingActor);

        }

    }

    cancel(actor) {

        this.clearWait(actor);
        this.passing.delete(actor);

    }

}
