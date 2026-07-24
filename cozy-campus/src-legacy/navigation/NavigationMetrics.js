export class NavigationMetrics {

    constructor() {

        this.counters = {
            routesCalculated: 0,
            routeRecoveries: 0,
            routeGeometryBuilds: 0,
            routeSegmentsCreated: 0,
            trafficTimeouts: 0,
            cancellations: 0,
            nodeEvacuations: 0
        };
        this.timings = {
            routeGeometryMilliseconds: 0
        };

    }

    increment(name, amount = 1) {

        if (!(name in this.counters)) this.counters[name] = 0;
        this.counters[name] += amount;

    }

    recordTime(name, milliseconds) {
        if (!(name in this.timings)) this.timings[name] = 0;
        this.timings[name] += milliseconds;
    }

    snapshot({ agents, trafficState, connector, traffic, physics }) {

        let activeReservations = 0;

        for (const state of trafficState.nodeStates.values()) {
            activeReservations += state.reservations.size;
            activeReservations += state.transitReservations.size;
        }

        for (const state of trafficState.connectionStates.values()) {
            for (const lane of state.lanes) {
                activeReservations += lane.reservations.size;
            }
        }

        for (const point of connector.points.values()) {
            activeReservations += point.reservations.size;
        }

        return {
            ...this.counters,
            ...this.timings,
            waitingActors: [...agents.values()].filter(agent =>
                agent.actor.isState?.("waiting") ||
                traffic.waitReasons.has(agent.actor)
            ).length,
            activeReservations,
            departureQueues: traffic.departures.queues.size,
            arrivalQueues: traffic.arrivals.queues.size,
            physicsCorrections: physics.metrics.corrections,
            physicsMaximumCorrection: physics.metrics.maximumCorrection
        };

    }

}
