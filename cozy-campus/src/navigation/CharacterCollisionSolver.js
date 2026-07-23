import * as THREE from "three";

// Local response for the exceptional contact that prediction did not avoid.
//
// This solver never translates another actor. CollisionFailsafe elects stable
// right-of-way; the yielder either backsteps on crossing trajectories or
// deliberately steps outward from its own lane on parallel trajectories,
// then rejoins the same spline. Carrying/pushing is future gameplay logic and
// must not leak into collision avoidance.
export class CharacterCollisionSolver {

    constructor(owner, {
        padding = 0.08,
        releaseMargin = 0.35,
        retreatSpeedFactor = 0.65,
        maximumRetreatPerEncounter = 0.9,
        sideStepSpeedFactor = 0.55,
        maximumSideStep = 0.45,
        parallelThreshold = 0.65
    } = {}) {

        this.owner = owner;
        this.padding = padding;
        this.releaseMargin = releaseMargin;
        this.retreatSpeedFactor = retreatSpeedFactor;
        this.maximumRetreatPerEncounter = maximumRetreatPerEncounter;
        this.sideStepSpeedFactor = sideStepSpeedFactor;
        this.maximumSideStep = maximumSideStep;
        this.parallelThreshold = parallelThreshold;
        this.maneuvers = new Map();
        this.nearbyActors = [];
        this.firstTangent = new THREE.Vector3();
        this.secondTangent = new THREE.Vector3();
        this.sideDirection = new THREE.Vector3();
        this.centerPoint = new THREE.Vector3();
        this.retreatDirection = new THREE.Vector3();

    }

    resolve(
        actors,
        delta
    ) {

        const activeYielders =
            new Set();

        const requestedManeuvers =
            new Map();

        this.forEachOverlappingPair(
            actors,
            (
                first,
                second,
                required
            ) => {

                const encounter =
                    this.owner
                        .collisionFailsafe
                        .getOrCreateEncounter(
                            first,
                            second
                        );

                this.owner
                    .collisionFailsafe
                    .markEncounterCollision(
                        encounter,
                        first,
                        second
                    );

                /*
                 * O stale-node recovery já atribuiu
                 * uma rota de saída. Recriar uma
                 * manobra impediria essa rota de andar.
                 */
                if (
                    encounter.recoveryActor
                ) {

                    return;

                }

                const actor =
                    encounter.yielder;

                const blocker =
                    encounter.winner;

                const clearance =
                    this.owner
                        .collisionFailsafe
                        .getPlanarDistance(
                            actor,
                            blocker
                        );

                const previous =
                    requestedManeuvers.get(
                        actor
                    );

                const nodePriority =
                    encounter.nodeId
                        ? 1
                        : 0;

                const shouldReplace =
                    !previous ||
                    nodePriority >
                    previous.nodePriority ||
                    (
                        nodePriority ===
                        previous.nodePriority &&
                        clearance <
                        previous.clearance
                    );

                if (!shouldReplace) {

                    return;

                }

                requestedManeuvers.set(
                    actor,
                    {
                        actor,
                        blocker,
                        encounter,
                        required,
                        clearance,
                        nodePriority
                    }
                );

            }
        );

        for (
            const request of
            requestedManeuvers.values()
        ) {

            const {
                actor,
                blocker,
                encounter,
                required
            } = request;

            const maneuver =
                this.getOrCreateManeuver(
                    actor,
                    blocker,
                    encounter
                );

            activeYielders.add(
                actor
            );

            maneuver.phase =
                maneuver.strategy ===
                    "lane-side-step"

                    ? "stepping-aside"
                    : "backing-up";

            const moved =
                this.createSpace(
                    actor,
                    maneuver,
                    delta
                );

            this.updateStall(
                maneuver,
                moved,
                delta
            );

            if (
                this.owner
                    .collisionFailsafe
                    .getPlanarDistance(
                        actor,
                        blocker
                    ) <
                required
            ) {

                maneuver.phase =
                    "holding";

            }

        }

        for (
            const [
                actor,
                maneuver
            ] of [...this.maneuvers]
        ) {

            if (
                activeYielders.has(
                    actor
                )
            ) {

                continue;

            }

            const clearance =
                this.owner
                    .collisionFailsafe
                    .getPlanarDistance(
                        actor,
                        maneuver.blocker
                    );

            const releaseDistance =
                this.getRequiredClearance(
                    actor,
                    maneuver.blocker
                ) +
                this.releaseMargin;

            if (
                clearance >=
                releaseDistance
            ) {

                if (
                    maneuver.strategy ===
                    "lane-side-step" &&
                    !actor.locomotion
                        .rejoinActiveCurve(
                            delta *
                            this.sideStepSpeedFactor
                        )
                ) {

                    maneuver.phase =
                        "rejoining";

                    continue;

                }

                maneuver.encounter
                    .stalledElapsed =
                    0;

                this.maneuvers.delete(
                    actor
                );

                continue;

            }

            if (
                maneuver.strategy ===
                "follow-wait"
            ) {

                maneuver.phase =
                    "following";

                this.updateStall(
                    maneuver,
                    0,
                    delta
                );

                continue;

            }

            maneuver.phase =
                maneuver.strategy ===
                    "lane-side-step"

                    ? "stepping-aside"
                    : "backing-up";

            const moved =
                this.createSpace(
                    actor,
                    maneuver,
                    delta
                );

            this.updateStall(
                maneuver,
                moved,
                delta
            );

            if (
                !actor.locomotion
                    .motion.retreating &&
                !actor.locomotion
                    .motion.avoiding
            ) {

                maneuver.phase =
                    "holding";

            }

        }

    }

    resolveResidual(actors) {

        // Register contact immediately so the next frame starts with a stable
        // agreement. Do not repair it through positional projection: that was
        // the source of actors being pushed away from their lanes.
        this.forEachOverlappingPair(actors, (first, second) => {

            const encounter = this.owner.collisionFailsafe
                .getOrCreateEncounter(first, second);
            this.owner.collisionFailsafe.markEncounterCollision(
                encounter,
                first,
                second
            );
            this.getOrCreateManeuver(
                encounter.yielder,
                encounter.winner,
                encounter
            );

        });

    }

    retreat(
        actor,
        maneuver,
        delta
    ) {

        const clearance =
            this.owner
                .collisionFailsafe
                .getPlanarDistance(
                    actor,
                    maneuver.blocker
                );

        const requiredDistance =
            this.getRequiredClearance(
                actor,
                maneuver.blocker
            ) +
            this.releaseMargin;

        const requiredMovement =
            Math.max(
                0,
                requiredDistance -
                clearance
            );

        maneuver.retreatLimit =
            Math.max(
                maneuver.retreatLimit ??
                0,

                this.maximumRetreatPerEncounter,

                maneuver.retreatDistance +
                requiredMovement +
                0.08
            );

        const remaining =
            Math.max(
                0,
                maneuver.retreatLimit -
                maneuver.retreatDistance
            );

        if (
            remaining <= 0
        ) {

            return 0;

        }

        let moved =
            actor.locomotion
                .retreatAlongCurve(
                    delta *
                    this.retreatSpeedFactor,

                    remaining
                );

        /*
         * Estado legado ou recovery pode ter
         * apagado a curva sem apagar a conexão.
         */
        if (
            moved <= 0.0001
        ) {

            const direction =
                this.getEmergencyRetreatDirection(
                    actor,
                    maneuver.blocker
                );

            moved =
                actor.locomotion
                    .retreatAlongDirection(
                        direction,

                        delta *
                        this.retreatSpeedFactor,

                        remaining
                    );

        }

        maneuver.retreatDistance +=
            moved;

        return moved;

    }

    getEmergencyRetreatDirection(
        actor,
        blocker
    ) {

        const traversal =
            actor.navigation
                .getTraversalState();

        if (
            traversal.currentConnection
        ) {

            const from =
                this.owner.graph
                    .requireNode(
                        traversal
                            .currentConnection
                            .fromId
                    )
                    .position;

            const to =
                this.owner.graph
                    .requireNode(
                        traversal
                            .currentConnection
                            .toId
                    )
                    .position;

            return this.retreatDirection
                .copy(from)
                .sub(to)
                .setY(0)
                .normalize();

        }

        const context =
            this.owner.agents.get(
                actor
            );

        const arrivalFromNodeId =
            context
                ?.traversal
                ?.arrivalFromNodeId;

        if (
            arrivalFromNodeId &&
            this.owner.graph.hasNode(
                arrivalFromNodeId
            )
        ) {

            return this.retreatDirection
                .copy(
                    this.owner.graph
                        .requireNode(
                            arrivalFromNodeId
                        )
                        .position
                )
                .sub(
                    actor.object3D.position
                )
                .setY(0)
                .normalize();

        }

        return this.retreatDirection
            .copy(
                actor.object3D.position
            )
            .sub(
                blocker.object3D.position
            )
            .setY(0)
            .normalize();

    }

    updateStall(
        maneuver,
        moved,
        delta
    ) {

        const encounter =
            maneuver.encounter;

        if (!encounter) {

            return;

        }

        if (
            moved > 0.0001
        ) {

            encounter.stalledElapsed =
                0;

            return;

        }

        encounter.stalledElapsed =
            (
                encounter.stalledElapsed ??
                0
            ) +
            delta;

    }

    forceRetreat(
        encounter
    ) {

        if (!encounter) {

            return false;

        }

        encounter.recoveryActor =
            null;

        encounter.stalledElapsed =
            0;

        const maneuver =
            this.getOrCreateManeuver(
                encounter.yielder,
                encounter.winner,
                encounter
            );

        maneuver.strategy =
            "backstep";

        maneuver.sideDirection =
            null;

        maneuver.phase =
            "backing-up";

        maneuver.retreatDistance =
            0;

        maneuver.retreatLimit =
            0;

        return true;

    }

    createSpace(actor, maneuver, delta) {

        if (maneuver.strategy !== "lane-side-step") {
            return this.retreat(actor, maneuver, delta);
        }

        const remaining = Math.max(
            0,
            this.maximumSideStep - maneuver.sideDistance
        );
        if (remaining <= 0 || !maneuver.sideDirection) return 0;

        const moved = actor.locomotion.moveSideways(
            maneuver.sideDirection,
            delta * this.sideStepSpeedFactor,
            remaining
        );
        maneuver.sideDistance += moved;
        return moved;

    }

    isInNodeTrafficZone(
        actor
    ) {

        const traversal =
            actor.navigation
                .getTraversalState();

        const connection =
            traversal.currentConnection;

        /*
         * Um ator só é considerado dentro do nó
         * quando o TrafficState confirma que ele
         * está efetivamente atravessando.
         *
         * currentNodeId sozinho não é suficiente,
         * pois pode permanecer definido durante
         * a transição inicial para uma lane.
         */
        if (
            traversal.currentNodeId
        ) {

            const nodeState =
                this.owner
                    .trafficState
                    .getNodeState(
                        traversal.currentNodeId
                    );

            if (
                nodeState.crossingAgents.has(
                    actor
                )
            ) {

                return true;

            }

        }

        /*
         * Sem uma conexão ativa, e sem estar
         * marcado como crossingAgent, o ator não
         * está na zona operacional de chegada.
         */
        if (!connection) {

            return false;

        }

        const laneIndex =
            this.owner
                .trafficState
                .getConnectionLaneIndex(
                    connection.fromId,
                    connection.toId,
                    actor
                );

        if (
            laneIndex === null ||
            laneIndex === undefined
        ) {

            return false;

        }

        /*
         * Usa o portal de chegada real da lane,
         * não o centro do nó.
         */
        const arrivalPortal =
            this.owner
                .routeGeometry
                .getConnectionLaneNodePosition(
                    connection.toId,
                    connection.fromId,
                    connection.toId,
                    laneIndex
                );

        const collisionRadius =
            actor.collisionRadius ??
            0.36;

        /*
         * Zona curta, apenas junto ao endpoint.
         *
         * Não use node.metadata.laneRadius aqui:
         * ele pode abranger uma parte extensa da
         * conexão e transformar conflitos normais
         * de lane em conflitos de nó.
         */
        const endpointRadius =
            Math.max(
                0.55,
                collisionRadius * 1.5
            );

        return this.getPlanarDistanceSquared(
            actor.object3D.position,
            arrivalPortal
        ) <=
            endpointRadius ** 2;

    }

    getPlanarDistanceSquared(
        first,
        second
    ) {

        const deltaX =
            first.x -
            second.x;

        const deltaZ =
            first.z -
            second.z;

        return (
            deltaX * deltaX +
            deltaZ * deltaZ
        );

    }

    chooseStrategy(
        actor,
        blocker,
        encounter = null
    ) {

        if (
            encounter?.kind ===
            "same-lane-following"
        ) {

            return {
                strategy:
                    "follow-wait",

                sideDirection:
                    null
            };

        }

        if (
            this.isInNodeTrafficZone(
                actor
            ) ||
            this.isInNodeTrafficZone(
                blocker
            )
        ) {

            return {
                strategy:
                    "backstep",

                sideDirection:
                    null
            };

        }

        const actorCurve =
            actor.locomotion.activeCurve;

        const blockerCurve =
            blocker.locomotion.activeCurve;

        const traversal =
            actor.navigation
                .getTraversalState();

        if (
            !actorCurve ||
            !blockerCurve ||
            !traversal.currentConnection
        ) {

            return {
                strategy:
                    "backstep",

                sideDirection:
                    null
            };

        }

        this.getCurveTangent(
            actor,
            this.firstTangent
        );

        this.getCurveTangent(
            blocker,
            this.secondTangent
        );

        if (
            Math.abs(
                this.firstTangent.dot(
                    this.secondTangent
                )
            ) <
            this.parallelThreshold
        ) {

            return {
                strategy:
                    "backstep",

                sideDirection:
                    null
            };

        }

        const connection =
            traversal.currentConnection;

        const start =
            this.owner.graph
                .requireNode(
                    connection.fromId
                )
                .position;

        const end =
            this.owner.graph
                .requireNode(
                    connection.toId
                )
                .position;

        const axis =
            this.secondTangent
                .copy(end)
                .sub(start)
                .setY(0);

        const lengthSquared =
            axis.lengthSq();

        const relative =
            this.sideDirection
                .copy(
                    actor.object3D.position
                )
                .sub(start)
                .setY(0);

        const progress =
            lengthSquared > 0

                ? THREE.MathUtils.clamp(
                    relative.dot(axis) /
                    lengthSquared,
                    0,
                    1
                )

                : 0;

        this.centerPoint
            .copy(start)
            .addScaledVector(
                axis,
                progress
            );

        const outward =
            this.sideDirection
                .copy(
                    actor.object3D.position
                )
                .sub(
                    this.centerPoint
                )
                .setY(0);

        if (
            outward.lengthSq() <=
            0.0025
        ) {

            outward.set(
                -this.firstTangent.z,
                0,
                this.firstTangent.x
            );

            const laneIndex =
                this.owner
                    .trafficState
                    .getConnectionLaneIndex(
                        connection.fromId,
                        connection.toId,
                        actor
                    );

            const resource =
                this.owner.graph
                    .requireConnection(
                        connection.fromId,
                        connection.toId
                    );

            const rightLane =
                resource.fromId ===
                    connection.fromId

                    ? 0
                    : Math.min(
                        1,
                        resource.laneCount - 1
                    );

            if (
                laneIndex !== null &&
                laneIndex !== rightLane
            ) {

                outward.negate();

            }

        }

        return {
            strategy:
                "lane-side-step",

            sideDirection:
                outward.normalize().clone()
        };

    }

    getCurveTangent(actor, target) {

        const curve = actor.locomotion.activeCurve;
        const length = curve?.getLength() ?? 0;
        if (length <= Number.EPSILON) return target.set(0, 0, 0);

        curve.getTangentAt(THREE.MathUtils.clamp(
            actor.locomotion.curveDistance / length,
            0,
            1
        ), target).setY(0);
        return target.lengthSq() > 0.0001 ? target.normalize() : target;

    }

    forEachOverlappingPair(actors, callback) {

        if (actors.length >=
            this.owner.collisionFailsafe.spatialHashThreshold) {
            this.owner.collisionFailsafe.spatialHash.rebuild(actors);
        }

        for (let firstIndex = 0; firstIndex < actors.length; firstIndex++) {

            const first = actors[firstIndex];
            const candidates = actors.length >=
                this.owner.collisionFailsafe.spatialHashThreshold
                ? this.owner.collisionFailsafe.spatialHash.queryRadius(
                    first.object3D.position,
                    this.owner.collisionFailsafe.detectionRadius,
                    this.nearbyActors
                )
                : actors;

            for (const second of candidates) {

                const secondIndex = this.owner.collisionFailsafe.actorOrder
                    .get(second);
                if (secondIndex === undefined || secondIndex <= firstIndex) {
                    continue;
                }
                if (!this.owner.collisionFailsafe.hasVerticalOverlap(
                    first,
                    second
                )) continue;

                const required = this.getRequiredClearance(first, second);
                if (this.owner.collisionFailsafe.getPlanarDistance(
                    first,
                    second
                ) >= required) continue;

                callback(first, second, required);

            }

        }

    }

    getRequiredClearance(first, second) {

        return (first.collisionRadius ?? 0.36) +
            (second.collisionRadius ?? 0.36) + this.padding;

    }

    getOrCreateManeuver(
        actor,
        blocker,
        encounter
    ) {

        const decision =
            this.chooseStrategy(
                actor,
                blocker,
                encounter
            );

        const existing =
            this.maneuvers.get(
                actor
            );

        if (
            existing?.blocker ===
            blocker
        ) {

            if (
                existing.strategy !==
                decision.strategy
            ) {

                existing.strategy =
                    decision.strategy;

                existing.sideDirection =
                    decision.sideDirection;

                existing.retreatDistance =
                    0;

                existing.retreatLimit =
                    0;

                existing.sideDistance =
                    0;

            }

            existing.encounter =
                encounter;

            return existing;

        }

        const maneuver = {
            actor,
            blocker,
            encounter,

            phase:
                "holding",

            strategy:
                decision.strategy,

            sideDirection:
                decision.sideDirection,

            retreatDistance:
                0,

            retreatLimit:
                0,

            sideDistance:
                0
        };

        this.maneuvers.set(
            actor,
            maneuver
        );

        return maneuver;

    }

    requestClearance(encounter) {

        return this.getOrCreateManeuver(
            encounter.yielder,
            encounter.winner,
            encounter
        );

    }

    getManeuver(actor) {

        return this.maneuvers.get(actor) ?? null;

    }

    getYieldingManeuverFor(actor) {

        for (const maneuver of this.maneuvers.values()) {
            if (maneuver.blocker === actor) return maneuver;
        }

        return null;

    }

    isPairActive(encounter) {

        return this.maneuvers.get(encounter.yielder)?.encounter === encounter;

    }

    unregister(actor) {

        this.cancel(actor);

    }

    cancel(actor) {

        this.maneuvers.delete(actor);
        for (const [candidate, maneuver] of this.maneuvers) {
            if (maneuver.blocker === actor) this.maneuvers.delete(candidate);
        }

    }

}
