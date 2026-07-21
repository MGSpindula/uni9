import {
    EntityState
} from "../core/EntityState";

export class NPCController {

    constructor({
        npc,
        navigationSystem,
        interactionBehavior,
        closedLoops = [],
        closedLoopChance = 0.65
    }) {

        this.npc = npc;

        this.navigationSystem =
            navigationSystem;

        this.interactionBehavior =
            interactionBehavior;

        this.closedLoops = closedLoops.map(loop => ({
            ...loop,
            nodeIds: [...loop.nodeIds]
        }));
        this.closedLoopChance = closedLoopChance;
        this.activeClosedLoop = null;
        this.skipClosedLoopOnce = false;
        this.state = "idle";

        this.elapsed = 0;
        this.decisionElapsed = 0;
        this.nearDecisionInterval = 0.2 +
            (this.hashName(npc.name) % 300) / 1000;
        this.offscreenDecisionInterval = 2;

        this.interactionDuration = 5;
        this.retryDuration = 2;

        this.nextDecisionIn = 0;

    }

    update(delta, { visible = true, distance = 0 } = {}) {

        // Behavioral time advances even while navigation owns the actor. This
        // keeps cooldowns and recent-memory decay independent from locomotion,
        // queues and interaction animation duration.
        this.interactionBehavior.update?.(this.npc, delta);

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

        this.elapsed += delta;

        const activePoint =
            this.navigationSystem
                .getOccupiedInteractionPoint(
                    this.npc
                );

        if (activePoint) {

            this.state = `interaction: ${activePoint.id}`;

            if (
                this.elapsed <
                this.interactionDuration
            ) {

                return;

            }

            this.elapsed = 0;

            this.tryChooseActivity({
                excludePoint:
                    activePoint
            });

            return;

        }

        this.decisionElapsed += delta;
        const cadence = !visible
            ? this.offscreenDecisionInterval
            : distance <= 18
                ? this.nearDecisionInterval
                : 1;
        const requiredDelay = Math.max(cadence, this.nextDecisionIn);

        if (this.decisionElapsed < requiredDelay) {

            return;

        }

        this.elapsed = 0;
        this.decisionElapsed = 0;
        this.nextDecisionIn = 0;

        if (!visible) this.state = "offscreen background decision";

        this.tryChooseActivity();

    }

    hashName(name) {

        let hash = 0;

        for (let index = 0; index < name.length; index++) {
            hash = (Math.imul(hash, 31) + name.charCodeAt(index)) >>> 0;
        }

        return hash;

    }

    tryChooseActivity({ excludePoint = null } = {}) {

        const mayChooseLoop = !this.skipClosedLoopOnce &&
            Math.random() < this.closedLoopChance;

        // After finishing a stroll, deliberately choose a different activity
        // once. This prevents a 100% loop chance from trapping an NPC in the
        // same circuit forever and demonstrates the clean handoff to behavior.
        this.skipClosedLoopOnce = false;

        if (mayChooseLoop && this.tryChooseClosedLoop()) return true;

        return this.tryChooseInteraction({ excludePoint });

    }

    tryChooseClosedLoop() {

        const candidates = [...this.closedLoops];

        if (candidates.length === 0) return false;

        // CharacterNavigationSystem chooses a reachable, non-action entry.
        // The controller only chooses which authored stroll it would like to
        // perform; it does not need to already stand on that circuit.
        const loop = candidates[
            Math.floor(Math.random() * candidates.length)
        ];
        const laps = Math.random() < 0.5 ? 1 : 2;
        const accepted = this.navigationSystem.startClosedLoop(
            this.npc,
            loop.nodeIds,
            {
                id: loop.id,
                laps,
                onLap: ({ completed, total }) => {

                    this.state = `closed loop ${completed}/${total}`;

                },
                onComplete: () => {

                    this.activeClosedLoop = null;
                    this.skipClosedLoopOnce = true;
                    this.elapsed = 0;
                    this.nextDecisionIn = 0;
                    this.state = "choosing new objective";

                },
                onCancelled: () => {

                    this.activeClosedLoop = null;
                    this.skipClosedLoopOnce = true;
                    this.elapsed = 0;
                    this.nextDecisionIn = this.retryDuration;
                    this.state = "loop cancelled";

                }
            }
        );

        if (!accepted) return false;

        this.activeClosedLoop = loop;
        this.state = `closed loop 0/${laps}`;
        this.nextDecisionIn = 0;
        return true;

    }

    tryChooseInteraction({
        excludePoint = null
    } = {}) {

        const accepted =
            this.interactionBehavior
                .tryStart(
                    this.npc,
                    {
                        excludePoint
                    }
                );

        this.nextDecisionIn =
            accepted
                ? 0
                : this.retryDuration;

        this.state = accepted
            ? "interaction route"
            : "retrying activity";

        return accepted;

    }

}
