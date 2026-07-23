import * as THREE from "three";
import { SpatialHash } from "./SpatialHash.js";

// CollisionFailsafe is only a predictive brake.
//
// It deliberately does NOT create sidesteps, temporary waypoints or routes.
// NavigationGraph chooses the route, NavigationTrafficSystem owns queues and
// lane reservations, and CollisionSolver negotiates the occasional residual
// contact without pushing. Keeping local avoidance out of this class prevents
// repeatedly choosing opposite sides and oscillating around a node.
export class CharacterCollisionFailsafe {

    constructor(owner, {
        detectionRadius = 1.5,
        predictionTime = 0.33,
        safetyPadding = 0.06
    } = {}) {

        this.owner = owner;
        this.detectionRadius = detectionRadius;
        this.predictionTime = predictionTime;
        this.safetyPadding = safetyPadding;
        this.waitingFor = new Map();
        this.waitDetails = new Map();
        // One stable right-of-way agreement per nearby pair. Keeping the
        // winner/yielder fixed until separation prevents reciprocal waiting
        // and the left/right oscillation caused by deciding every frame.
        this.encounters = [];
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
            candidateChecks: 0,
            residualCorrections: 0
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
        const activeSet = new Set(activeActors);

        for (const encounter of [...this.encounters]) {

            const required =
                (encounter.winner.collisionRadius ?? 0.36) +
                (encounter.yielder.collisionRadius ?? 0.36) +
                this.safetyPadding + 0.65;
            const separated = this.getPlanarDistance(
                encounter.winner,
                encounter.yielder
            ) >= required;

            if (!activeSet.has(encounter.winner) ||
                !activeSet.has(encounter.yielder) ||
                (separated &&
                    !this.owner.collisionSolver?.isPairActive(encounter))) {
                this.releaseEncounter(encounter);
            }

        }
        this.metrics.actors = activeActors.length;
        this.metrics.queries = 0;
        this.metrics.candidateChecks = 0;
        this.metrics.residualCorrections = 0;

    }

    canMove(actor, target) {

        const maneuver = this.owner.collisionSolver?.getManeuver(actor);

        if (maneuver) {

            this.waitingFor.set(actor, maneuver.blocker);
            this.waitDetails.set(actor, {
                blocker: maneuver.blocker,
                kind: `negotiation:${maneuver.phase}`,
                clearance: this.getPlanarDistance(actor, maneuver.blocker)
            });
            return false;

        }

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

        // Priority decides who will eventually pass, but the winner must wait
        // until the yielding actor has physically opened the corridor. It may
        // always move away from the encounter; it may never advance through
        // the other body.
        const yieldingManeuver = this.owner.collisionSolver
            ?.getYieldingManeuverFor(actor);

        if (yieldingManeuver && !this.isMovingAway(
            actor,
            yieldingManeuver.actor
        )) {

            this.waitingFor.set(actor, yieldingManeuver.actor);
            this.waitDetails.set(actor, {
                blocker: yieldingManeuver.actor,
                kind: "clearance",
                clearance: this.getPlanarDistance(
                    actor,
                    yieldingManeuver.actor
                )
            });
            return false;

        }

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

            const requiredClearance =
                (actor.collisionRadius ?? 0.36) +
                (other.collisionRadius ?? 0.36) +
                this.safetyPadding;
            const otherTarget = other.navigation
                .getCurrentWaypoint()?.position;

            this.getIntendedVelocity(
                other,
                otherTarget,
                this.otherVelocity,
                { respectAuthorization: true }
            );

            // PhysicsWorld is detection-only for characters. Right-of-way
            // chooses who must backstep; it is never permission to walk
            // through the yielding body. During real contact, either actor
            // may move only when its intended movement increases clearance.
            if (currentDistance < requiredClearance) {

                if (this.isMovingAway(actor, other)) continue;

                const encounter = this.getOrCreateEncounter(actor, other);
                this.markEncounterCollision(encounter, actor, other);
                this.owner.collisionSolver?.requestClearance(encounter);

                blocker = other;
                closestClearance = currentDistance;
                collisionKind = "overlap";
                continue;

            }

            const predictedClearance = this.getPredictedClearance(
                actor,
                other
            );

            if (predictedClearance >= requiredClearance) continue;

            const encounter = this.getOrCreateEncounter(actor, other);
            this.owner.collisionSolver?.requestClearance(encounter);
            if (encounter.winner === actor) continue;

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
            candidate !== actor && !state.crossingAgents.has(candidate)
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

    getIntendedVelocity(
        actor,
        target,
        result,
        { respectAuthorization = false } = {}
    ) {

        result.set(0, 0, 0);

        if (!target || actor.navigation.isPaused()) return result;
        if (respectAuthorization && actor.movementFrame &&
            !actor.movementFrame.trafficAuthorized) return result;

        const curve = actor.locomotion.activeCurve;

        if (curve) {
            const length = curve.getLength();

            if (length > Number.EPSILON) {
                const progress = THREE.MathUtils.clamp(
                    actor.locomotion.curveDistance / length,
                    0,
                    1
                );

                curve.getTangentAt(progress, result).setY(0);
                if (result.lengthSq() > 0.0001) {
                    return result.normalize().multiplyScalar(
                        actor.locomotion.speed
                    );
                }
            }
        }

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

    getOrCreateEncounter(first, second) {

        const existing = this.encounters.find(encounter =>
            (encounter.winner === first && encounter.yielder === second) ||
            (encounter.winner === second && encounter.yielder === first)
        );

        if (existing) return existing;

        const followingOrder = this.getFollowingOrder(first, second);
        const firstYields = followingOrder
            ? followingOrder.follower === first
            : this.shouldYield(first, second);
        const encounter = {
            winner: firstYields ? second : first,
            yielder: firstYields ? first : second,
            nodeId: null,
            kind: followingOrder ? "same-lane-following" : "crossing"
        };

        this.encounters.push(encounter);
        encounter.winner.onCollisionPassStarted?.({
            yieldingActor: encounter.yielder
        });
        encounter.yielder.onCollisionYieldStarted?.({
            blocker: encounter.winner,
            strategy: followingOrder ? "follow-wait" : "right-of-way"
        });

        return encounter;

    }

    getFollowingOrder(first, second) {

        const firstTraversal = first.navigation.getTraversalState();
        const secondTraversal = second.navigation.getTraversalState();
        const firstConnection = firstTraversal.currentConnection;
        const secondConnection = secondTraversal.currentConnection;

        if (!firstConnection || !secondConnection ||
            firstConnection.fromId !== secondConnection.fromId ||
            firstConnection.toId !== secondConnection.toId) return null;

        const firstLane = this.owner.trafficState.getConnectionLaneIndex(
            firstConnection.fromId,
            firstConnection.toId,
            first
        );
        const secondLane = this.owner.trafficState.getConnectionLaneIndex(
            secondConnection.fromId,
            secondConnection.toId,
            second
        );

        if (firstLane === null || firstLane !== secondLane) return null;

        this.getIntendedVelocity(
            first,
            first.navigation.getCurrentWaypoint()?.position,
            this.velocity
        );

        if (this.velocity.lengthSq() <= 0.0001) {
            this.velocity.subVectors(
                this.owner.graph.requireNode(firstConnection.toId).position,
                this.owner.graph.requireNode(firstConnection.fromId).position
            ).setY(0);
        }

        if (this.velocity.lengthSq() <= 0.0001) return null;

        this.relativePosition.subVectors(
            second.object3D.position,
            first.object3D.position
        ).setY(0);
        const longitudinal = this.relativePosition.dot(
            this.velocity.normalize()
        );

        if (Math.abs(longitudinal) <= 0.01) return null;

        return longitudinal > 0
            ? { leader: second, follower: first }
            : { leader: first, follower: second };

    }

    markEncounterCollision(encounter, first, second) {

        if (encounter.nodeId) return encounter.nodeId;

        encounter.nodeId = this.findCollisionNode(first, second);
        if (!encounter.nodeId) return null;

        this.owner.trafficState.addCollisionBlock(
            encounter.nodeId,
            encounter
        );
        this.owner.refresh();
        return encounter.nodeId;

    }

    releaseEncounter(encounter) {

        const index = this.encounters.indexOf(encounter);
        if (index < 0) return;

        this.encounters.splice(index, 1);
        if (encounter.nodeId) {
            this.owner.trafficState.releaseCollisionBlock(
                encounter.nodeId,
                encounter
            );
            this.owner.refresh();
        }
        encounter.winner.onCollisionPassEnded?.({
            yieldingActor: encounter.yielder
        });
        encounter.yielder.onCollisionYieldEnded?.({
            blocker: encounter.winner
        });

    }

    findCollisionNode(first, second) {

        const midpoint = this.relativePosition.copy(first.object3D.position)
            .add(second.object3D.position)
            .multiplyScalar(0.5);
        const candidateIds = new Set();

        for (const actor of [first, second]) {
            const traversal = actor.navigation.getTraversalState();
            if (traversal.currentNodeId) {
                candidateIds.add(traversal.currentNodeId);
            }
            if (traversal.currentConnection) {
                candidateIds.add(traversal.currentConnection.fromId);
                candidateIds.add(traversal.currentConnection.toId);
            }
        }

        let closest = null;
        let closestDistance = Infinity;

        for (const nodeId of candidateIds) {
            const node = this.owner.graph.getNode(nodeId);
            if (!node) continue;
            const distance = Math.hypot(
                midpoint.x - node.position.x,
                midpoint.z - node.position.z
            );
            const radius = (node.metadata.laneRadius ?? 1.75) + 0.65;
            if (distance > radius || distance >= closestDistance) continue;
            closest = nodeId;
            closestDistance = distance;
        }

        return closest;

    }

    getCommitmentPriority(actor) {

        const context = this.owner.agents.get(actor);
        if (actor.navigationPassagePolicy === "absolute") {
            return Number.MAX_SAFE_INTEGER;
        }
        const base = actor.navigationPriority ?? 0;

        if (!context) return base;
        if (context.interaction.active) return base + 3;

        const interaction = context.intent.interaction?.point;
        const approach = interaction?.via;
        const reserved = Boolean(
            interaction?.reservations.has(actor) ||
            interaction?.occupants.has(actor) ||
            approach?.reservations.has(actor) ||
            approach?.occupants.has(actor)
        );

        if (reserved) return base + 2;
        if (context.traversal.interactionPoint) return base + 1;

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

    getEncounter(actor) {

        return this.encounters.find(encounter =>
            encounter.winner === actor || encounter.yielder === actor
        ) ?? null;

    }

    cancel(actor) {

        // Discard any frame-local collision snapshot together with the
        // agreement so cancelled routes cannot retain stale collision state.
        this.owner.collisionSolver?.cancel(actor);

        this.waitingFor.delete(actor);
        this.waitDetails.delete(actor);

        for (const [candidate, blocker] of this.waitingFor) {

            if (blocker === actor) {
                this.waitingFor.delete(candidate);
                this.waitDetails.delete(candidate);
            }

        }

        for (const encounter of [...this.encounters]) {
            if (encounter.winner === actor || encounter.yielder === actor) {
                this.releaseEncounter(encounter);
            }
        }

    }

    unregister(actor) {

        this.cancel(actor);

    }

}
