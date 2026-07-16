import { AnimationPresets } from "../core/AnimationPresets";
import { Tween } from "../core/Tween";

export class NavigationTrafficSystem {

    constructor(owner) {

        this.owner = owner;
        this.graph = owner.graph;
        this.activeEncounters = [];

    }

    // -----------------------------
    // Connection entry
    // -----------------------------

    tryStartConnection(actor, fromId, toId) {

        const context = this.owner.requireContext(actor);
        const laneIndex = this.graph.reserveConnectionLane(
            fromId,
            toId,
            actor
        );

        if (laneIndex === null) return false;

        this.owner.requestImmediateNodeClearance(toId, actor);

        if (!this.graph.reserveNode(toId, actor)) {

            const reciprocal = this.graph.hasReciprocalLaneReservation(
                fromId,
                toId,
                actor
            );

            if (!reciprocal) {

                const connection = this.graph.requireConnection(fromId, toId);

                // Keep a reservation only as a reciprocal multi-lane intent.
                if (!connection.passingAllowed ||
                    connection.lanes.length < 2) {

                    this.graph.releaseConnection(fromId, toId, actor);

                }

                return false;

            }

        }

        this.owner.centerActorForDeparture(context);
        this.graph.occupyConnectionLane(fromId, toId, actor, laneIndex);
        this.graph.releaseNode(fromId, actor);
        this.owner.refresh();

        return true;

    }

    tryEnterFromInteraction(actor, { fromId, toId }) {

        if (actor.navigation.getTraversalState().currentConnection) return true;

        const laneIndex = this.graph.reserveConnectionLane(
            fromId,
            toId,
            actor
        );

        if (laneIndex === null) return false;

        if (!this.graph.reserveNode(toId, actor)) {

            this.graph.releaseConnection(fromId, toId, actor);
            return false;

        }

        this.graph.occupyConnectionLane(fromId, toId, actor, laneIndex);
        actor.navigation.beginConnection(fromId, toId);
        this.owner.centerActorForDeparture(this.owner.requireContext(actor));
        this.owner.refresh();

        return true;

    }

    // -----------------------------
    // Encounter presentation
    // -----------------------------

    update() {

        const observedPairs = this.collectOpposingPairs();

        for (const pair of observedPairs) {

            const existing = this.activeEncounters.find(encounter =>
                encounter.connection === pair.connection &&
                encounter.first === pair.first.actor &&
                encounter.second === pair.second.actor
            );
            const distance = this.getPlanarDistance(
                pair.first.actor,
                pair.second.actor
            );
            const crossed = this.haveCrossed(pair);

            if (!existing && !crossed && distance <= 2.5) {

                this.activeEncounters.push({
                    connection: pair.connection,
                    first: pair.first.actor,
                    second: pair.second.actor,
                    crossed: false
                });
                this.moveVisualToLane(pair.first);
                this.moveVisualToLane(pair.second);

            } else if (existing && crossed) {

                existing.crossed = true;

            }

        }

        this.activeEncounters = this.activeEncounters.filter(encounter => {

            const pair = observedPairs.find(candidate =>
                candidate.connection === encounter.connection &&
                candidate.first.actor === encounter.first &&
                candidate.second.actor === encounter.second
            );
            const finished = !pair || (
                encounter.crossed &&
                this.getPlanarDistance(
                    encounter.first,
                    encounter.second
                ) >= 1.2
            );

            if (finished) {

                this.moveVisualToCenter(encounter.first);
                this.moveVisualToCenter(encounter.second);

            }

            return !finished;

        });

    }

    collectOpposingPairs() {

        const pairs = [];
        for (const connection of this.graph.activeConnections) {

                const forward = [];
                const reverse = [];

                for (const lane of connection.lanes) {

                    for (const actor of lane.occupants) {

                        const direction = lane.directions.get(actor);
                        const entry = { actor, laneIndex: lane.index, direction };

                        if (direction?.fromId === connection.fromId) {

                            forward.push(entry);

                        } else if (direction) {

                            reverse.push(entry);

                        }

                    }

                }

                for (const first of forward) {

                    for (const second of reverse) {

                        pairs.push({ connection, first, second });

                    }

                }

        }

        return pairs;

    }

    moveVisualToLane({ actor, direction, laneIndex }) {

        if (!actor.visual) return;

        AnimationPresets.to(actor, {
            object: actor.visual.position,
            property: "x",
            to: this.graph.getConnectionLaneOffset(
                direction.fromId,
                direction.toId,
                laneIndex
            ),
            duration: 0.25,
            easing: Tween.easeInOutQuad
        });

    }

    moveVisualToCenter(actor) {

        if (!actor.visual || Math.abs(actor.visual.position.x) <= 0.001) return;

        AnimationPresets.to(actor, {
            object: actor.visual.position,
            property: "x",
            to: 0,
            duration: 0.35,
            easing: Tween.easeInOutQuad
        });

    }

    haveCrossed({ connection, first, second }) {

        const from = this.graph.requireNode(connection.fromId).position;
        const to = this.graph.requireNode(connection.toId).position;
        const directionX = to.x - from.x;
        const directionZ = to.z - from.z;
        const progress = entry =>
            (entry.actor.object3D.position.x - from.x) * directionX +
            (entry.actor.object3D.position.z - from.z) * directionZ;

        return progress(first) >= progress(second);

    }

    getPlanarDistance(first, second) {

        return Math.hypot(
            first.object3D.position.x - second.object3D.position.x,
            first.object3D.position.z - second.object3D.position.z
        );

    }

    unregister(actor) {

        this.activeEncounters = this.activeEncounters.filter(encounter =>
            encounter.first !== actor && encounter.second !== actor
        );

    }

}
