// Runtime ownership for authored InteractionPoints.
// NavigationConnector describes graph access; this class describes who uses it.
export class InteractionTrafficState {

    constructor(connector, owner = null) {
        this.connector = connector;
        this.owner = owner;
        this.pointStates = new Map();

        for (const point of connector.points.values()) {
            this.registerPoint(point);
        }
    }

    registerPoint(point) {
        let state = this.pointStates.get(point);

        if (!state) {
            state = {
                occupants: new Set(),
                reservations: new Set()
            };
            this.pointStates.set(point, state);
        }
        point.trafficState = this;
        return state;
    }

    unregisterPoint(point) {
        this.pointStates.delete(point);
        if (point.trafficState === this) point.trafficState = null;
    }

    getPointState(point) {
        return this.pointStates.get(point) ?? this.registerPoint(point);
    }

    isPointAvailable(point, agent = null) {
        const state = this.getPointState(point);
        const users = new Set([...state.occupants, ...state.reservations]);
        if (agent) users.delete(agent);
        return point.accessible && users.size < point.capacity;
    }

    occupyPoint(point, agent) {
        if (!this.isPointAvailable(point, agent)) return false;
        const state = this.getPointState(point);
        state.reservations.delete(agent);
        state.occupants.add(agent);
        return true;
    }

    reservePoint(point, agent) {
        if (agent.navigationPassagePolicy === "absolute") {
            this.preparePriorityReservation(point, agent);
        }
        if (!this.isPointAvailable(point, agent)) return false;
        this.getPointState(point).reservations.add(agent);
        return true;
    }

    preparePriorityReservation(point, agent) {
        const state = this.getPointState(point);

        for (const candidate of [...state.reservations]) {
            if (candidate === agent ||
                candidate.navigationPassagePolicy === "absolute") continue;

            state.reservations.delete(candidate);
            candidate.onTrafficReservationYielded?.({
                by: agent,
                resourceType: "interaction",
                point
            });
        }

        const occupants = [...state.occupants].filter(candidate =>
            candidate !== agent &&
            candidate.navigationPassagePolicy !== "absolute"
        );

        if (occupants.length > 0) {
            this.owner?.requestPriorityPassage(agent, occupants, {
                resourceType: "interaction",
                point
            });
        }
    }

    reserveRoutePoints(route, agent) {
        const points = [...new Set(route.waypoints
            .map(waypoint => waypoint.interactionPoint)
            .filter(Boolean))];
        const reserved = [];

        for (const point of points) {
            if (!this.reservePoint(point, agent)) {
                for (const candidate of reserved) {
                    this.getPointState(candidate).reservations.delete(agent);
                }
                return false;
            }
            reserved.push(point);
        }
        return true;
    }

    releasePoint(point, agent) {
        const state = this.getPointState(point);
        state.occupants.delete(agent);
        state.reservations.delete(agent);
    }

    releaseAgent(agent) {
        for (const point of this.connector.points.values()) {
            this.releasePoint(point, agent);
        }
    }

    releaseReservations(agent) {
        for (const point of this.connector.points.values()) {
            this.getPointState(point).reservations.delete(agent);
        }
    }

    dispose() {
        for (const point of this.pointStates.keys()) {
            if (point.trafficState === this) point.trafficState = null;
        }
        this.pointStates.clear();
    }

}
