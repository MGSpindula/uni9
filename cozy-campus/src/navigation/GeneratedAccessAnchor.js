export class GeneratedAccessAnchor {

    constructor(id) {

        this.id = id;
        this.nodeIds = [];
        this.amount = 0;
        this.center = null;
        this.lanePositions = [];
        this.occupants = new Set();
        this.reservations = new Set();

    }

    update({ nodeIds, amount, center, lanePositions }) {

        this.nodeIds = [...nodeIds];
        this.amount = amount;
        this.center = center.clone();
        this.lanePositions = lanePositions.map(position => position.clone());

        return this;

    }

    getClosestLanePosition(position) {

        if (this.lanePositions.length === 0) return this.center.clone();

        return this.lanePositions.reduce((closest, candidate) =>
            candidate.distanceToSquared(position) <
            closest.distanceToSquared(position)
                ? candidate
                : closest
        ).clone();

    }

}
