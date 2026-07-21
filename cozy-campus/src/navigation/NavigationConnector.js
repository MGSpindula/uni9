import * as THREE from "three";
import { GeneratedAccessAnchor } from "./GeneratedAccessAnchor";

export class NavigationConnector {

    constructor(graph) {

        this.graph = graph;
        this.points = new Map();
        this.anchors = new Map();

    }

    // -----------------------------
    // Interaction points
    // -----------------------------

    register(point) {

        if (!point?.id) {

            console.log("[NavigationConnector] Interaction point without id ignored.");
            return false;

        }

        if (this.points.has(point.id)) {

            console.log(
                `[NavigationConnector] Duplicate interaction point "${point.id}" ignored.`
            );
            return false;

        }

        this.points.set(point.id, point);
        this.connect(point);

        return point.connection !== null;

    }

    unregister(point) {

        if (!point) return false;

        point.occupants.clear();
        point.reservations.clear();

        this.points.delete(point.id);

        this.anchors.delete(
            `generated:${point.id}`
        );

        point.connection = null;

        return true;

    }

    connect(point, { silent = false } = {}) {

        point.connection = null;
        this.anchors.delete(`generated:${point.id}`);

        if (!point.accessible) {

            if (!silent) {

                console.log(
                    `[NavigationConnector] Interaction point ` +
                    `"${point.id}" is inaccessible.`
                );

            }
            return null;

        }

        if (point.via) {

            const accessConnection = point.via.connection ??
                this.connect(point.via, { silent });

            if (!accessConnection) return null;

            point.connection = {
                nodeIds: accessConnection.nodeIds,
                // The action point inherits both the reachable endpoints and
                // the immutable physical edge used by its approach point.
                segmentNodeIds: accessConnection.segmentNodeIds,
                projectedPosition: point.via.getWorldPosition(),
                distanceSquared: 0,
                automatic: false,
                local: true,
                viaPoint: point.via
            };

            return point.connection;

        }

        const position = point.getWorldPosition();
        const candidates = point.connectTo
            ? this.getOverrideCandidates(point.connectTo)
            : this.getAutomaticCandidates();

        const nearest = candidates
            .map(candidate => this.projectCandidate(candidate, position))
            .filter(Boolean)
            .sort((first, second) =>
                first.distanceSquared - second.distanceSquared
            )[0];

        if (!nearest ||
            nearest.distanceSquared >
            point.maxConnectionDistance * point.maxConnectionDistance) {

            if (!silent) {

                console.log(
                    `[NavigationConnector] No nearby graph access for ` +
                    `"${point.id}".`
                );

            }
            return null;

        }

        const physicalNodeIds = nearest.segmentNodeIds ?? nearest.nodeIds;
        const anchor = physicalNodeIds.length === 2
            ? this.createAccessAnchor(point, nearest)
            : null;

        point.connection = {
            ...nearest,
            anchor,
            automatic: point.connectTo === null
        };

        return point.connection;

    }

    getOverrideCandidates(connectTo) {

        if (typeof connectTo === "string") {

            const node = this.graph.getNode(connectTo);

            if (!node) {

                console.log(
                    `[NavigationConnector] Override node "${connectTo}" does not exist.`
                );
                return [];

            }

            return [{ nodeId: node.id }];

        }

        if (Array.isArray(connectTo) && connectTo.length === 2) {

            const [fromId, toId] = connectTo;

            if (!this.graph.hasNode(fromId) ||
                !this.graph.hasNode(toId) ||
                !this.graph.areConnected(fromId, toId)) {

                console.log(
                    `[NavigationConnector] Override connection "${fromId}" -> "${toId}" does not exist.`
                );
                return [];

            }

            return [{ fromId, toId }];

        }

        console.log("[NavigationConnector] Invalid connectTo override ignored.");
        return [];

    }

    getAutomaticCandidates() {

        const candidates = [];
        const visited = new Set();

        for (const node of this.graph.nodes.values()) {

            for (const neighborId of node.connections.keys()) {

                const key = [node.id, neighborId].sort().join(":");

                if (visited.has(key)) continue;

                const neighbor = this.graph.requireNode(neighborId);
                const connection = node.connections.get(neighborId);

                // A projected access can still use the free half of an edge.
                // Only the blocked endpoint is removed later; the whole edge is
                // unavailable only when its connection or both ends are blocked.
                if (connection.blocked ||
                    (node.blocked && neighbor.blocked)) {

                    continue;

                }

                visited.add(key);
                candidates.push({ fromId: node.id, toId: neighborId });

            }

        }

        return candidates;

    }

    projectCandidate(candidate, position) {

        if (candidate.nodeId) {

            const node = this.graph.requireNode(candidate.nodeId);

            if (node.blocked) return null;

            const projectedPosition = node.position.clone();

            return {
                nodeIds: [node.id],
                projectedPosition,
                distanceSquared: this.graph.getPlanarDistanceSquared(
                    position,
                    projectedPosition
                )
            };

        }

        const from = this.graph.requireNode(candidate.fromId);
        const to = this.graph.requireNode(candidate.toId);
        const resource = this.graph.requireConnection(from.id, to.id);

        if (resource.blocked || (from.blocked && to.blocked)) return null;

        const projectedPosition = this.projectOnSegment(
            position,
            from.position,
            to.position
        );

        return {
            // Treat the projection as a temporary split in the edge. Blocking
            // one endpoint closes only that side of the split. Keep the
            // physical pair separately: the generated anchor and its lane
            // portals still belong to the complete edge and must not vanish
            // merely because only one direction is currently reachable.
            nodeIds: [from, to]
                .filter(node => !node.blocked)
                .map(node => node.id),
            segmentNodeIds: [from.id, to.id],
            projectedPosition,
            distanceSquared: this.graph.getPlanarDistanceSquared(
                position,
                projectedPosition
            )
        };

    }

    projectOnSegment(point, start, end) {

        const segmentX = end.x - start.x;
        const segmentZ = end.z - start.z;
        const lengthSquared = segmentX * segmentX + segmentZ * segmentZ;
        const amount = lengthSquared === 0
            ? 0
            : THREE.MathUtils.clamp(
                ((point.x - start.x) * segmentX +
                    (point.z - start.z) * segmentZ) / lengthSquared,
                0,
                1
            );

        return new THREE.Vector3(
            start.x + segmentX * amount,
            start.y + (end.y - start.y) * amount,
            start.z + segmentZ * amount
        );

    }

    createAccessAnchor(point, projection) {

        const connection = this.graph.requireConnection(
            projection.segmentNodeIds?.[0] ?? projection.nodeIds[0],
            projection.segmentNodeIds?.[1] ?? projection.nodeIds[1]
        );
        const fromId = connection.fromId;
        const toId = connection.toId;
        const from = this.graph.requireNode(fromId).position;
        const to = this.graph.requireNode(toId).position;
        const directionX = to.x - from.x;
        const directionZ = to.z - from.z;
        const lengthSquared = directionX ** 2 + directionZ ** 2;
        const length = Math.sqrt(lengthSquared) || 1;
        const normalX = directionZ / length;
        const normalZ = -directionX / length;
        const amount = lengthSquared === 0
            ? 0
            : THREE.MathUtils.clamp(
                ((projection.projectedPosition.x - from.x) * directionX +
                    (projection.projectedPosition.z - from.z) * directionZ) /
                lengthSquared,
                0,
                1
            );
        const center = projection.projectedPosition.clone();
        const halfWidth = connection.laneWidth * 0.5;
        const lanePositions = [-halfWidth, halfWidth].map(offset =>
            center.clone().add(
                new THREE.Vector3(normalX * offset, 0, normalZ * offset)
            )
        );
        const id = `generated:${point.id}`;
        const anchor = this.anchors.get(id) ??
            new GeneratedAccessAnchor(id);

        anchor.update({
            nodeIds: [fromId, toId],
            amount,
            center,
            lanePositions
        });
        this.anchors.set(id, anchor);

        return anchor;

    }

    getPortalPosition(point, connection, laneIndex = null) {

        if (connection.anchor) {

            if (Number.isInteger(laneIndex) &&
                connection.anchor.lanePositions[laneIndex]) {

                return connection.anchor.lanePositions[laneIndex].clone();

            }

            // Proximity is only a fallback for a route with no known travel
            // direction. Directional entry/exit must explicitly choose the
            // right-hand lane before requesting its portal.
            return connection.anchor.getClosestLanePosition(
                point.getWorldPosition()
            );

        }

        const portal = connection.projectedPosition.clone();

        if (connection.nodeIds?.length !== 2) return portal;

        const [fromId, toId] = connection.nodeIds;
        const from = this.graph.requireNode(fromId).position;
        const to = this.graph.requireNode(toId).position;
        const resource = this.graph.requireConnection(fromId, toId);
        const directionX = to.x - from.x;
        const directionZ = to.z - from.z;
        const length = Math.hypot(directionX, directionZ) || 1;
        const normalX = -directionZ / length;
        const normalZ = directionX / length;
        const pointPosition = point.getWorldPosition();
        const side = Math.sign(
            (pointPosition.x - portal.x) * normalX +
            (pointPosition.z - portal.z) * normalZ
        ) || 1;
        const offset = resource.laneWidth * 0.5 * side;

        portal.x += normalX * offset;
        portal.z += normalZ * offset;

        return portal;

    }

    getRightHandLaneIndex(fromId, toId) {

        const connection = this.graph.requireConnection(fromId, toId);

        // Index 0 is right-hand traffic in the connection's canonical
        // fromId -> toId orientation. Reversing travel reverses left/right in
        // world space, so index 1 becomes that actor's right-hand lane.
        return connection.fromId === fromId ? 0 : 1;

    }

    getApproachExitLaneIndex(point, connection, destinationNodeId) {

        const lanePositions = connection.anchor?.lanePositions ?? [];

        if (lanePositions.length < 2) {

            const otherNodeId = (connection.segmentNodeIds ??
                connection.nodeIds)?.find(id => id !== destinationNodeId);

            return otherNodeId
                ? this.getRightHandLaneIndex(otherNodeId, destinationNodeId)
                : null;

        }

        const pointPosition = point.getWorldPosition();
        const departureDirection = point.getWorldDirection().negate();
        const rightDirection = new THREE.Vector3(
            departureDirection.z,
            0,
            -departureDirection.x
        );
        const destinationDirection = this.graph
            .requireNode(destinationNodeId)
            .position.clone()
            .sub(pointPosition);

        destinationDirection.y = 0;

        const closestLaneIndex = lanePositions.reduce(
            (closestIndex, position, index) =>
                position.distanceToSquared(pointPosition) <
                    lanePositions[closestIndex]
                        .distanceToSquared(pointPosition)
                    ? index
                    : closestIndex,
            0
        );
        const farthestLaneIndex = lanePositions.reduce(
            (farthestIndex, position, index) =>
                position.distanceToSquared(pointPosition) >
                    lanePositions[farthestIndex]
                        .distanceToSquared(pointPosition)
                    ? index
                    : farthestIndex,
            0
        );

        if (destinationDirection.lengthSq() <= 0.0001 ||
            rightDirection.lengthSq() <= 0.0001) {

            return closestLaneIndex;

        }

        // An approach is authored beside its graph segment. When leaving it,
        // the node on the actor's right is reached through the near lane; the
        // node on the actor's left is reached through the far lane. Using the
        // connection's canonical from/to order here inverts this relationship
        // whenever that order happens to oppose the authored approach.
        return destinationDirection.dot(rightDirection) >= 0
            ? closestLaneIndex
            : farthestLaneIndex;

    }

    // -----------------------------
    // Route creation
    // -----------------------------

    isPointAvailable(point, agent = null) {

        const users = new Set([
            ...point.occupants,
            ...point.reservations
        ]);

        if (agent) users.delete(agent);

        return point.accessible && users.size < point.capacity;

    }

    occupyPoint(point, agent) {

        if (!this.isPointAvailable(point, agent)) return false;

        point.reservations.delete(agent);
        point.occupants.add(agent);

        return true;

    }

    reservePoint(point, agent) {

        if (!this.isPointAvailable(point, agent)) return false;

        point.reservations.add(agent);

        return true;

    }

    reserveRoutePoints(route, agent) {

        const points = [...new Set(
            route.waypoints
                .map(waypoint => waypoint.interactionPoint)
                .filter(Boolean)
        )];
        const reserved = [];

        for (const point of points) {

            if (!this.reservePoint(point, agent)) {

                for (const reservedPoint of reserved) {

                    reservedPoint.reservations.delete(agent);

                }

                return false;

            }

            reserved.push(point);

        }

        return true;

    }

    releasePoint(point, agent) {

        point.occupants.delete(agent);
        point.reservations.delete(agent);

    }

    releaseAgent(agent) {

        for (const point of this.points.values()) {

            this.releasePoint(point, agent);

        }

    }

    releaseReservations(agent) {

        for (const point of this.points.values()) {

            point.reservations.delete(agent);

        }

    }

    createRoute(point, startId, agent, {
        avoidFirstStepTo = null
    } = {}) {

        const accessPoint = point.via ?? point;

        if (!this.isPointAvailable(point, agent) ||
            !this.isPointAvailable(accessPoint, agent)) return null;

        // Reconnect because graph blocking and object transforms can change.
        const connection = this.connect(accessPoint);

        if (!connection) return null;

        const segmentNodeIds = connection.segmentNodeIds ??
            connection.nodeIds;

        const createCandidates = avoidedNodeId => connection.nodeIds
            .map(endpointId => {

                const path = this.graph.findPreferredPath(
                    startId,
                    endpointId,
                    agent,
                    { avoidFirstStepTo: avoidedNodeId }
                );

                if (!path) return null;

                const reversesDirectlyIntoAccess = Boolean(
                    avoidedNodeId &&
                    endpointId === startId &&
                    path.nodeIds.length === 1 &&
                    segmentNodeIds.length === 2 &&
                    segmentNodeIds.includes(avoidedNodeId)
                );

                if (reversesDirectlyIntoAccess) return null;

                return {
                    endpointId,
                    path,
                    requiresUTurn:
                        path.nodeIds[1] === avoidFirstStepTo,
                    requiresAccessUTurn: false,
                    cost: path.cost + Math.sqrt(
                        this.graph.getPlanarDistanceSquared(
                            this.graph.requireNode(endpointId).position,
                            connection.projectedPosition
                        )
                    )
                };

            })
            .filter(Boolean);

        let routes = createCandidates(avoidFirstStepTo);

        if (routes.length === 0 && avoidFirstStepTo) {

            // A cul-de-sac has no forward alternative. Keep the interaction
            // reachable, but tell route construction that returning through
            // the previous edge requires a deliberate curved U-turn.
            routes = createCandidates(null).map(candidate => {

                const requiresAccessUTurn =
                    candidate.endpointId === startId &&
                    candidate.path.nodeIds.length === 1 &&
                    segmentNodeIds.length === 2 &&
                    segmentNodeIds.includes(avoidFirstStepTo);

                return {
                    ...candidate,
                    requiresUTurn:
                        candidate.path.nodeIds[1] === avoidFirstStepTo ||
                        requiresAccessUTurn,
                    requiresAccessUTurn
                };

            });

        }

        if (routes.length === 0) return null;

        const route = routes.reduce((best, current) =>
            current.cost < best.cost ? current : best
        );
        const waypoints =
            this.graph.createWaypoints(
                route.path.nodeIds
            );

        const otherNodeId = segmentNodeIds.length === 2
            ? segmentNodeIds.find(id => id !== route.endpointId) ?? null
            : null;
        const laneIndex = connection.anchor && otherNodeId
            ? this.getRightHandLaneIndex(route.endpointId, otherNodeId)
            : null;
        const portalPosition = this.getPortalPosition(
            accessPoint,
            connection,
            laneIndex
        );
        const laneStartPosition = laneIndex === null
            ? null
            : this.graph.getConnectionLaneNodePosition(
                route.endpointId,
                route.endpointId,
                otherNodeId,
                laneIndex
            );

        waypoints.push({
            id: null,

            position:
                portalPosition,

            leavingGraph: true,

            departureRequest: {
                originId:
                    route.endpointId,

                transitionTarget:
                    accessPoint
                        .getWorldPosition()
            },
            // An interaction projected on an edge must be entered through the
            // same lane geometry as ordinary traffic. The TrafficSystem uses
            // this portal to make endpoint -> lane start -> anchor explicit.
            laneStartPosition,
            plannedLaneIndex: laneIndex,
            requiresPostLoopUTurn: route.requiresAccessUTurn
        });

        if (accessPoint !== point) {

            waypoints.push({
                id: null,

                position:
                    accessPoint
                        .getWorldPosition(),

                interactionPoint:
                    accessPoint
            });

        }

        waypoints.push({
            id: null,

            position:
                point.getWorldPosition(),

            interactionPoint:
                point
        });

        return {
            endpointId: route.endpointId,
            cost: route.cost,
            requiresUTurn: route.requiresUTurn,
            waypoints
        };

    }

    createExitWaypoints(point, destinationNodeId = null) {

        if (!point) return [];

        const accessPoint = point.via ?? point;
        const connection = this.connect(accessPoint);

        if (!connection) return [];

        const waypoints = [];
        const departureDirection = accessPoint.getWorldDirection().negate();

        if (point !== accessPoint) {

            waypoints.push({
                id: null,
                position: accessPoint.getWorldPosition(),
                interactionPoint: accessPoint,
                // This is the physical action -> approach transition. It must
                // not end the active interaction yet: the action remains busy
                // until the actor crosses the graph-entry portal below.
                interactionExitPoint: true,
                departureDirection,
                // seat -> approach belongs to the interaction animation. Keep
                // the facing established at approach instead of turning the
                // actor toward the backwards displacement.
                preserveFacing: point.metadata.preserveFacing === true
            });

        }

        const otherNodeId = (connection.segmentNodeIds ??
            connection.nodeIds)?.find(
            id => id !== destinationNodeId
        ) ?? null;
        const laneIndex = connection.anchor && destinationNodeId && otherNodeId
            ? this.getApproachExitLaneIndex(
                accessPoint,
                connection,
                destinationNodeId
            )
            : null;
        const portalPosition = this.getPortalPosition(
            accessPoint,
            connection,
            laneIndex
        );

        waypoints.push({
            id: null,
            position: portalPosition,
            plannedLaneIndex: laneIndex,
            leavingInteraction: true,
            // When already standing at approach, this is the first exit
            // waypoint and therefore owns the same immediate 180° turn.
            departureDirection: point === accessPoint
                ? departureDirection
                : null,
            connectionEntry: destinationNodeId && otherNodeId
                ? {
                    fromId: otherNodeId,
                    toId: destinationNodeId,
                    anchorId: connection.anchor?.id ?? null,
                    laneIndex,
                    originKey: `interaction:${accessPoint.id}`
                }
                : null,
            // A direct connectTo: "node" has no edge/lane to enter. Reaching
            // its portal therefore means the actor physically entered that
            // graph node and must establish currentNodeId before continuing.
            graphEntryNodeId: destinationNodeId &&
                connection.nodeIds?.length === 1 &&
                connection.nodeIds[0] === destinationNodeId
                ? destinationNodeId
                : null
        });

        return waypoints;

    }

}
