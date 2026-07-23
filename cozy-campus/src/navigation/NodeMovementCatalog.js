import * as THREE from "three";

export class NodeMovementCatalog {

    constructor(
        graph,
        routeGeometry,
        {
            geometryBuilder = null,
            curveTolerance = 0.025,
            maximumSubdivisionDepth = 10
        } = {}
    ) {

        this.graph = graph;
        this.routeGeometry = routeGeometry;
        this.geometryBuilder = geometryBuilder;

        this.curveTolerance =
            curveTolerance;

        this.maximumSubdivisionDepth =
            maximumSubdivisionDepth;

        this.movements =
            new Map();

        this.minimumDistances =
            new Map();

        this.graphRevision =
            graph.revision;

    }

    ensureRevision() {

        if (
            this.graphRevision ===
            this.graph.revision
        ) {

            return;

        }

        this.clear();

        this.graphRevision =
            this.graph.revision;

    }

    getDefaultLaneIndex(
        fromId,
        toId
    ) {

        this.ensureRevision();

        const connection =
            this.graph.requireConnection(
                fromId,
                toId
            );

        const rightHandLane =
            connection.fromId === fromId
                ? 0
                : 1;

        return Math.min(
            connection.laneCount - 1,
            rightHandLane
        );

    }

    createConnectionEndpoint({
        nodeId,
        fromId,
        toId,
        laneIndex,
        role
    }) {

        this.ensureRevision();

        const start =
            this.routeGeometry
                .getConnectionLaneNodePosition(
                    fromId,
                    fromId,
                    toId,
                    laneIndex
                );

        const end =
            this.routeGeometry
                .getConnectionLaneNodePosition(
                    toId,
                    fromId,
                    toId,
                    laneIndex
                );

        const direction =
            end.clone()
                .sub(start)
                .setY(0);

        if (
            direction.lengthSq() <=
            0.000001
        ) {

            direction.set(
                1,
                0,
                0
            );

        } else {

            direction.normalize();

        }

        const position =
            nodeId === fromId

                ? start

                : nodeId === toId

                    ? end
                    : null;

        if (!position) {

            throw new Error(
                `Node "${nodeId}" is not part of ` +
                `connection "${fromId}" -> "${toId}".`
            );

        }

        return {
            type:
                "connection",

            role,

            key:
                `connection:${fromId}->${toId}:` +
                `lane:${laneIndex}:node:${nodeId}`,

            nodeId,
            fromId,
            toId,
            laneIndex,

            position:
                position.clone(),

            direction
        };

    }

    createVirtualEndpoint({
        nodeId,
        key,
        position,
        direction = null,
        role
    }) {

        this.ensureRevision();

        const node =
            this.graph.requireNode(
                nodeId
            );

        const resolvedDirection =
            direction?.clone().setY(0) ??
            (
                role === "entry"

                    ? node.position
                        .clone()
                        .sub(position)
                        .setY(0)

                    : position
                        .clone()
                        .sub(node.position)
                        .setY(0)
            );

        if (
            resolvedDirection.lengthSq() <=
            0.000001
        ) {

            resolvedDirection.set(
                1,
                0,
                0
            );

        } else {

            resolvedDirection.normalize();

        }

        return {
            type:
                "virtual",

            role,

            key:
                `virtual:${key}`,

            nodeId,

            position:
                position.clone(),

            direction:
                resolvedDirection
        };

    }

    createStopEndpoint(
        nodeId
    ) {

        this.ensureRevision();

        const node =
            this.graph.requireNode(
                nodeId
            );

        return {
            type:
                "stop",

            role:
                "exit",

            key:
                `stop:${nodeId}`,

            nodeId,

            position:
                node.position.clone(),

            direction:
                new THREE.Vector3(
                    1,
                    0,
                    0
                )
        };

    }

    getOrCreateMovement({
        nodeId,
        entry,
        exit,
        exclusive = false
    }) {

        this.ensureRevision();

        if (
            !entry ||
            !exit
        ) {

            return null;

        }

        const id =
            `${nodeId}|` +
            `${entry.key}>${exit.key}`;

        const cached =
            this.movements.get(
                id
            );

        if (cached) {

            return cached;

        }

        const controlPoints =
            this.createControlPoints(
                nodeId,
                entry,
                exit
            );

        const samples =
            this.flattenCubic(
                ...controlPoints
            );

        const movement =
            Object.freeze({
                id,
                nodeId,
                entry,
                exit,
                exclusive,

                controlPoints:
                    Object.freeze(
                        controlPoints.map(
                            point =>
                                point.clone()
                        )
                    ),

                samples:
                    Object.freeze(
                        samples.map(
                            point =>
                                point.clone()
                        )
                    )
            });

        this.movements.set(
            id,
            movement
        );

        return movement;

    }

    createControlPoints(
        nodeId,
        entry,
        exit
    ) {

        const start =
            entry.position.clone();

        const end =
            exit.position.clone();

        const incoming =
            entry.direction
                .clone()
                .setY(0)
                .normalize();

        const outgoing =
            exit.direction
                .clone()
                .setY(0)
                .normalize();

        /*
         * Usa exatamente o mesmo construtor
         * usado pela geometria física.
         */
        if (this.geometryBuilder) {

            const segment =
                this.geometryBuilder
                    .createJunctionTransitionSegment({
                        start,
                        end,

                        startDirection:
                            incoming,

                        endDirection:
                            outgoing,

                        nodeId
                    });

            const curve =
                segment.curve;

            return [
                curve.v0.clone(),
                curve.v1.clone(),
                curve.v2.clone(),
                curve.v3.clone()
            ];

        }

        const chord =
            Math.hypot(
                end.x - start.x,
                end.z - start.z
            );

        if (
            chord <=
            0.0001
        ) {

            return [
                start,
                start.clone(),
                end.clone(),
                end
            ];

        }

        const turn =
            incoming.angleTo(
                outgoing
            );

        const node =
            this.graph.requireNode(
                nodeId
            );

        const roundness =
            THREE.MathUtils.clamp(
                node.metadata
                    .junctionRoundness ??
                1,

                0.5,
                1.25
            );

        const cosine =
            Math.max(
                Math.cos(
                    turn / 4
                ),

                0.001
            );

        const circularHandle =
            chord /
            (
                3 *
                cosine *
                cosine
            );

        const handle =
            THREE.MathUtils.clamp(
                circularHandle *
                    roundness,

                chord * 0.28,
                chord * 0.75
            );

        return [
            start,

            start.clone()
                .addScaledVector(
                    incoming,
                    handle
                ),

            end.clone()
                .addScaledVector(
                    outgoing,
                    -handle
                ),

            end
        ];

    }

    flattenCubic(
        first,
        second,
        third,
        fourth
    ) {

        const points = [
            first.clone()
        ];

        this.subdivideCubic(
            first,
            second,
            third,
            fourth,
            0,
            points
        );

        return points;

    }

    subdivideCubic(
        first,
        second,
        third,
        fourth,
        depth,
        points
    ) {

        const flatness =
            Math.max(
                this.routeGeometry
                    .getPlanarPointSegmentDistance(
                        second,
                        first,
                        fourth
                    ),

                this.routeGeometry
                    .getPlanarPointSegmentDistance(
                        third,
                        first,
                        fourth
                    )
            );

        if (
            flatness <=
                this.curveTolerance ||
            depth >=
                this.maximumSubdivisionDepth
        ) {

            points.push(
                fourth.clone()
            );

            return;

        }

        const firstSecond =
            first.clone()
                .lerp(
                    second,
                    0.5
                );

        const secondThird =
            second.clone()
                .lerp(
                    third,
                    0.5
                );

        const thirdFourth =
            third.clone()
                .lerp(
                    fourth,
                    0.5
                );

        const firstMiddle =
            firstSecond.clone()
                .lerp(
                    secondThird,
                    0.5
                );

        const secondMiddle =
            secondThird.clone()
                .lerp(
                    thirdFourth,
                    0.5
                );

        const middle =
            firstMiddle.clone()
                .lerp(
                    secondMiddle,
                    0.5
                );

        this.subdivideCubic(
            first,
            firstSecond,
            firstMiddle,
            middle,
            depth + 1,
            points
        );

        this.subdivideCubic(
            middle,
            secondMiddle,
            thirdFourth,
            fourth,
            depth + 1,
            points
        );

    }

    movementsConflict(
        first,
        second,
        clearance
    ) {

        if (
            !first ||
            !second
        ) {

            return true;

        }

        if (
            first.nodeId !==
            second.nodeId
        ) {

            return false;

        }

        if (
            first.exclusive ||
            second.exclusive
        ) {

            return true;

        }

        /*
         * A mesma curva é uma corrente
         * serial, não duas travessias
         * paralelas.
         */
        if (
            first.id ===
            second.id
        ) {

            return true;

        }

        /*
         * O mesmo portal de entrada ou saída
         * é um conflito de merge/diverge.
         */
        if (
            first.entry.key ===
                second.entry.key ||
            first.exit.key ===
                second.exit.key
        ) {

            return true;

        }

        return this.getMinimumDistance(
            first,
            second
        ) < clearance;

    }

    getMinimumDistance(
        first,
        second
    ) {

        const key =
            first.id <
            second.id

                ? `${first.id}::${second.id}`
                : `${second.id}::${first.id}`;

        const cached =
            this.minimumDistances.get(
                key
            );

        if (
            cached !== undefined
        ) {

            return cached;

        }

        let distance =
            Infinity;

        for (
            let firstIndex = 1;
            firstIndex <
                first.samples.length;
            firstIndex++
        ) {

            for (
                let secondIndex = 1;
                secondIndex <
                    second.samples.length;
                secondIndex++
            ) {

                distance =
                    Math.min(
                        distance,

                        this.routeGeometry
                            .getPlanarSegmentDistance(
                                first.samples[
                                    firstIndex - 1
                                ],

                                first.samples[
                                    firstIndex
                                ],

                                second.samples[
                                    secondIndex - 1
                                ],

                                second.samples[
                                    secondIndex
                                ]
                            )
                    );

                if (
                    distance <= 0
                ) {

                    break;

                }

            }

            if (
                distance <= 0
            ) {

                break;

            }

        }

        this.minimumDistances.set(
            key,
            distance
        );

        return distance;

    }

    clear() {

        this.movements.clear();
        this.minimumDistances.clear();

    }

}