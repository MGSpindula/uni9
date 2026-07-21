import * as THREE from "three";
import { SpatialHash } from "./SpatialHash.js";

// CollisionFailsafe is only a predictive brake.
//
// It deliberately does NOT create sidesteps, temporary waypoints or routes.
// NavigationGraph chooses the route, NavigationTrafficSystem owns queues and
// lane reservations, and PhysicsWorld separates the occasional residual
// contact. Keeping local avoidance out of this class prevents two actors from
// repeatedly choosing opposite sides and oscillating around a node.
export class CharacterCollisionFailsafe {

    constructor(owner, {
        detectionRadius = 1.8,
        predictionTime = 0.3,
        safetyPadding = 0.05
    } = {}) {

        this.owner = owner;
        this.detectionRadius = detectionRadius;
        this.predictionTime = predictionTime;
        this.safetyPadding = safetyPadding;
        this.waitingFor = new Map();
        this.waitDetails = new Map();
        this.velocity = new THREE.Vector3();
        this.otherVelocity = new THREE.Vector3();
        this.relativePosition = new THREE.Vector3();
        this.relativeVelocity = new THREE.Vector3();
        this.spatialHash = new SpatialHash(detectionRadius);
        this.neighbors = [];
        this.actorOrder = new Map();
        this.frameActors = [];
        this.spatialHashThreshold = 16;
        this.metrics = {
            actors: 0,
            queries: 0,
            candidateChecks: 0
        };

    }

    beginFrame(actors = [...this.owner.agents.keys()]) {

        const activeActors = actors.filter(actor => actor.isActive());

        this.frameActors = activeActors;

        if (activeActors.length >= this.spatialHashThreshold) {
            this.spatialHash.rebuild(activeActors);
        }
        this.actorOrder.clear();
        activeActors.forEach((actor, index) => {
            this.actorOrder.set(actor, index);
        });
        this.metrics.actors = activeActors.length;
        this.metrics.queries = 0;
        this.metrics.candidateChecks = 0;

    }

    canMove(actor, target) {

        // Traffic is authoritative near a connection endpoint. A local
        // collision maneuver must never bypass an arrival/departure queue.
        const endpointBlocker = this.getLaneEndpointBlocker(actor);

        if (endpointBlocker) {

            const previous = this.waitingFor.get(actor);
            this.waitingFor.set(actor, endpointBlocker);
            this.waitDetails.set(actor, {
                blocker: endpointBlocker,
                kind: "endpoint",
                clearance: this.getPlanarDistance(actor, endpointBlocker)
            });

            if (previous !== endpointBlocker) {

                console.log(
                    `[CollisionFailsafe] ${actor.name} waits before the ` +
                    `endpoint for ${endpointBlocker.name}.`
                );

            }

            return false;

        }

        this.getIntendedVelocity(actor, target, this.velocity);
        let blocker = null;
        let closestClearance = Infinity;
        let collisionKind = "predicted";

        const nearbyActors = this.frameActors.length >=
            this.spatialHashThreshold
            ? this.spatialHash.queryRadius(
                actor.object3D.position,
                this.detectionRadius,
                this.neighbors
            )
            : this.frameActors;
        this.metrics.queries++;

        for (const other of nearbyActors) {

            if (other === actor || !other.isActive()) continue;
            this.metrics.candidateChecks++;
            if (!this.hasVerticalOverlap(actor, other)) continue;

            const currentDistance = this.getPlanarDistance(actor, other);

            if (currentDistance > this.detectionRadius) continue;

            // Two actors already committed to different lanes have a valid
            // topological solution. Let them continue instead of adding a
            // second, lane-unaware avoidance rule.
            if (this.useDifferentLanes(actor, other)) continue;

            const requiredClearance =
                (actor.collisionRadius ?? 0.36) +
                (other.collisionRadius ?? 0.36) +
                this.safetyPadding;
            const otherTarget = other.navigation
                .getCurrentWaypoint()?.position;

            this.getIntendedVelocity(other, otherTarget, this.otherVelocity);

            // Once bodies overlap, PhysicsWorld owns separation. Permit an
            // actor that is moving away, or the deterministic priority actor,
            // so the predictive brake cannot freeze both participants.
            if (currentDistance < requiredClearance) {

                if (this.isMovingAway(actor, other) ||
                    !this.shouldYield(actor, other)) continue;

                blocker = other;
                closestClearance = currentDistance;
                collisionKind = "overlap";
                continue;

            }

            const predictedClearance = this.getPredictedClearance(
                actor,
                other
            );

            if (predictedClearance >= requiredClearance ||
                !this.shouldYield(actor, other)) continue;

            if (predictedClearance < closestClearance) {

                blocker = other;
                closestClearance = predictedClearance;
                collisionKind = "predicted";

            }

        }

        if (!blocker) {

            this.clearWait(actor);
            return true;

        }

        const previous = this.waitingFor.get(actor);
        this.waitingFor.set(actor, blocker);
        this.waitDetails.set(actor, {
            blocker,
            kind: collisionKind,
            clearance: closestClearance
        });

        if (previous !== blocker) {

            console.log(
                `[CollisionFailsafe] ${actor.name} waits for ` +
                `${blocker.name}; predicted clearance ` +
                `${closestClearance.toFixed(2)}.`
            );

        }

        return false;

    }

    getLaneEndpointBlocker(actor) {

        const traffic = this.owner.traffic;
        const graph = this.owner.graph;
        const connection = actor.navigation
            .getTraversalState().currentConnection;

        if (!traffic || !connection) return null;
        if (!traffic.isQueuedAtNode(connection.toId, actor)) return null;
        // A planned arrival ahead in the queue has no collision body. Braking
        // here used to leave actors frozen after an interaction until that
        // remote reservation disappeared. Only a real occupant may trigger
        // endpoint collision waiting; traffic order is settled on arrival.
        if (this.owner.trafficState.isNodePhysicallyAvailable(
            connection.toId,
            actor
        )) return null;

        const laneIndex = this.owner.trafficState.getConnectionLaneIndex(
            connection.fromId,
            connection.toId,
            actor
        );

        if (laneIndex === null) return null;

        const endpoint = this.owner.routeGeometry.getConnectionLaneNodePosition(
            connection.toId,
            connection.fromId,
            connection.toId,
            laneIndex
        );
        const stoppingDistance = Math.max(
            0.85,
            (actor.collisionRadius ?? 0.42) * 2.2
        );

        if (actor.object3D.position.distanceTo(endpoint) >
            stoppingDistance) return null;

        const state = this.owner.trafficState.getNodeState(connection.toId);

        return [...state.occupants].find(candidate =>
            candidate !== actor && !state.restingAgents.has(candidate)
        ) ?? null;

    }

    hasVerticalOverlap(actor, other) {

        const separation = Math.abs(
            actor.object3D.position.y - other.object3D.position.y
        );
        const collisionHeight = Math.min(
            actor.collisionHeight ?? 1.2,
            other.collisionHeight ?? 1.2
        );

        return separation <= collisionHeight;

    }

    getPlanarDistance(actor, other) {

        const deltaX = actor.object3D.position.x -
            other.object3D.position.x;
        const deltaZ = actor.object3D.position.z -
            other.object3D.position.z;

        return Math.hypot(deltaX, deltaZ);

    }

    getIntendedVelocity(actor, target, result) {

        result.set(0, 0, 0);

        if (!target || actor.navigation.isPaused()) return result;

        result.subVectors(target, actor.object3D.position).setY(0);

        if (result.lengthSq() <= 0.0001) return result.set(0, 0, 0);

        return result.normalize().multiplyScalar(actor.locomotion.speed);

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

    isMovingAway(actor, other) {

        this.relativePosition.subVectors(
            other.object3D.position,
            actor.object3D.position
        ).setY(0);

        return this.velocity.dot(this.relativePosition) <= 0;

    }

    useDifferentLanes(actor, other) {

        const first = actor.navigation.getTraversalState().currentConnection;
        const second = other.navigation.getTraversalState().currentConnection;

        if (!first || !second) return false;

        const sameConnection =
            (first.fromId === second.fromId && first.toId === second.toId) ||
            (first.fromId === second.toId && first.toId === second.fromId);

        if (!sameConnection) return false;

        const firstLane = this.owner.trafficState.getConnectionLaneIndex(
            first.fromId,
            first.toId,
            actor
        );
        const secondLane = this.owner.trafficState.getConnectionLaneIndex(
            second.fromId,
            second.toId,
            other
        );

        return firstLane !== null &&
            secondLane !== null &&
            firstLane !== secondLane;

    }

    shouldYield(actor, other) {

        const actorPriority = this.getCommitmentPriority(actor);
        const otherPriority = this.getCommitmentPriority(other);

        if (actorPriority !== otherPriority) {

            return actorPriority < otherPriority;

        }

        // Stable registration order resolves ties. Unlike reciprocal
        // waiting-state checks, this decision cannot flip from frame to frame.
        return (this.actorOrder.get(actor) ?? Infinity) >
            (this.actorOrder.get(other) ?? Infinity);

    }

    getCommitmentPriority(actor) {

        const context = this.owner.agents.get(actor);
        const base = actor.navigationPriority ?? 0;

        if (!context) return base;
        if (context.activeInteraction) return base + 3;

        const interaction = context.pendingInteraction?.point;
        const approach = interaction?.via;
        const reserved = Boolean(
            interaction?.reservations.has(actor) ||
            interaction?.occupants.has(actor) ||
            approach?.reservations.has(actor) ||
            approach?.occupants.has(actor)
        );

        if (reserved) return base + 2;
        if (context.interactionPoint) return base + 1;

        return base;

    }

    clearWait(actor) {

        const blocker = this.waitingFor.get(actor);

        if (!blocker) return;

        this.waitingFor.delete(actor);
        this.waitDetails.delete(actor);
        console.log(
            `[CollisionFailsafe] ${actor.name} may continue; ` +
            `${blocker.name} is clear.`
        );

    }

    isWaiting(actor) {

        return this.waitingFor.has(actor);

    }

    getDebugState(actor) {

        return this.waitDetails.get(actor) ?? null;

    }

    cancel(actor) {

        this.waitingFor.delete(actor);
        this.waitDetails.delete(actor);

        for (const [candidate, blocker] of this.waitingFor) {

            if (blocker === actor) {
                this.waitingFor.delete(candidate);
                this.waitDetails.delete(candidate);
            }

        }

    }

    unregister(actor) {

        this.cancel(actor);

    }

}
