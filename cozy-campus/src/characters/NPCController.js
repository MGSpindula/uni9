import { EntityState } from "../core/EntityState";

export class NPCController {

    constructor({
        npc,
        graph,
        navigationSystem,
        interactionBehavior
    }) {

        this.npc = npc;
        this.graph = graph;
        this.navigationSystem =
            navigationSystem;

        this.interactionBehavior =
            interactionBehavior;

        this.state = "idle";
        this.elapsed = 0;

        this.idleDuration = 1.5;
        this.interactionDuration = 5;

        this.interactionRetryDuration = 5;
        this.interactionRetryRemaining = 0;

    }

    // -----------------------------
    // Internal decision source
    // -----------------------------

    update(delta) {

        this.interactionRetryRemaining =
            Math.max(
                0,
                this.interactionRetryRemaining -
                delta
            );

        if (
            this.interactionBehavior
                .isActive(this.npc)
        ) {

            this.updateActiveInteraction(
                delta
            );

            return;

        }

        if (
            this.npc.isState(
                EntityState.WALKING
            ) ||
            this.npc.isState(
                EntityState.WAITING
            ) ||
            this.npc.isState(
                EntityState.STOPPING
            )
        ) {

            return;

        }

        if (
            this.state ===
            "moving-to-interaction"
        ) {

            this.handleAbandonedInteraction();
            return;

        }

        this.elapsed += delta;

        if (
            this.elapsed <
            this.idleDuration
        ) {

            return;

        }

        this.elapsed = 0;

        if (
            this.mayRetryInteraction() &&
            this.tryUseInteraction()
        ) {

            return;

        }

        this.moveToRandomNode();

    }

    // -----------------------------
    // Interaction behavior
    // -----------------------------

    updateActiveInteraction(delta) {

        this.state = "interacting";
        this.elapsed += delta;

        if (
            this.elapsed <
            this.interactionDuration
        ) {

            return;

        }

        this.elapsed = 0;

        // CharacterNavigationSystem sees the active interaction
        // and performs its normal exit before following the new route.
        this.moveToRandomNode();

    }

    mayRetryInteraction() {

        return (
            this.interactionRetryRemaining <= 0
        );

    }

    tryUseInteraction() {

        const accepted =
            this.interactionBehavior
                .tryStart(this.npc);

        if (accepted) {

            this.state =
                "moving-to-interaction";

            return true;

        }

        this.postponeInteraction();

        return false;

    }

    postponeInteraction() {

        this.interactionRetryRemaining =
            this.interactionRetryDuration;

        this.unavailableTopologyRevision =
            null;

        console.log(
            `[NPC] ${this.npc.name} postpones ` +
            `its interaction for ` +
            `${this.interactionRetryDuration} seconds.`
        );

    }

    handleAbandonedInteraction() {

        this.state = "idle";
        this.elapsed = 0;

        this.interactionRetryRemaining =
            this.interactionRetryDuration;

        this.unavailableTopologyRevision =
            null;

        console.log(
            `[NPC] ${this.npc.name} abandons ` +
            `its current interaction attempt and ` +
            `will search again later.`
        );

        this.moveToRandomNode();

    }

    // -----------------------------
    // Roaming
    // -----------------------------

    moveToRandomNode() {

        const currentNodeId =
            this.npc.navigation
                .getTraversalState()
                .currentNodeId;

        const candidates = [
            ...this.graph.nodes.values()
        ].filter(node =>
            node.id !== currentNodeId &&
            !node.blocked &&
            this.graph.isNodeAvailable(
                node.id,
                this.npc
            )
        );

        if (candidates.length === 0) {

            this.state = "idle";
            return false;

        }

        const node =
            candidates[
            Math.floor(
                Math.random() *
                candidates.length
            )
            ];

        const accepted =
            this.navigationSystem
                .moveToClosestNode(
                    this.npc,
                    node.position
                );

        this.state =
            accepted
                ? "roaming"
                : "idle";

        return accepted;

    }

}