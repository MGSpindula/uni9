import { EntityState } from "../core/EntityState";
import { NavigationPhase } from "./NavigationPhase";

// Estado de navegação pertencente a um único ator.
//
// A organização em domínios evita transformar cada nova situação em mais uma
// flag solta. Os aliases no fim da classe mantêm o código antigo funcionando
// durante a extração dos subsistemas; código novo deve preferir agent.intent,
// agent.traversal, agent.interaction, agent.wait e agent.recovery.
export class NavigationAgent {

    constructor(actor) {

        this.actor = actor;

        this.intent = {
            position: null,
            destinationId: null,
            interaction: null,
            deferredCommand: null,
            closedLoop: null
        };

        this.route = {
            departureContinuity: null
        };

        this.traversal = {
            interactionPoint: null,
            interactionExitPoint: null,
            laneCurve: false,
            interactionCurve: false,
            transitTangent: null,
            arrivalFromNodeId: null,
            kind: "flat"
        };

        this.interaction = {
            active: null,
            entering: false,
            leaving: false,
            exitCommitted: false,
            exitElapsed: 0
        };

        this.wait = {
            reason: null,
            retryElapsed: 0,
            blockedElapsed: null,
            blockedTimeout: 3,
            collisionElapsed: 0
        };

        this.recovery = {
            pending: false,
            elapsed: 0,
            timeout: actor.name === "Player" ? 8 : 3,
            position: actor.object3D.position.clone(),
            orphanedElapsed: 0
        };

        this.turnaround = {
            active: false,
            elapsed: 0,
            duration: 0.35
        };

        this.phase = NavigationPhase.IDLE;

    }

    // Recalcula uma única fase a partir dos domínios. A ordem é deliberada:
    // uma saída transacional, por exemplo, nunca pode ser mascarada por WAITING.
    syncPhase(waitReason = null) {

        this.wait.reason = waitReason;

        if (this.interaction.leaving || this.interaction.exitCommitted) {
            this.phase = NavigationPhase.LEAVING_INTERACTION;
        } else if (this.interaction.entering) {
            this.phase = NavigationPhase.ENTERING_INTERACTION;
        } else if (this.interaction.active) {
            this.phase = NavigationPhase.INTERACTING;
        } else if (this.recovery.pending) {
            this.phase = NavigationPhase.RECOVERING;
        } else if (this.actor.navigation.hasPath()) {
            this.phase = NavigationPhase.TRAVERSING;
        } else if (this.actor.isState(EntityState.WAITING) || waitReason) {
            this.phase = NavigationPhase.WAITING;
        } else if (
            this.intent.position ||
            this.intent.interaction ||
            this.intent.deferredCommand
        ) {
            this.phase = NavigationPhase.PLANNING;
        } else {
            this.phase = NavigationPhase.IDLE;
        }

        return this.phase;

    }

}

// Compatibilidade de migração. Cada nome antigo aponta para um campo canônico
// do NavigationAgent, portanto não cria uma segunda cópia do estado.
const aliases = {
    pendingPosition: ["intent", "position"],
    destinationId: ["intent", "destinationId"],
    pendingInteraction: ["intent", "interaction"],
    deferredCommand: ["intent", "deferredCommand"],
    closedLoop: ["intent", "closedLoop"],
    departureContinuity: ["route", "departureContinuity"],
    interactionPoint: ["traversal", "interactionPoint"],
    interactionExitPoint: ["traversal", "interactionExitPoint"],
    traversingLaneCurve: ["traversal", "laneCurve"],
    traversingInteractionCurve: ["traversal", "interactionCurve"],
    transitTangent: ["traversal", "transitTangent"],
    arrivalFromNodeId: ["traversal", "arrivalFromNodeId"],
    currentTraversal: ["traversal", "kind"],
    activeInteraction: ["interaction", "active"],
    preparingInteraction: ["interaction", "entering"],
    preparingInteractionExit: ["interaction", "leaving"],
    interactionExitCommitted: ["interaction", "exitCommitted"],
    interactionExitElapsed: ["interaction", "exitElapsed"],
    retryElapsed: ["wait", "retryElapsed"],
    blockedElapsed: ["wait", "blockedElapsed"],
    blockedTimeout: ["wait", "blockedTimeout"],
    collisionWaitElapsed: ["wait", "collisionElapsed"],
    recoveryPending: ["recovery", "pending"],
    recoveryElapsed: ["recovery", "elapsed"],
    recoveryTimeout: ["recovery", "timeout"],
    recoveryPosition: ["recovery", "position"],
    orphanedElapsed: ["recovery", "orphanedElapsed"],
    turningAround: ["turnaround", "active"],
    turnaroundElapsed: ["turnaround", "elapsed"],
    turnaroundDuration: ["turnaround", "duration"]
};

for (const [name, [domain, field]] of Object.entries(aliases)) {

    Object.defineProperty(NavigationAgent.prototype, name, {
        configurable: false,
        enumerable: false,
        get() {
            return this[domain][field];
        },
        set(value) {
            this[domain][field] = value;
        }
    });

}
