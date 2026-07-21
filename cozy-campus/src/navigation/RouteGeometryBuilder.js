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
            !context.interactionPoint &&
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

        // createRoute() includes the graph origin as a normal node waypoint.
        // While leaving an InteractionPoint, createExitWaypoints() already
        // owns that arrival through its lane portal. Keeping the origin here
        // would insert the node center between the portal and the next lane.
        if (context.interactionPoint) {

            const nodeIds = graphWaypoints.map(waypoint => waypoint.id);
            const directNodeExit = exitWaypoints.find(
                waypoint => waypoint.graphEntryNodeId
            );
            const entryConnection = exitWaypoints.find(
                waypoint => waypoint.connectionEntry
            )?.connectionEntry ?? null;

            if (directNodeExit &&
                directNodeExit.graphEntryNodeId === nodeIds[0] &&
                nodeIds[1] &&
                this.graph.areConnected(nodeIds[0], nodeIds[1])) {

                // A direct node InteractionPoint has no authored portal. Use
                // the next topological edge to request a real lane, then let
                // Traffic replace this placeholder with that lane start.
                directNodeExit.connectionEntry = {
                    fromId: nodeIds[0],
                    toId: nodeIds[1],
                    preferredLaneIndex: null,
                    originKey:
                        `interaction:${context.interactionPoint.id}`
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
                        nodeIds,
                        graphWaypoints,
                        { entryConnection }
                    ),
                    ...remainingWaypoints
                ];

            }

            if (nodeIds.length < 2) return remainingWaypoints;

            return [
                ...this.preserveTopologicalWaypoints(
                    context,
                    nodeIds,
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

    createAuthorizedConnectionGeometry({
        actor,
        fromId,
        toId,
        laneIndex,
        startPosition = actor.object3D.position,
        laneStartOverride = null,
        departureDirection = null
    }) {

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

            const startHandle = Math.min(1.25, transitionDistance / 3);
            const joinHandle = Math.min(
                1.25,
                transitionDistance / 3,
                Math.max(laneStart.distanceTo(laneEnd) / 3, 0.1)
            );
            let curve = new THREE.CubicBezierCurve3(
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
            let segment = new RouteSegment({
                type: RouteSegmentType.JUNCTION_TRANSITION,
                curve,
                resource: this.graph.requireNode(fromId),
                laneIndex
            });
            const validation = segment.validate({
                maxTurnRadians: Math.PI * 0.55
            });

            if (!validation.valid) {

                // A stale incoming tangent must never create a loop. Falling
                // back to the local displacement still reaches the same lane
                // portal and only sacrifices curvature inside this junction.
                curve = new THREE.CubicBezierCurve3(
                    startPosition.clone(),
                    startPosition.clone().lerp(laneStart, 0.33),
                    laneStart.clone().addScaledVector(
                        laneDirection,
                        -Math.min(joinHandle, transitionDistance * 0.2)
                    ),
                    laneStart.clone()
                );
                segment = new RouteSegment({
                    type: RouteSegmentType.JUNCTION_TRANSITION,
                    curve,
                    resource: this.graph.requireNode(fromId),
                    laneIndex
                });
                segment.validate({ maxTurnRadians: Math.PI * 0.75 });

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
        type = RouteSegmentType.INTERACTION_APPROACH
    }) {

        const distance = start.distanceTo(portal);

        if (distance <= 0.05) return null;

        const towardPortal = portal.clone().sub(start).normalize();
        const arrivalDirection = transitionTarget
            ? transitionTarget.clone().sub(portal).normalize()
            : towardPortal;
        const startDirection = departureDirection?.clone().normalize() ??
            towardPortal;
        const handle = Math.min(1.2, distance * 0.4);
        let curve = new THREE.CubicBezierCurve3(
            start.clone(),
            start.clone().addScaledVector(startDirection, handle),
            portal.clone().addScaledVector(
                arrivalDirection,
                -handle * 0.65
            ),
            portal.clone()
        );
        let segment = new RouteSegment({ type, curve });
        const validation = segment.validate({
            maxTurnRadians: Math.PI * 0.65
        });

        if (!validation.valid) {

            curve = new THREE.CubicBezierCurve3(
                start.clone(),
                start.clone().lerp(portal, 0.33),
                portal.clone().addScaledVector(
                    arrivalDirection,
                    -Math.min(handle * 0.35, distance * 0.2)
                ),
                portal.clone()
            );
            segment = new RouteSegment({ type, curve });
            segment.validate();

        }

        return new RouteGeometry([segment]);

    }

    createInteractionApproachGeometry({
        start,
        laneStart = null,
        portal,
        transitionTarget = null,
        departureDirection = null
    }) {

        if (!laneStart || start.distanceToSquared(laneStart) <= 0.0025) {

            return this.createInteractionGeometry({
                start,
                portal,
                transitionTarget,
                departureDirection,
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
