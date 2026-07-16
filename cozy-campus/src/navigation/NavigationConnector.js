import * as THREE from "three";

export class NavigationConnector {

    constructor(graph) {

        this.graph = graph;
        this.points = new Map();

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

    connect(point) {

        point.connection = null;

        if (!point.accessible) {

            console.log(
                `[NavigationConnector] Interaction point "${point.id}" is inaccessible.`
            );
            return null;

        }

        if (point.via) {

            const accessConnection = point.via.connection ??
                this.connect(point.via);

            if (!accessConnection) return null;

            point.connection = {
                nodeIds: accessConnection.nodeIds,
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

            console.log(
                `[NavigationConnector] No nearby graph access for "${point.id}".`
            );
            return null;

        }

        point.connection = {
            ...nearest,
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
            // one endpoint closes only that side of the split.
            nodeIds: [from, to]
                .filter(node => !node.blocked)
                .map(node => node.id),
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

    createRoute(point, startId, agent) {

        const accessPoint = point.via ?? point;

        if (!this.isPointAvailable(point, agent) ||
            !this.isPointAvailable(accessPoint, agent)) return null;

        // Reconnect because graph blocking and object transforms can change.
        const connection = this.connect(accessPoint);

        if (!connection) return null;

        const routes = connection.nodeIds
            .map(endpointId => {

                const path = this.graph.findShortestPath(startId, endpointId, {
                    agent,
                    // Occupied resources remain structurally reachable. The
                    // agent waits at traversal time until they become free.
                    avoidOccupied: false
                });

                if (!path) return null;

                return {
                    endpointId,
                    path,
                    cost: path.cost + Math.sqrt(
                        this.graph.getPlanarDistanceSquared(
                            this.graph.requireNode(endpointId).position,
                            connection.projectedPosition
                        )
                    )
                };

            })
            .filter(Boolean);

        if (routes.length === 0) return null;

        const route = routes.reduce((best, current) =>
            current.cost < best.cost ? current : best
        );
        const waypoints = this.graph.createWaypoints(route.path.nodeIds);

        if (this.graph.getPlanarDistanceSquared(
            this.graph.requireNode(route.endpointId).position,
            connection.projectedPosition
        ) > 0.0001) {

            waypoints.push({
                id: null,
                position: connection.projectedPosition.clone(),
                leavingGraph: true
            });

        }

        if (accessPoint !== point) {

            waypoints.push({
                id: null,
                position: accessPoint.getWorldPosition(),
                interactionPoint: accessPoint
            });

        }

        waypoints.push({
            id: null,
            position: point.getWorldPosition(),
            interactionPoint: point
        });

        return {
            endpointId: route.endpointId,
            cost: route.cost,
            waypoints
        };

    }

    createExitWaypoints(point, destinationNodeId = null) {

        if (!point) return [];

        const accessPoint = point.via ?? point;
        const connection = this.connect(accessPoint);

        if (!connection) return [];

        const waypoints = [];

        if (point !== accessPoint) {

            waypoints.push({
                id: null,
                position: accessPoint.getWorldPosition(),
                interactionPoint: accessPoint
            });

        }

        const otherNodeId = connection.nodeIds?.find(
            id => id !== destinationNodeId
        ) ?? null;

        waypoints.push({
            id: null,
            position: connection.projectedPosition.clone(),
            leavingInteraction: true,
            connectionEntry: destinationNodeId && otherNodeId
                ? { fromId: otherNodeId, toId: destinationNodeId }
                : null
        });

        return waypoints;

    }

}
