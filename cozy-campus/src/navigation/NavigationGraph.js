export class NavigationGraph {

    constructor({ selectionRadius = 1.25 } = {}) {

        this.nodes = new Map();
        this.selectionRadius = selectionRadius;
        this.invalidNodeIds = new Set();
        this.validationErrors = [];
        this.activeLaneCurves = new Map();
        this.revision = 0;

    }

    // -----------------------------
    // Nodes
    // -----------------------------

    addNode(id, position, metadata = {}) {

        if (!id || !position?.isVector3) {

            this.reportValidationError(
                "INVALID_NODE",
                `Node "${id ?? "<without id>"}" has invalid data.`
            );
            return null;

        }

        if (this.nodes.has(id) || this.invalidNodeIds.has(id)) {

            // Neither copy is trustworthy: keeping the first would silently
            // make every connection point to an arbitrary Blender object.
            this.nodes.delete(id);

            for (const node of this.nodes.values()) {

                node.connections.delete(id);

            }

            this.invalidNodeIds.add(id);
            this.reportValidationError(
                "DUPLICATE_NODE_ID",
                `Duplicate node id "${id}". All copies were ignored.`
            );
            return null;

        }

        const node = {
            id,
            position: position.clone(),
            blocked: metadata.blocked ?? false,
            // Circulation nodes are passable by default. Mark a genuinely
            // indivisible doorway/platform with exclusive: true.
            exclusive: metadata.exclusive ?? false,
            capacity: metadata.capacity ??
                (metadata.exclusive ? 1 : Infinity),
            occupants: new Set(),
            reservations: new Set(),
            // Soft commitments used only by circulation. They must not make a
            // non-exclusive node impassable like an authored hard reservation.
            transitReservations: new Set(),
            restingAgents: new Set(),
            metadata: { ...metadata },
            connections: new Map()
        };

        this.nodes.set(id, node);
        this.revision++;

        return node;

    }

    getNode(id) {

        return this.nodes.get(id) ?? null;

    }

    hasNode(id) {

        return this.nodes.has(id);

    }

    requireNode(id) {

        const node = this.getNode(id);

        if (!node) throw new Error(`NavigationGraph does not contain node "${id}".`);

        return node;

    }

    setNodePosition(id, position) {

        const node = this.requireNode(id);

        if (node.position.equals(position)) return;

        node.position.copy(position);
        this.revision++;

    }

    setNodeBlocked(id, blocked = true) {

        const node = this.requireNode(id);

        if (node.blocked === blocked) return;

        node.blocked = blocked;
        this.revision++;

    }

    isNodeBlocked(id) {

        return this.requireNode(id).blocked;

    }

    // -----------------------------
    // Connections
    // -----------------------------

    connect(fromId, toId, {
        bidirectional = true,
        metadata = {},
        // Global spacing between the centers of lanes A and B. Override with
        // graph.connect(fromId, toId, { laneWidth: ... }) for one connection.
        laneWidth = 1.0
    } = {}) {

        const from = this.getNode(fromId);
        const to = this.getNode(toId);

        if (!from || !to) {

            this.reportValidationError(
                "INVALID_CONNECTION",
                `Connection "${fromId}" -> "${toId}" references a missing or invalid node.`
            );
            return null;

        }
        const delta = to.position.clone().sub(from.position);
        const horizontalDistance = Math.hypot(delta.x, delta.z);
        const slopeAngle = Math.atan2(
            Math.abs(delta.y),
            horizontalDistance || Number.EPSILON
        );
        const resource = {
            fromId,
            toId,
            blocked: false,
            laneWidth,
            lanes: Array.from({ length: 2 }, (_, index) => ({
                index,
                occupants: new Set(),
                reservations: new Set(),
                directions: new Map()
            })),
            occupants: new Set(),
            reservations: new Set(),
            metadata: {
                traversal: "flat",
                slopeAngle,
                rise: delta.y,
                ...metadata
            }
        };

        from.connections.set(toId, resource);

        if (bidirectional) to.connections.set(fromId, resource);

        this.revision++;

        return resource;

    }

    // -----------------------------
    // Validation
    // -----------------------------

    reportValidationError(type, message) {

        const error = { type, message };

        this.validationErrors.push(error);
        console.log(`[NavigationGraph:${type}] ${message}`);

        return error;

    }

    isValid() {

        return this.validationErrors.length === 0;

    }

    disconnect(fromId, toId, { bidirectional = true } = {}) {

        this.requireNode(fromId).connections.delete(toId);

        if (bidirectional) this.requireNode(toId).connections.delete(fromId);

    }

    requireConnection(fromId, toId) {

        const connection = this.requireNode(fromId).connections.get(toId);

        if (!connection) {

            throw new Error(
                `NavigationGraph nodes "${fromId}" and "${toId}" are not connected.`
            );

        }

        return connection;

    }

    setConnectionBlocked(fromId, toId, blocked = true) {

        const connection = this.requireConnection(fromId, toId);

        if (connection.blocked === blocked) return;

        connection.blocked = blocked;
        this.revision++;

    }

    isConnectionBlocked(fromId, toId) {

        return this.requireConnection(fromId, toId).blocked;

    }

    areConnected(fromId, toId) {

        return this.requireNode(fromId).connections.has(toId);

    }

    // -----------------------------
    // Occupancy and reservations
    // -----------------------------

    isNodeAvailable(id, agent = null) {

        const node = this.requireNode(id);

        if (node.blocked) return false;

        // An actor standing on the logical center is still using the crossing.
        // Only actors that have moved to an idle slot may be passed safely.
        for (const occupant of node.occupants) {

            if (occupant !== agent && !node.restingAgents.has(occupant)) {

                return false;

            }

        }

        // A reservation represents an actor already committed to entering the
        // center. It must prevent a second actor from reserving the same node.
        for (const reservation of node.reservations) {

            if (reservation !== agent) return false;

        }
        for (const reservation of node.transitReservations) {

            if (reservation !== agent) return false;

        }

        if (!node.exclusive) return true;

        return this.isResourceAvailable(node, agent);

    }

    isNodePassable(id) {

        const node = this.requireNode(id);

        if (node.blocked) return false;

        for (const occupant of node.occupants) {

            if (!node.restingAgents.has(occupant)) return false;

        }

        if (node.reservations.size > 0) return false;

        return !node.exclusive || node.occupants.size === 0;

    }

    isNodeAgentResting(id, agent) {

        return this.requireNode(id).restingAgents.has(agent);

    }

    getNodeOccupants(id) {

        return [...this.requireNode(id).occupants];

    }

    isConnectionAvailable(fromId, toId, agent = null) {

        return this.findAvailableLaneIndex(
            this.requireConnection(fromId, toId),
            fromId,
            toId,
            agent
        ) !== null;

    }

    isResourceAvailable(resource, agent = null) {

        if (resource.blocked) return false;

        const users = new Set([
            ...resource.occupants,
            ...resource.reservations
        ]);

        if (agent) users.delete(agent);

        return users.size < resource.capacity;

    }

    reserveNode(id, agent) {

        if (!this.isNodeAvailable(id, agent)) return false;

        return this.reserveResource(this.requireNode(id), agent);

    }

    reserveConnectionLane(fromId, toId, agent) {

        const connection = this.requireConnection(fromId, toId);
        const existingLane = connection.lanes.find(lane =>
            lane.reservations.has(agent) || lane.occupants.has(agent)
        );

        // Retries must preserve lane identity. Reserving a second free lane
        // made one actor appear in both lanes and corrupted their geometry.
        if (existingLane) return existingLane.index;

        const laneIndex = this.findAvailableLaneIndex(
            connection,
            fromId,
            toId,
            agent
        );

        if (laneIndex === null) return null;

        connection.lanes[laneIndex].reservations.add(agent);
        connection.lanes[laneIndex].directions.set(agent, {
            fromId,
            toId
        });
        connection.reservations.add(agent);

        return laneIndex;

    }

    hasOtherNodeCommitments(id, agent) {

        const node = this.requireNode(id);

        return [...node.reservations, ...node.transitReservations]
            .some(candidate => candidate !== agent);

    }

    getConnectionLaneIndex(fromId, toId, agent) {

        const connection = this.requireConnection(fromId, toId);
        const lane = connection.lanes.find(candidate =>
            candidate.reservations.has(agent) ||
            candidate.occupants.has(agent)
        );

        return lane?.index ?? null;

    }

    reserveNodeForTransit(id, agent) {

        const node = this.requireNode(id);

        if (node.blocked) return false;

        // A transit reservation is an endpoint claim, not just a diagnostic
        // marker. Do not let two actors enter the same node and rely on Cannon
        // to decide which one gets stuck there.
        if ([...node.reservations].some(candidate => candidate !== agent)) {
            return false;
        }
        if ([...node.occupants].some(candidate =>
            candidate !== agent && !node.restingAgents.has(candidate)
        )) {
            return false;
        }
        if ([...node.transitReservations].some(candidate =>
            candidate !== agent
        )) {
            return false;
        }

        if (node.exclusive) return this.reserveNode(id, agent);

        node.transitReservations.add(agent);
        return true;

    }

    reserveSpecificConnectionLane(fromId, toId, laneIndex, agent) {

        const connection = this.requireConnection(fromId, toId);
        const existingLane = connection.lanes.find(lane =>
            lane.reservations.has(agent) || lane.occupants.has(agent)
        );

        if (existingLane) return existingLane.index === laneIndex
            ? laneIndex
            : null;

        const lane = connection.lanes[laneIndex];
        if (!lane || connection.blocked) return null;

        const users = new Set([
            ...lane.occupants,
            ...lane.reservations
        ]);
        users.delete(agent);

        // Interaction approaches have a physical side. Using the other lane
        // as fallback would make the actor cross the path before departing.
        if (users.size > 0) return null;

        lane.reservations.add(agent);
        lane.directions.set(agent, { fromId, toId });
        connection.reservations.add(agent);

        return laneIndex;

    }

    findAvailableLaneIndex(connection, fromId, toId, agent = null) {

        if (connection.blocked) return null;

        const sameDirection = connection.fromId === fromId;
        // The project names index 0 as the right lane in the canonical
        // direction. Reversing traversal makes index 1 the right lane.
        const preferredIndex = sameDirection ? 0 : 1;
        const order = [
            preferredIndex,
            ...connection.lanes
                .map(lane => lane.index)
                .filter(index => index !== preferredIndex)
        ];

        // Both lanes are active resources. Direction only selects the first
        // preference; any free lane may be used without overtaking logic.
        for (const index of order) {

            const lane = connection.lanes[index];
            const users = new Set([
                ...lane.occupants,
                ...lane.reservations
            ]);

            if (agent) users.delete(agent);
            if (users.size === 0) return index;

        }

        return null;

    }

    reserveResource(resource, agent) {

        if (!this.isResourceAvailable(resource, agent)) return false;

        resource.reservations.add(agent);
        return true;

    }

    occupyNode(id, agent) {

        const node = this.requireNode(id);
        const occupied = this.occupyResource(node, agent);

        if (occupied) {

            node.transitReservations.delete(agent);
            node.restingAgents.delete(agent);

        }

        return occupied;

    }

    occupyConnection(fromId, toId, agent) {

        const connection = this.requireConnection(fromId, toId);
        const reservedLane = connection.lanes.find(lane =>
            lane.reservations.has(agent)
        );
        const laneIndex = reservedLane?.index ??
            this.findAvailableLaneIndex(connection, fromId, toId, agent);

        if (laneIndex === null) return false;

        return this.occupyConnectionLane(fromId, toId, agent, laneIndex);

    }

    occupyConnectionLane(fromId, toId, agent, laneIndex) {

        const connection = this.requireConnection(fromId, toId);
        const lane = connection.lanes[laneIndex];

        if (!lane) return false;

        lane.reservations.delete(agent);
        lane.occupants.add(agent);
        connection.reservations.delete(agent);
        connection.occupants.add(agent);
        return true;

    }

    occupyResource(resource, agent) {

        if (!this.isResourceAvailable(resource, agent)) return false;

        resource.reservations.delete(agent);
        resource.occupants.add(agent);

        return true;

    }

    releaseNode(id, agent) {

        const node = this.requireNode(id);

        node.restingAgents.delete(agent);
        node.transitReservations.delete(agent);
        this.releaseResource(node, agent);

    }

    releaseNodeReservation(id, agent) {

        const node = this.requireNode(id);

        node.reservations.delete(agent);
        node.transitReservations.delete(agent);

    }

    setNodeAgentResting(id, agent, resting = true) {

        const node = this.requireNode(id);

        if (!node.occupants.has(agent)) return false;

        if (resting) node.restingAgents.add(agent);
        else node.restingAgents.delete(agent);

        return true;

    }

    getConnectionLaneNodePosition(nodeId, fromId, toId, laneIndex) {

        const connection = this.requireConnection(fromId, toId);
        const start = this.requireNode(connection.fromId).position;
        const end = this.requireNode(connection.toId).position;
        const deltaX = end.x - start.x;
        const deltaZ = end.z - start.z;
        const length = Math.hypot(deltaX, deltaZ) || 1;
        const sideX = deltaZ / length;
        const sideZ = -deltaX / length;
        const center = (connection.lanes.length - 1) / 2;
        const offset = (laneIndex - center) * connection.laneWidth;
        const position = this.requireNode(nodeId).position.clone();
        const travelStart = this.requireNode(fromId).position;
        const travelEnd = this.requireNode(toId).position;
        const travelDirection = travelEnd.clone().sub(travelStart);
        const travelLength = travelDirection.length();
        const configuredRadius =
            this.requireNode(nodeId).metadata.laneRadius ?? 1.2;
        const nodeRadius = Math.min(configuredRadius, travelLength * 0.25);

        if (travelLength > 0) travelDirection.divideScalar(travelLength);

        position.x += sideX * offset;
        position.z += sideZ * offset;

        // Arrival stops before the node center; departure starts beyond it.
        // The gap becomes the curved transition area between two connections.
        position.addScaledVector(
            travelDirection,
            nodeId === fromId ? nodeRadius : -nodeRadius
        );

        return position;

    }

    setActiveLaneCurve(agent, points) {

        this.activeLaneCurves.set(agent, points.map(point => point.clone()));

    }

    clearActiveLaneCurve(agent) {

        this.activeLaneCurves.delete(agent);

    }

    releaseConnection(fromId, toId, agent) {

        const connection = this.requireConnection(fromId, toId);

        for (const lane of connection.lanes) {

            lane.occupants.delete(agent);
            lane.reservations.delete(agent);
            lane.directions.delete(agent);

        }

        this.releaseResource(connection, agent);

    }

    releaseResource(resource, agent) {

        resource.occupants.delete(agent);
        resource.reservations.delete(agent);

    }

    releaseReservations(agent) {

        for (const node of this.nodes.values()) {

            node.reservations.delete(agent);
            node.transitReservations.delete(agent);

            for (const connection of node.connections.values()) {

                connection.reservations.delete(agent);

                for (const lane of connection.lanes) {

                    lane.reservations.delete(agent);
                    lane.directions.delete(agent);

                }

            }

        }

    }

    releaseAgent(agent) {

        for (const node of this.nodes.values()) {

            node.restingAgents.delete(agent);
            node.transitReservations.delete(agent);
            this.releaseResource(node, agent);

            for (const connection of node.connections.values()) {

                for (const lane of connection.lanes) {

                    lane.occupants.delete(agent);
                    lane.reservations.delete(agent);
                    lane.directions.delete(agent);

                }

                this.releaseResource(connection, agent);

            }

        }

    }

    // -----------------------------
    // Weighted planning
    // -----------------------------

    planClosestPath(startId, position, agent, { maxDetourFactor = 1.5 } = {}) {

        // The click chooses a destination before pathfinding. Pathfinding must
        // never silently replace that destination with a nearby reachable node.
        const destination = this.findClosestNode(position);

        if (!destination || destination.blocked) {

            return { status: "unreachable", nodeIds: [] };

        }

        const directPlan = this.findShortestPath(startId, destination.id, {
            agent,
            avoidOccupied: false
        });

        // No structural path exists. Occupancy is ignored by directPlan, so a
        // null result here means waiting cannot make this destination reachable.
        if (!directPlan) return { status: "unreachable", nodeIds: [] };

        const availablePlan = this.findShortestPath(startId, destination.id, {
            agent,
            avoidOccupied: true
        });

        const maximumDetour = directPlan.cost === 0
            ? 0
            : directPlan.cost * maxDetourFactor;

        if (availablePlan && availablePlan.cost <= maximumDetour) {

            return {
                status: "ready",
                nodeIds: availablePlan.nodeIds,
                cost: availablePlan.cost,
                destinationId: destination.id
            };

        }

        const unavailable = this.findFirstUnavailableResource(
            directPlan.nodeIds,
            agent
        );

        if (!unavailable) {

            return {
                status: "ready",
                nodeIds: directPlan.nodeIds,
                cost: directPlan.cost,
                destinationId: destination.id
            };

        }

        return {
            status: "waiting",
            // Keep the unavailable waypoint so traversal waits immediately
            // before the unavailable resource instead of truncating its route.
            nodeIds: directPlan.nodeIds.slice(0, unavailable.index + 2),
            fullNodeIds: directPlan.nodeIds,
            waitingFor: unavailable.resource,
            destinationId: destination.id,
            cost: directPlan.cost
        };

    }

    findClosestNode(position) {

        const nodes = [...this.nodes.values()];

        if (nodes.length === 0) return null;

        const closest = nodes.reduce((closestNode, node) =>
            node.position.distanceToSquared(position) <
            closestNode.position.distanceToSquared(position)
                ? node
                : closestNode
        );

        const isInsideSelectionRadius =
            closest.position.distanceToSquared(position) <=
            this.selectionRadius * this.selectionRadius;

        return isInsideSelectionRadius ? closest : null;

    }

    findShortestPath(startId, destinationId, {
        agent = null,
        avoidOccupied = true
    } = {}) {

        const result = this.findAllShortestPaths(startId, {
            agent,
            avoidOccupied
        });

        if (!result.distances.has(destinationId)) return null;

        const nodeIds = [];
        let currentId = destinationId;

        while (currentId !== null) {

            nodeIds.push(currentId);
            currentId = result.parents.get(currentId) ?? null;

        }

        return {
            nodeIds: nodeIds.reverse(),
            cost: result.distances.get(destinationId)
        };

    }

    findNearestAvailablePath(startId, agent = null) {

        const result = this.findAllShortestPaths(startId, {
            agent,
            avoidOccupied: true
        });
        const candidates = [...result.distances.keys()]
            .map(id => this.requireNode(id))
            .filter(node =>
                !node.blocked && this.isNodeAvailable(node.id, agent)
            );

        if (candidates.length === 0) return null;

        const destination = candidates.reduce((nearest, node) =>
            result.distances.get(node.id) < result.distances.get(nearest.id)
                ? node
                : nearest
        );

        return this.findShortestPath(startId, destination.id, {
            agent,
            avoidOccupied: true
        });

    }

    findAllShortestPaths(startId, {
        agent = null,
        avoidOccupied = true
    } = {}) {

        this.requireNode(startId);

        const distances = new Map([[startId, 0]]);
        const parents = new Map([[startId, null]]);
        const unvisited = new Set([startId]);

        while (unvisited.size > 0) {

            const currentId = [...unvisited].reduce((closestId, id) =>
                distances.get(id) < distances.get(closestId) ? id : closestId
            );

            unvisited.delete(currentId);

            const current = this.requireNode(currentId);

            for (const [neighborId, connection] of current.connections) {

                const neighbor = this.requireNode(neighborId);

                if (connection.blocked || neighbor.blocked) continue;
                if (!this.canAgentTraverseConnection(connection, agent)) {

                    continue;

                }

                if (
                    avoidOccupied &&
                    (
                        !this.isConnectionAvailable(
                            currentId,
                            neighborId,
                            agent
                        ) ||
                        !this.isNodeAvailable(neighbor.id, agent)
                    )
                ) continue;

                // Route cost is spatial: climbing is real distance even though
                // body rotation and crowd circles remain projected onto XZ.
                const cost = distances.get(currentId) +
                    current.position.distanceTo(neighbor.position);

                if (cost >= (distances.get(neighborId) ?? Infinity)) continue;

                distances.set(neighborId, cost);
                parents.set(neighborId, currentId);
                unvisited.add(neighborId);

            }

        }

        return { distances, parents };

    }

    findFirstUnavailableResource(nodeIds, agent) {

        for (let index = 0; index < nodeIds.length - 1; index++) {

            const fromId = nodeIds[index];
            const toId = nodeIds[index + 1];

            if (!this.isConnectionAvailable(fromId, toId, agent)) {

                return {
                    index,
                    resource: { type: "connection", fromId, toId }
                };

            }

            if (!this.isNodeAvailable(toId, agent)) {

                return {
                    index,
                    resource: { type: "node", id: toId }
                };

            }

        }

        return null;

    }

    getPlanarDistanceSquared(first, second) {

        const deltaX = first.x - second.x;
        const deltaZ = first.z - second.z;

        return deltaX * deltaX + deltaZ * deltaZ;

    }

    canAgentTraverseConnection(connection, agent = null) {

        if (!agent) return true;

        const capabilities = agent.navigationCapabilities ?? {};
        const traversal = connection.metadata.traversal ?? "flat";

        if (traversal === "stairs" && capabilities.stairs === false) {

            return false;

        }

        if (traversal === "slope" &&
            Number.isFinite(capabilities.maxSlope) &&
            connection.metadata.slopeAngle > capabilities.maxSlope) {

            return false;

        }

        return true;

    }

    // -----------------------------
    // Waypoints
    // -----------------------------

    createWaypoints(nodeIds) {

        return this.getPathNodes(nodeIds).map(node => ({
            id: node.id,
            position: node.position.clone(),
            metadata: { ...node.metadata }
        }));

    }

    getPathNodes(nodeIds) {

        const nodes = nodeIds.map(id => this.requireNode(id));

        for (let index = 0; index < nodes.length - 1; index++) {

            const current = nodes[index];
            const next = nodes[index + 1];

            if (!current.connections.has(next.id) ||
                current.connections.get(next.id).blocked ||
                next.blocked) {

                throw new Error(
                    `NavigationGraph route "${current.id}" -> "${next.id}" is blocked.`
                );

            }

        }

        return nodes;

    }

}
