export class NavigationGraph {

    constructor({ selectionRadius = 1.25 } = {}) {

        this.nodes = new Map();
        this.selectionRadius = selectionRadius;
        this.invalidNodeIds = new Set();
        this.validationErrors = [];
        this.activeConnections = new Set();

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
            restingAgents: new Set(),
            idleAssignments: new Map(),
            metadata: { ...metadata },
            connections: new Map()
        };

        this.nodes.set(id, node);

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

        this.requireNode(id).position.copy(position);

    }

    setNodeBlocked(id, blocked = true) {

        this.requireNode(id).blocked = blocked;

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
        capacity = null,
        lanes = 1,
        laneWidth = 1,
        capacityPerLane = 1,
        passingAllowed = false
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
        const laneCount = Math.max(1, Math.floor(lanes));
        const resource = {
            fromId,
            toId,
            blocked: false,
            capacity: capacity ?? laneCount * capacityPerLane,
            laneWidth,
            capacityPerLane,
            passingAllowed,
            lanes: Array.from({ length: laneCount }, (_, index) => ({
                index,
                occupants: new Set(),
                reservations: new Set(),
                directions: new Map()
            })),
            occupants: new Set(),
            reservations: new Set(),
            metadata: { ...metadata }
        };

        from.connections.set(toId, resource);

        if (bidirectional) to.connections.set(fromId, resource);

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

        this.requireConnection(fromId, toId).blocked = blocked;

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

    isNodeExclusive(id) {

        return this.requireNode(id).exclusive;

    }

    isNodeOccupied(id, excludingAgent = null) {

        return this.hasOtherUsers(
            this.requireNode(id).occupants,
            excludingAgent
        );

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

    isConnectionOccupied(fromId, toId, excludingAgent = null) {

        return this.hasOtherUsers(
            this.requireConnection(fromId, toId).occupants,
            excludingAgent
        );

    }

    getConnectionOccupants(fromId, toId) {

        return [...this.requireConnection(fromId, toId).occupants];

    }

    hasOtherUsers(users, excludingAgent = null) {

        for (const user of users) {

            if (user !== excludingAgent) return true;

        }

        return false;

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

    reserveConnection(fromId, toId, agent) {

        return this.reserveConnectionLane(fromId, toId, agent) !== null;

    }

    reserveConnectionLane(fromId, toId, agent) {

        const connection = this.requireConnection(fromId, toId);
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

    findAvailableLaneIndex(connection, fromId, toId, agent = null) {

        if (connection.blocked) return null;

        const sameDirection = connection.fromId === fromId;
        const preferredIndex = connection.lanes.length === 1
            ? 0
            : sameDirection
                ? connection.lanes.length - 1
                : 0;
        const order = [preferredIndex];

        if (connection.passingAllowed) {

            for (const lane of connection.lanes) {

                if (!order.includes(lane.index)) order.push(lane.index);

            }

        }

        for (const index of order) {

            const lane = connection.lanes[index];
            const users = new Set([
                ...lane.occupants,
                ...lane.reservations
            ]);

            if (agent) users.delete(agent);

            if (users.size < connection.capacityPerLane) return index;

        }

        return null;

    }

    getConnectionLaneOffset(fromId, toId, laneIndex) {

        const connection = this.requireConnection(fromId, toId);
        const center = (connection.lanes.length - 1) / 2;
        const absoluteOffset = (laneIndex - center) * connection.laneWidth;
        const sameDirection = connection.fromId === fromId;

        // Returned in the Character visual's local x axis. Reversing traversal
        // reverses the world-space right vector, so the sign must reverse too.
        return sameDirection ? absoluteOffset : -absoluteOffset;

    }

    hasReciprocalLaneReservation(fromId, toId, agent) {

        const connection = this.requireConnection(fromId, toId);

        if (!connection.passingAllowed || connection.lanes.length < 2) {

            return false;

        }

        const destination = this.requireNode(toId);

        for (const occupant of destination.occupants) {

            if (occupant === agent) continue;

            for (const lane of connection.lanes) {

                const direction = lane.directions.get(occupant);

                if (direction?.fromId === toId &&
                    direction.toId === fromId) return true;

            }

        }

        return false;

    }

    getOpposingConnectionUsers(fromId, toId, agent = null) {

        const connection = this.requireConnection(fromId, toId);
        const users = [];

        for (const lane of connection.lanes) {

            for (const occupant of lane.occupants) {

                if (occupant === agent) continue;

                const direction = lane.directions.get(occupant);

                if (direction?.fromId === toId && direction.toId === fromId) {

                    users.push({
                        actor: occupant,
                        laneIndex: lane.index,
                        direction
                    });

                }

            }

        }

        return users;

    }

    reserveResource(resource, agent) {

        if (!this.isResourceAvailable(resource, agent)) return false;

        resource.reservations.add(agent);
        return true;

    }

    occupyNode(id, agent) {

        const node = this.requireNode(id);
        const occupied = this.occupyResource(node, agent);

        if (occupied) node.restingAgents.delete(agent);

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
        this.activeConnections.add(connection);

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
        node.idleAssignments.delete(agent);
        this.releaseResource(node, agent);

    }

    claimNodeIdleSlot(id, agent) {

        const node = this.requireNode(id);
        const existing = node.idleAssignments.get(agent);

        if (existing) return existing;

        const slots = this.createNodeIdleSlots(node);
        const occupiedIndices = new Set(
            [...node.idleAssignments.values()].map(slot => slot.index)
        );
        const slot = slots.find(candidate =>
            !occupiedIndices.has(candidate.index)
        ) ?? { index: -1, x: 0, z: 0 };

        node.idleAssignments.set(agent, slot);

        return slot;

    }

    setNodeAgentResting(id, agent, resting = true) {

        const node = this.requireNode(id);

        if (!node.occupants.has(agent)) return false;

        if (resting) node.restingAgents.add(agent);
        else node.restingAgents.delete(agent);

        return true;

    }

    createNodeIdleSlots(node) {

        // Two default characters have a combined diameter of 0.9. Keep a
        // small clearance so traffic on the centerline does not touch DWELL.
        const radius = node.metadata.idleRadius ?? 1.05;
        const clearance = node.metadata.pathClearance ?? 0.22;
        const count = node.metadata.idleSlotCount ?? 12;
        const slots = [];
        const fallback = [];

        for (let index = 0; index < count; index++) {

            const angle = (index / count) * Math.PI * 2;
            const slot = {
                index,
                x: Math.cos(angle) * radius,
                z: Math.sin(angle) * radius
            };

            fallback.push(slot);

            const crossesPath = [...node.connections.keys()].some(neighborId => {

                const neighbor = this.requireNode(neighborId);
                const directionX = neighbor.position.x - node.position.x;
                const directionZ = neighbor.position.z - node.position.z;
                const length = Math.hypot(directionX, directionZ) || 1;
                const distanceFromLine = Math.abs(
                    slot.x * directionZ - slot.z * directionX
                ) / length;
                const pointsTowardEdge =
                    slot.x * directionX + slot.z * directionZ > 0;

                return pointsTowardEdge && distanceFromLine < clearance;

            });

            if (!crossesPath) slots.push(slot);

        }

        return slots.length > 0 ? slots : fallback;

    }

    releaseConnection(fromId, toId, agent) {

        const connection = this.requireConnection(fromId, toId);

        for (const lane of connection.lanes) {

            lane.occupants.delete(agent);
            lane.reservations.delete(agent);
            lane.directions.delete(agent);

        }

        this.releaseResource(connection, agent);

        if (connection.occupants.size === 0) {

            this.activeConnections.delete(connection);

        }

    }

    releaseResource(resource, agent) {

        resource.occupants.delete(agent);
        resource.reservations.delete(agent);

    }

    releaseReservations(agent) {

        for (const node of this.nodes.values()) {

            node.reservations.delete(agent);

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
            node.idleAssignments.delete(agent);
            this.releaseResource(node, agent);

            for (const connection of node.connections.values()) {

                for (const lane of connection.lanes) {

                    lane.occupants.delete(agent);
                    lane.reservations.delete(agent);
                    lane.directions.delete(agent);

                }

                this.releaseResource(connection, agent);

                if (connection.occupants.size === 0) {

                    this.activeConnections.delete(connection);

                }

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
            // Keep the unavailable waypoint so traversal can reserve its lane
            // and wait before moving. Removing it prevents reciprocal lane
            // intentions from ever being observed.
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
            this.getPlanarDistanceSquared(node.position, position) <
            this.getPlanarDistanceSquared(closestNode.position, position)
                ? node
                : closestNode
        );

        const isInsideSelectionRadius =
            this.getPlanarDistanceSquared(closest.position, position) <=
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

                if (
                    avoidOccupied &&
                    (
                        !this.isResourceAvailable(connection, agent) ||
                        !this.isNodeAvailable(neighbor.id, agent)
                    )
                ) continue;

                const cost = distances.get(currentId) +
                    Math.sqrt(this.getPlanarDistanceSquared(
                        current.position,
                        neighbor.position
                    ));

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
