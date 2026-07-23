import * as THREE from "three";
import { RouteGeometry } from "./RouteGeometry";
import { RouteSegment, RouteSegmentType } from "./RouteSegment";

// Converte uma rota topológica em segmentos locais. Esta camada não escolhe
// destino e não concede tráfego; apenas descreve por onde o movimento passará.
export class RouteGeometryBuilder {

    constructor(navigation) {

        this.navigation = navigation;
        this.graph = navigation.graph;
        this.connector = navigation.connector;
        this.traffic = navigation.traffic;

    }

    get grounding() {

        return this.navigation.grounding;

    }

    createTraversalWaypoints(context, nodeIds) {

        const traversal = context.actor.navigation.getTraversalState();
        const originAlreadyRepresented =
            !context.traversal.interactionPoint &&
            traversal.currentNodeId === nodeIds[0];

        // Only topology is materialized here. Traffic will choose a lane and
        // ask this builder for its geometry immediately before entry.
        return this.navigation.routeGeometry.createWaypoints(
            originAlreadyRepresented ? nodeIds.slice(1) : nodeIds
        );

    }

    preserveTopologicalWaypoints(context, nodeIds, waypoints) {

        // Compatibility boundary for older callers. Global route splines are
        // intentionally disabled; these waypoints remain purely topological.
        return waypoints;

    }

    applyTopologyToGraphPrefix(context, waypoints, exitWaypoints = []) {

        const currentNodeId = context.actor.navigation
            .getTraversalState().currentNodeId;

        const graphWaypoints = [];

        for (const waypoint of waypoints) {

            if (!waypoint.id) break;
            graphWaypoints.push(waypoint);

        }

        if (graphWaypoints.length === 0) return waypoints;

        const remainingWaypoints = waypoints.slice(graphWaypoints.length);
        const graphNodeIds = graphWaypoints.map(waypoint => waypoint.id);
        const entryConnection = exitWaypoints.find(
            waypoint => waypoint.connectionEntry
        )?.connectionEntry ?? null;

        /*
         * A saída de um InteractionPoint já percorre a conexão indicada por
         * connectionEntry: a curva local termina no portal de `fromId` e a
         * curva autorizada da lane leva o ator até `toId`. Portanto, `fromId`
         * não pode reaparecer como waypoint logo depois da saída. Se isso
         * acontecer, o ator chega ao portal, volta ao centro do nó e percorre
         * a mesma entrada novamente.
         *
         * A normalização depende da geometria da saída, não de flags
         * transitórias do NavigationAgent. Assim retries e comandos adiados
         * produzem exatamente a mesma sequência da primeira tentativa.
        */
        if (entryConnection &&
            entryConnection.fromId === graphNodeIds[0] &&
            entryConnection.toId === graphNodeIds[1]) {

            return [
                ...graphWaypoints.slice(1),
                ...remainingWaypoints
            ];

        }

        // createRoute() includes the graph origin as a normal node waypoint.
        // While leaving an InteractionPoint, createExitWaypoints() already
        // owns that arrival through its lane portal. Keeping the origin here
        // would insert the node center between the portal and the next lane.
        if (context.traversal.interactionPoint) {

            const directNodeExit = exitWaypoints.find(
                waypoint => waypoint.graphEntryNodeId
            );

            const interactionDeparture = remainingWaypoints.find(
                waypoint =>
                    waypoint.departureRequest?.originId === graphNodeIds[0] &&
                    waypoint.laneStartPosition
            );

            if (directNodeExit &&
                directNodeExit.graphEntryNodeId === graphNodeIds[0] &&
                graphNodeIds.length === 1 &&
                interactionDeparture) {

                /*
                 * InteractionPoint(node) -> InteractionPoint(connection):
                 * the destination already authored a lane start beside this
                 * same node. Hand the exit directly to that portal instead of
                 * physically visiting node center first. The node id remains
                 * on directNodeExit only as the traffic handshake resource.
                 *
                 * Physical route:
                 * source point -> lane start -> approach portal
                 *
                 * Never:
                 * source point -> node center -> lane start -> approach.
                 */
                directNodeExit.position.copy(
                    interactionDeparture.laneStartPosition
                );

                return remainingWaypoints;

            }

            if (directNodeExit &&
                directNodeExit.graphEntryNodeId === graphNodeIds[0] &&
                graphNodeIds[1] &&
                this.graph.areConnected(graphNodeIds[0], graphNodeIds[1])) {

                // A direct node InteractionPoint has no authored portal. Use
                // the next topological edge to request a real lane, then let
                // Traffic replace this placeholder with that lane start.
                directNodeExit.connectionEntry = {
                    fromId: graphNodeIds[0],
                    toId: graphNodeIds[1],
                    preferredLaneIndex: null,
                    originKey:
                        `interaction:${context.traversal.interactionPoint.id}`
                };

                return [
                    ...graphWaypoints.slice(1),
                    ...remainingWaypoints
                ];

            }

            if (entryConnection) {

                return [
                    ...this.preserveTopologicalWaypoints(
                        context,
                        graphNodeIds,
                        graphWaypoints,
                        { entryConnection }
                    ),
                    ...remainingWaypoints
                ];

            }

            if (graphNodeIds.length < 2) return remainingWaypoints;

            return [
                ...this.preserveTopologicalWaypoints(
                    context,
                    graphNodeIds,
                    graphWaypoints.slice(1)
                ),
                ...remainingWaypoints
            ];

        }

        if (!currentNodeId) return waypoints;

        const nodeIds = [
            currentNodeId,
            ...graphWaypoints.map(waypoint => waypoint.id)
        ];
        const graphWaypointsWithTopology = this.preserveTopologicalWaypoints(
            context,
            nodeIds,
            graphWaypoints
        );

        return [
            ...graphWaypointsWithTopology,
            ...remainingWaypoints
        ];

    }

    prepareRouteWaypoints(context, waypoints) {

        // Interaction and lane curves are constructed only after their
        // traffic resource is authorized. Never couple future lanes here.
        return waypoints;

    }

    createPlannedRoutePreview(context, waypoints) {

        const { actor } = context;
        const traversal = actor.navigation.getTraversalState();
        const points = [actor.object3D.position.clone()];
        let position = actor.object3D.position.clone();
        let nodeId = traversal.currentNodeId;
        let arrivalDirection = context.traversal.transitTangent?.direction ?? null;

        const append = samples => {

            for (const sample of samples ?? []) {
                if (points.at(-1).distanceToSquared(sample) > 0.0001) {
                    points.push(sample.clone());
                }
            }
            if (points.length > 0) position = points.at(-1).clone();

        };

        for (const waypoint of waypoints) {

            if (waypoint.routeCurve) {

                const length = waypoint.routeCurve.getLength() || 1;
                const start = waypoint === actor.navigation.getCurrentWaypoint()
                    ? Math.max(0, Math.min(1,
                        actor.locomotion.curveDistance / length
                    ))
                    : 0;
                const samples = [];
                for (let index = 0; index <= 16; index++) {
                    samples.push(waypoint.routeCurve.getPointAt(
                        start + (1 - start) * index / 16
                    ));
                }
                append(samples);
                if (waypoint.id) nodeId = waypoint.id;
                continue;

            }

            if (waypoint.connectionEntry) {

                const entry = waypoint.connectionEntry;
                const laneIndex = Number.isInteger(entry.preferredLaneIndex)
                    ? entry.preferredLaneIndex
                    : this.getPreviewLaneIndex(entry.fromId, entry.toId);
                const exit = this.createInteractionGeometry({
                    start: position,
                    portal: waypoint.position,
                    departureDirection: waypoint.departureDirection,
                    type: RouteSegmentType.INTERACTION_EXIT,
                    recordMetrics: false
                });
                append(exit?.getDebugPoints(12));
                const connection = this.createAuthorizedConnectionGeometry({
                    actor,
                    fromId: entry.fromId,
                    toId: entry.toId,
                    laneIndex,
                    startPosition: position,
                    laneStartOverride: waypoint.position,
                    recordMetrics: false
                });
                append(connection.geometry.getDebugPoints(12));
                arrivalDirection = connection.arrivalDirection;
                nodeId = entry.toId;
                continue;

            }

            if (waypoint.id) {

                if (nodeId === waypoint.id) continue;

                if (nodeId && this.graph.hasNode(nodeId) &&
                    this.graph.hasNode(waypoint.id) &&
                    this.graph.areConnected(nodeId, waypoint.id)) {

                    const laneIndex = Number.isInteger(waypoint.preferredLaneIndex)
                        ? waypoint.preferredLaneIndex
                        : this.getPreviewLaneIndex(nodeId, waypoint.id);
                    const connection = this.createAuthorizedConnectionGeometry({
                        actor,
                        fromId: nodeId,
                        toId: waypoint.id,
                        laneIndex,
                        startPosition: position,
                        departureDirection: arrivalDirection,
                        recordMetrics: false
                    });
                    append(connection.geometry.getDebugPoints(12));
                    arrivalDirection = connection.arrivalDirection;

                } else {
                    append([waypoint.position]);
                }

                nodeId = waypoint.id;
                continue;

            }

            const arrival = waypoint.interactionPoint && !waypoint.preserveFacing
                ? waypoint.interactionPoint.getWorldDirection()
                : null;
            const local = this.createInteractionGeometry({
                start: position,
                portal: waypoint.position,
                departureDirection: arrivalDirection,
                arrivalDirection: arrival,
                recordMetrics: false
            });
            append(local?.getDebugPoints(12));
            arrivalDirection = arrival;

        }

        return points;

    }

    getPreviewLaneIndex(fromId, toId) {

        const connection = this.graph.requireConnection(fromId, toId);
        const rightHandLane = connection.fromId === fromId ? 0 : 1;

        return Math.min(connection.laneCount - 1, rightHandLane);

    }

    getJunctionHandleLength({
        start,
        end,
        startDirection,
        endDirection,
        nodeId
    }) {

        const chord = Math.hypot(end.x - start.x, end.z - start.z);
        if (chord <= Number.EPSILON) return 0;

        const incoming = startDirection.clone().setY(0).normalize();
        const outgoing = endDirection.clone().setY(0).normalize();
        const turn = Math.acos(THREE.MathUtils.clamp(
            incoming.dot(outgoing),
            -1,
            1
        ));

        // A cubic Bezier approximates a circular arc when both handles have
        // this length. The old chord / 3 rule became visibly angular on obtuse
        // junctions, especially after lanes were authorized one segment at a
        // time. `junctionRoundness` is an optional per-node artistic override:
        // 1 is circular, lower values tighten and higher values widen the arc.
        const roundness = THREE.MathUtils.clamp(
            this.graph.requireNode(nodeId).metadata.junctionRoundness ?? 1,
            0.5,
            1.25
        );
        const cosine = Math.max(Math.cos(turn / 4), 0.001);
        const circularHandle = chord / (3 * cosine * cosine);

        return THREE.MathUtils.clamp(
            circularHandle * roundness,
            chord * 0.28,
            chord * 0.75
        );

    }

    createAuthorizedConnectionGeometry({
        actor,
        fromId,
        toId,
        laneIndex,
        startPosition = actor.object3D.position,
        laneStartOverride = null,
        departureDirection = null,
        recordMetrics = true
    }) {

        const started = performance.now();

        const connection = this.graph.requireConnection(fromId, toId);
        const laneStart = laneStartOverride?.clone() ??
            this.navigation.routeGeometry.getConnectionLaneNodePosition(
                fromId,
                fromId,
                toId,
                laneIndex
            );
        const laneEnd = this.navigation.routeGeometry.getConnectionLaneNodePosition(
            toId,
            fromId,
            toId,
            laneIndex
        );
        const laneDirection = laneEnd.clone().sub(laneStart).normalize();
        const geometry = new RouteGeometry();
        const transitionDistance = startPosition.distanceTo(laneStart);

        if (transitionDistance > 0.05) {

            const towardStart = laneStart.clone().sub(startPosition).normalize();
            const startDirection = departureDirection?.clone().setY(0) ??
                towardStart;

            if (startDirection.lengthSq() <= 0.0001) {
                startDirection.copy(towardStart);
            } else {
                startDirection.normalize();
            }

            const circularHandle = this.getJunctionHandleLength({
                start: startPosition,
                end: laneStart,
                startDirection,
                endDirection: laneDirection,
                nodeId: fromId
            });
            let startHandle = circularHandle;
            let joinHandle = circularHandle;
            let segment = null;

            // Never discard an observed incoming tangent. If large handles
            // overshoot, shorten their magnitude while retaining both endpoint
            // directions. This preserves G1 continuity even on obtuse turns.
            for (let attempt = 0; attempt < 5; attempt++) {

                const curve = new THREE.CubicBezierCurve3(
                    startPosition.clone(),
                    startPosition.clone().addScaledVector(
                        startDirection,
                        startHandle
                    ),
                    laneStart.clone().addScaledVector(
                        laneDirection,
                        -joinHandle
                    ),
                    laneStart.clone()
                );
                segment = new RouteSegment({
                    type: RouteSegmentType.JUNCTION_TRANSITION,
                    curve,
                    resource: this.graph.requireNode(fromId),
                    laneIndex
                });
                const validation = segment.validate({
                    maxTurnRadians: Math.PI * 0.55,
                    allowChordReversal: true
                });

                if (validation.valid) break;

                startHandle *= 0.65;
                joinHandle *= 0.65;

            }

            geometry.add(segment);

        }

        if (laneStart.distanceToSquared(laneEnd) > 0.0025) {

            // The lane itself is deliberately straight. All direction change
            // belongs to junction transitions, so it cannot overshoot the
            // corridor or begin turning before reaching the endpoint.
            const segment = new RouteSegment({
                type: RouteSegmentType.LANE,
                curve: new THREE.LineCurve3(
                    laneStart.clone(),
                    laneEnd.clone()
                ),
                resource: connection,
                laneIndex
            });

            segment.validate({
                axisStart: laneStart,
                axisEnd: laneEnd,
                maxAxisDistance: connection.laneWidth * 0.5
            });
            geometry.add(segment);

        }

        if (recordMetrics) {
            this.navigation.metrics.increment(
                "routeSegmentsCreated",
                geometry.segments.length
            );
            this.navigation.metrics.increment("routeGeometryBuilds");
            this.navigation.metrics.recordTime(
                "routeGeometryMilliseconds",
                performance.now() - started
            );
        }

        return {
            geometry,
            laneStart,
            laneEnd,
            arrivalDirection: laneDirection
        };

    }

    createInteractionGeometry({
        start,
        portal,
        transitionTarget = null,
        departureDirection = null,
        arrivalDirection: authoredArrivalDirection = null,
        type = RouteSegmentType.INTERACTION_APPROACH,
        recordMetrics = true
    }) {

        const started = performance.now();
        const distance = start.distanceTo(portal);

        if (distance <= 0.05) return null;

        const towardPortal = portal.clone().sub(start).normalize();
        const arrivalDirection = authoredArrivalDirection?.lengthSq() > 0.0001
            ? authoredArrivalDirection.clone().normalize()
            : transitionTarget
                ? transitionTarget.clone().sub(portal).normalize()
                : towardPortal;
        const startDirection = departureDirection?.clone().setY(0) ??
            towardPortal.clone();

        if (startDirection.lengthSq() <= 0.0001) {
            startDirection.copy(towardPortal);
        } else {
            startDirection.normalize();
        }
        let startHandle = Math.min(1.2, distance * 0.4);
        let arrivalHandle = startHandle * 0.65;
        let segment = null;

        // Interaction curves follow the same contract as junctions: validation
        // may shorten a handle, but may never replace an authored/observed
        // tangent with a straight interpolation.
        for (let attempt = 0; attempt < 5; attempt++) {

            const curve = new THREE.CubicBezierCurve3(
                start.clone(),
                start.clone().addScaledVector(
                    startDirection,
                    startHandle
                ),
                portal.clone().addScaledVector(
                    arrivalDirection,
                    -arrivalHandle
                ),
                portal.clone()
            );
            segment = new RouteSegment({ type, curve });
            const validation = segment.validate({
                maxTurnRadians: Math.PI * 0.65,
                allowChordReversal: true
            });

            if (validation.valid) break;

            startHandle *= 0.65;
            arrivalHandle *= 0.65;

        }

        if (recordMetrics) {
            this.navigation.metrics.increment("routeSegmentsCreated");
            this.navigation.metrics.increment("routeGeometryBuilds");
            this.navigation.metrics.recordTime(
                "routeGeometryMilliseconds",
                performance.now() - started
            );
        }
        return new RouteGeometry([segment]);

    }

    createInteractionApproachGeometry({
        start,
        laneStart = null,
        portal,
        transitionTarget = null,
        departureDirection = null,
        arrivalDirection = null
    }) {

        if (!laneStart || start.distanceToSquared(laneStart) <= 0.0025) {

            return this.createInteractionGeometry({
                start,
                portal,
                transitionTarget,
                departureDirection,
                arrivalDirection,
                type: RouteSegmentType.INTERACTION_APPROACH
            });

        }

        const geometry = new RouteGeometry();
        const first = this.createInteractionGeometry({
            start,
            portal: laneStart,
            transitionTarget: portal,
            departureDirection,
            type: RouteSegmentType.JUNCTION_TRANSITION
        });
        const joinDirection = portal.clone().sub(laneStart).normalize();
        const second = this.createInteractionGeometry({
            start: laneStart,
            portal,
            transitionTarget,
            departureDirection: joinDirection,
            arrivalDirection,
            type: RouteSegmentType.INTERACTION_APPROACH
        });

        for (const segment of first?.segments ?? []) geometry.add(segment);
        for (const segment of second?.segments ?? []) geometry.add(segment);

        return geometry.segments.length > 0 ? geometry : null;

    }

    projectWaypointsToGround(waypoints, options = {}) {

        if (!this.grounding) return waypoints;

        for (const waypoint of waypoints) {

            if (!waypoint.airborne) {

                this.grounding.projectPosition(
                    waypoint.position,
                    1,
                    options
                );

            }

        }

        return waypoints;

    }

}
