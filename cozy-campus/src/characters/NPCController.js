import { EntityState } from "../core/EntityState";

export class NPCController {

    constructor({ npc, chair, graph, navigationSystem, interactionSystem }) {

        this.npc = npc;
        this.chair = chair;
        this.graph = graph;
        this.navigationSystem = navigationSystem;
        this.interactionSystem = interactionSystem;

        this.state = "idle";
        this.elapsed = 0;
        this.idleDuration = 1.5;
        this.sittingDuration = 5;

    }

    // -----------------------------
    // Internal decision source
    // -----------------------------

    update(delta) {

        if (this.chair.isInteractingWith(this.npc)) {

            this.state = "sitting";
            this.elapsed += delta;

            if (this.elapsed >= this.sittingDuration) {

                this.elapsed = 0;
                this.moveToRandomNode();

            }

            return;

        }

        if (this.npc.isState(EntityState.WALKING) ||
            this.npc.isState(EntityState.WAITING) ||
            this.npc.isState(EntityState.STOPPING)) return;

        this.elapsed += delta;

        if (this.elapsed < this.idleDuration) return;

        this.elapsed = 0;

        if (this.tryUseChair()) return;

        this.moveToRandomNode();

    }

    tryUseChair() {

        if (!this.chair.canInteract()) return false;

        const accepted = this.interactionSystem.request({
            actor: this.npc,
            target: this.chair,
            ...this.chair.createUseRequest()
        });

        if (accepted) this.state = "moving-to-chair";

        return accepted;

    }

    moveToRandomNode() {

        const currentNodeId =
            this.npc.navigation.getTraversalState().currentNodeId;
        const candidates = [...this.graph.nodes.values()]
            .filter(node =>
                node.id !== currentNodeId &&
                !node.blocked &&
                this.graph.isNodeAvailable(node.id, this.npc)
            );

        if (candidates.length === 0) {

            this.state = "idle";
            return false;

        }

        const node = candidates[
            Math.floor(Math.random() * candidates.length)
        ];
        const accepted = this.navigationSystem.moveToClosestNode(
            this.npc,
            node.position
        );

        this.state = accepted ? "roaming" : "idle";

        return accepted;

    }

}
