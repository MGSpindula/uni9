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
        this.chairRetryDuration = 5;
        this.chairRetryRemaining = 0;
        this.chairUnavailableRevision = null;

    }

    // -----------------------------
    // Internal decision source
    // -----------------------------

    update(delta) {

        if (this.chairUnavailableRevision !== null &&
            this.chairUnavailableRevision !== this.graph.revision) {

            // A topology edit may have restored access to the chair.
            this.chairUnavailableRevision = null;
            this.chairRetryRemaining = 0;

        }

        this.chairRetryRemaining = Math.max(
            0,
            this.chairRetryRemaining - delta
        );

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

        // A previously accepted chair route may become structurally blocked.
        // Navigation abandons it after its timeout; the NPC then resumes its
        // normal routine instead of requesting the same chair forever.
        if (this.state === "moving-to-chair") {

            this.state = "idle";
            this.elapsed = 0;
            this.chairRetryRemaining = this.chairRetryDuration;
            this.chairUnavailableRevision = this.graph.revision;
            console.log(
                `[NPC] ${this.npc.name} abandons the chair until ` +
                `navigation topology changes.`
            );
            this.moveToRandomNode();
            return;

        }

        this.elapsed += delta;

        if (this.elapsed < this.idleDuration) return;

        this.elapsed = 0;

        const mayRetryChair =
            this.chairUnavailableRevision === null &&
            this.chairRetryRemaining <= 0;

        if (mayRetryChair && this.tryUseChair()) return;

        this.moveToRandomNode();

    }

    tryUseChair() {

        if (!this.chair.canInteract()) return false;

        const accepted = this.interactionSystem.request({
            actor: this.npc,
            target: this.chair,
            ...this.chair.createUseRequest()
        });

        if (accepted) {

            this.state = "moving-to-chair";
            this.chairUnavailableRevision = null;

        } else {

            this.chairRetryRemaining = this.chairRetryDuration;
            this.chairUnavailableRevision = this.graph.revision;
            console.log(
                `[NPC] ${this.npc.name} postpones the chair until ` +
                `navigation topology changes.`
            );

        }

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
