import { DwellSpot } from "./DwellSpot";

export class DwellSpotRegistry {

    constructor(graph) {

        this.graph = graph;
        this.spots = new Map();

    }

    add(id, nodeId, options = {}) {

        if (this.spots.has(id) || !this.graph.hasNode(nodeId)) return null;

        const spot = new DwellSpot(id, nodeId, options);

        this.spots.set(id, spot);
        return spot;

    }

    findNearestAvailable(nodeId, actor) {

        return [...this.spots.values()]
            .filter(spot => spot.isAvailable(actor))
            .map(spot => ({
                spot,
                path: this.graph.findShortestPath(nodeId, spot.nodeId, {
                    agent: actor,
                    avoidOccupied: false
                })
            }))
            .filter(candidate => candidate.path)
            .sort((first, second) =>
                first.path.cost - second.path.cost ||
                first.spot.position.distanceToSquared(
                    this.graph.requireNode(first.spot.nodeId).position
                ) -
                second.spot.position.distanceToSquared(
                    this.graph.requireNode(second.spot.nodeId).position
                )
            )[0] ?? null;

    }

    findAvailableAtNode(nodeId, actor) {

        return [...this.spots.values()]
            .filter(spot =>
                spot.nodeId === nodeId && spot.isAvailable(actor)
            )
            .sort((first, second) =>
                first.position.distanceToSquared(
                    this.graph.requireNode(nodeId).position
                ) -
                second.position.distanceToSquared(
                    this.graph.requireNode(nodeId).position
                )
            )[0] ?? null;

    }

    reserve(spot, actor) {

        if (!spot?.isAvailable(actor)) return false;

        spot.reservedBy = actor;
        return true;

    }

    occupy(spot, actor) {

        if (!spot?.isAvailable(actor)) return false;

        spot.reservedBy = null;
        spot.occupant = actor;
        return true;

    }

    releaseReservations(actor) {

        for (const spot of this.spots.values()) {

            if (spot.reservedBy === actor) spot.reservedBy = null;

        }

    }

    releaseOccupancy(actor) {

        for (const spot of this.spots.values()) {

            if (spot.occupant === actor) spot.occupant = null;

        }

    }

    releaseActor(actor) {

        this.releaseReservations(actor);
        this.releaseOccupancy(actor);

    }

}
