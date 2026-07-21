// Runtime ownership for navigation resources.
//
// NavigationGraph describes what exists. This class describes who is using
// it right now. Keeping actor references here lets the same graph be loaded,
// validated and path-found without creating a single Character.
export class NavigationTrafficState {

    constructor(graph) {

        this.graph = graph;
        this.nodeStates = new Map();
        this.connectionStates = new Map();

    }

    getNodeState(id) {

        this.graph.requireNode(id);

        if (!this.nodeStates.has(id)) {

            this.nodeStates.set(id, {
                occupants: new Set(),
                reservations: new Set(),
                transitReservations: new Set(),
                restingAgents: new Set()
            });

        }

        return this.nodeStates.get(id);

    }

    getConnectionState(fromId, toId) {

        const connection = this.graph.requireConnection(fromId, toId);

        if (!this.connectionStates.has(connection)) {

            this.connectionStates.set(connection, {
                occupants: new Set(),
                reservations: new Set(),
                lanes: Array.from(
                    { length: connection.laneCount },
                    (_, index) => ({
                        index,
                        occupants: new Set(),
                        reservations: new Set(),
                        directions: new Map()
                    })
                )
            });

        }

        return this.connectionStates.get(connection);

    }

    isNodeAvailable(id, agent = null) {

        const node = this.graph.requireNode(id);
        const state = this.getNodeState(id);

        if (node.blocked) return false;

        for (const occupant of state.occupants) {

            if (occupant !== agent && !state.restingAgents.has(occupant)) {
                return false;
            }

        }

        for (const reservation of state.reservations) {
            if (reservation !== agent) return false;
        }
        for (const reservation of state.transitReservations) {
            if (reservation !== agent) return false;
        }

        if (!node.exclusive) return true;

        return this.isResourceAvailable(node, state, agent);

    }

    isNodePassable(id) {

        const node = this.graph.requireNode(id);
        const state = this.getNodeState(id);

        if (node.blocked) return false;

        for (const occupant of state.occupants) {
            if (!state.restingAgents.has(occupant)) return false;
        }

        if (state.reservations.size > 0) return false;

        return !node.exclusive || state.occupants.size === 0;

    }

    isNodePhysicallyAvailable(id, agent = null) {

        const node = this.graph.requireNode(id);
        const state = this.getNodeState(id);

        if (node.blocked) return false;

        return ![...state.occupants].some(candidate =>
            candidate !== agent && !state.restingAgents.has(candidate)
        );

    }

    isConnectionAvailable(fromId, toId, agent = null) {

        return this.findAvailableLaneIndex(fromId, toId, agent) !== null;

    }

    isResourceAvailable(resource, state, agent = null) {

        if (resource.blocked) return false;

        const users = new Set([
            ...state.occupants,
            ...state.reservations
        ]);

        if (agent) users.delete(agent);

        return users.size < resource.capacity;

    }

    reserveNode(id, agent) {

        if (!this.isNodeAvailable(id, agent)) return false;

        const node = this.graph.requireNode(id);
        const state = this.getNodeState(id);

        return this.reserveResource(node, state, agent);

    }

    reserveNodeForTransit(id, agent) {

        const node = this.graph.requireNode(id);
        const state = this.getNodeState(id);

        if (node.blocked) return false;
        if ([...state.reservations].some(candidate => candidate !== agent)) {
            return false;
        }
        if ([...state.occupants].some(candidate =>
            candidate !== agent && !state.restingAgents.has(candidate)
        )) return false;
        if ([...state.transitReservations].some(candidate =>
            candidate !== agent
        )) return false;

        if (node.exclusive) return this.reserveNode(id, agent);

        state.transitReservations.add(agent);
        return true;

    }

    reserveConnectionLane(fromId, toId, agent) {

        const laneIndex = this.findAvailableLaneIndex(fromId, toId, agent);

        if (laneIndex === null) return null;

        return this.reserveSpecificConnectionLane(
            fromId,
            toId,
            laneIndex,
            agent
        );

    }

    reserveSpecificConnectionLane(fromId, toId, laneIndex, agent) {

        const connection = this.graph.requireConnection(fromId, toId);
        const state = this.getConnectionState(fromId, toId);
        const existingLane = state.lanes.find(lane =>
            lane.reservations.has(agent) || lane.occupants.has(agent)
        );

        if (existingLane) {
            return existingLane.index === laneIndex ? laneIndex : null;
        }

        const lane = state.lanes[laneIndex];
        if (!lane || connection.blocked) return null;

        const users = new Set([
            ...lane.occupants,
            ...lane.reservations
        ]);
        users.delete(agent);

        if (users.size > 0) return null;

        lane.reservations.add(agent);
        lane.directions.set(agent, { fromId, toId });
        state.reservations.add(agent);

        return laneIndex;

    }

    reserveNodeEvacuationLane(fromId, toId, agent) {

        const connection = this.graph.requireConnection(fromId, toId);
        const state = this.getConnectionState(fromId, toId);

        if (connection.blocked) return null;

        const normalLaneIndex = connection.fromId === fromId ? 0 : 1;
        const oppositeLaneIndex = normalLaneIndex === 0 ? 1 : 0;

        for (const laneIndex of [oppositeLaneIndex, normalLaneIndex]) {

            const lane = state.lanes[laneIndex];
            const otherOccupants = [...lane.occupants]
                .filter(candidate => candidate !== agent);

            if (otherOccupants.length > 0) continue;

            const displaced = [...lane.reservations]
                .filter(candidate => candidate !== agent);

            for (const candidate of displaced) {
                lane.reservations.delete(candidate);
                lane.directions.delete(candidate);
                state.reservations.delete(candidate);
            }

            lane.reservations.add(agent);
            lane.directions.set(agent, { fromId, toId });
            state.reservations.add(agent);

            return {
                laneIndex,
                displaced,
                usedOppositeLane: laneIndex === oppositeLaneIndex
            };

        }

        return null;

    }

    findAvailableLaneIndex(fromId, toId, agent = null) {

        const connection = this.graph.requireConnection(fromId, toId);
        const state = this.getConnectionState(fromId, toId);

        if (connection.blocked) return null;

        const preferredIndex = connection.fromId === fromId ? 0 : 1;
        const order = [
            preferredIndex,
            ...state.lanes
                .map(lane => lane.index)
                .filter(index => index !== preferredIndex)
        ];

        for (const index of order) {

            const lane = state.lanes[index];
            const users = new Set([
                ...lane.occupants,
                ...lane.reservations
            ]);

            if (agent) users.delete(agent);
            if (users.size === 0) return index;

        }

        return null;

    }

    getConnectionLaneIndex(fromId, toId, agent) {

        const state = this.getConnectionState(fromId, toId);
        const lane = state.lanes.find(candidate =>
            candidate.reservations.has(agent) ||
            candidate.occupants.has(agent)
        );

        return lane?.index ?? null;

    }

    occupyNode(id, agent) {

        const node = this.graph.requireNode(id);
        const state = this.getNodeState(id);
        const occupied = this.occupyResource(node, state, agent);

        if (occupied) {
            state.transitReservations.delete(agent);
            state.restingAgents.delete(agent);
        }

        return occupied;

    }

    occupyConnectionLane(fromId, toId, agent, laneIndex) {

        const state = this.getConnectionState(fromId, toId);
        const lane = state.lanes[laneIndex];

        if (!lane) return false;

        lane.reservations.delete(agent);
        lane.occupants.add(agent);
        state.reservations.delete(agent);
        state.occupants.add(agent);
        return true;

    }

    occupyResource(resource, state, agent) {

        if (!this.isResourceAvailable(resource, state, agent)) return false;

        state.reservations.delete(agent);
        state.occupants.add(agent);
        return true;

    }

    reserveResource(resource, state, agent) {

        if (!this.isResourceAvailable(resource, state, agent)) return false;

        state.reservations.add(agent);
        return true;

    }

    setNodeAgentResting(id, agent, resting = true) {

        const state = this.getNodeState(id);

        if (!state.occupants.has(agent)) return false;

        if (resting) state.restingAgents.add(agent);
        else state.restingAgents.delete(agent);

        return true;

    }

    yieldTransitReservationsToArrival(id, agent) {

        const state = this.getNodeState(id);
        const displaced = [...state.transitReservations]
            .filter(candidate => candidate !== agent);

        for (const candidate of displaced) {
            state.transitReservations.delete(candidate);
        }

        return displaced;

    }

    releaseNode(id, agent) {

        const state = this.getNodeState(id);

        state.restingAgents.delete(agent);
        state.transitReservations.delete(agent);
        this.releaseResource(state, agent);

    }

    releaseConnection(fromId, toId, agent) {

        const state = this.getConnectionState(fromId, toId);

        for (const lane of state.lanes) {
            lane.occupants.delete(agent);
            lane.reservations.delete(agent);
            lane.directions.delete(agent);
        }

        this.releaseResource(state, agent);

    }

    releaseResource(state, agent) {

        state.occupants.delete(agent);
        state.reservations.delete(agent);

    }

    releaseReservations(agent) {

        for (const state of this.nodeStates.values()) {
            state.reservations.delete(agent);
            state.transitReservations.delete(agent);
        }

        for (const state of this.connectionStates.values()) {
            state.reservations.delete(agent);

            for (const lane of state.lanes) {
                lane.reservations.delete(agent);
                lane.directions.delete(agent);
            }
        }

    }

    releaseAgent(agent) {

        for (const state of this.nodeStates.values()) {
            state.restingAgents.delete(agent);
            state.transitReservations.delete(agent);
            this.releaseResource(state, agent);
        }

        for (const state of this.connectionStates.values()) {
            for (const lane of state.lanes) {
                lane.occupants.delete(agent);
                lane.reservations.delete(agent);
                lane.directions.delete(agent);
            }

            this.releaseResource(state, agent);
        }

    }

}
