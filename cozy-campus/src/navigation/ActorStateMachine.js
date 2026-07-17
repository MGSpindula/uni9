// Explicit actor states - mutually exclusive
export const ActorState = {
    IDLE: "idle",              // Standing still, waiting for command
    MOVING: "moving",           // Following path to destination
    BLOCKED: "blocked",         // Collision detected, waiting for clearance
    RECOVERING: "recovering",   // Just unblocked, re-evaluating path
    INTERACTING: "interacting", // Engaged with object (sit, lean, operate)
    DWELLING: "dwelling"        // At dwell spot, taking a break
};

export class ActorStateMachine {

    constructor(actor) {
        this.actor = actor;
        this.currentState = ActorState.IDLE;
        this.previousState = null;
        this.stateChangeTime = 0;

        // State-specific data (only relevant for current state)
        // Consolidates the 23 scattered variables into focused data
        this.data = {
            destination: null,          // {nodeId, position, route}
            interactionPoint: null,     // {point, expectedPose, entity}
            dwellSpot: null,           // {spot, remainingTime}
            blockageStartTime: null,   // for timeout detection
            lastRecoveryAttempt: 0     // prevent spam
        };
    }

    /**
    * Transition to MOVING state
    */
    transitionToMoving(destination) {
        if (this.currentState === ActorState.MOVING &&
            this.data.destination?.destinationId === destination?.destinationId) {
            return;
        }

        this.previousState = this.currentState;
        this.currentState = ActorState.MOVING;
        this.stateChangeTime = Date.now();

        this.data.destination = destination;
        this.data.blockageStartTime = null;

        console.log(`[ActorStateMachine] ${this.actor.name} → MOVING (dest: ${destination?.nodeId})`);
    }

    /**
    * Transition to BLOCKED state (collision detected)
    */
    transitionToBlocked() {
        if (this.currentState !== ActorState.MOVING) return;

        this.previousState = this.currentState;
        this.currentState = ActorState.BLOCKED;
        this.stateChangeTime = Date.now();

        this.data.blockageStartTime = Date.now();

        console.log(`[ActorStateMachine] ${this.actor.name} → BLOCKED`);
    }
    /**
     * Transition to RECOVERING state (unblocked, re-evaluating)
     */
    transitionToRecovering() {
        if (this.currentState !== ActorState.BLOCKED) return;

        this.previousState = this.currentState;
        this.currentState = ActorState.RECOVERING;
        this.stateChangeTime = Date.now();

        this.data.lastRecoveryAttempt = Date.now();

        console.log(`[ActorStateMachine] ${this.actor.name} → RECOVERING`);
    }

    /**
     * Transition to INTERACTING state
     */
    transitionToInteracting(interactionPoint) {
        this.previousState = this.currentState;
        this.currentState = ActorState.INTERACTING;
        this.stateChangeTime = Date.now();

        this.data.interactionPoint = interactionPoint;
        this.data.destination = null;
        this.data.dwellSpot = null;

        console.log(`[ActorStateMachine] ${this.actor.name} → INTERACTING (${interactionPoint?.id})`);
    }
    /**
     * Transition to DWELLING state (at dwell spot)
     */
    transitionToDwelling(dwellSpot, duration) {
        this.previousState = this.currentState;
        this.currentState = ActorState.DWELLING;
        this.stateChangeTime = Date.now();

        this.data.dwellSpot = {
            ...dwellSpot,
            remainingTime: duration,
            startTime: Date.now()
        };
        this.data.destination = null;
        this.data.interactionPoint = null;

        console.log(`[ActorStateMachine] ${this.actor.name} → DWELLING (${dwellSpot?.id}, ${duration}s)`);
    }

    /**
     * Transition to IDLE state (clear all state data)
     */
    transitionToIdle() {
        this.previousState = this.currentState;
        this.currentState = ActorState.IDLE;
        this.stateChangeTime = Date.now();

        this.data = {
            destination: null,
            interactionPoint: null,
            dwellSpot: null,
            blockageStartTime: null,
            lastRecoveryAttempt: 0
        };

        console.log(`[ActorStateMachine] ${this.actor.name} → IDLE`);
    }

    // ========================
    // Query methods
    // ========================
    isMoving() { return this.currentState === ActorState.MOVING; }
    isBlocked() { return this.currentState === ActorState.BLOCKED; }
    isRecovering() { return this.currentState === ActorState.RECOVERING; }
    isInteracting() { return this.currentState === ActorState.INTERACTING; }
    isDwelling() { return this.currentState === ActorState.DWELLING; }
    isIdle() { return this.currentState === ActorState.IDLE; }

    isActive() {
        return this.currentState !== ActorState.IDLE;
    }
    getElapsedTime() {
        return (Date.now() - this.stateChangeTime) / 1000;
    }
    getBlockedElapsedTime() {
        if (!this.data.blockageStartTime) return 0;
        return (Date.now() - this.data.blockageStartTime) / 1000;
    }
    getDwellRemainingTime() {
        if (!this.data.dwellSpot) return 0;
        const elapsed = (Date.now() - this.data.dwellSpot.startTime) / 1000;
        return Math.max(0, this.data.dwellSpot.remainingTime - elapsed);
    }
    // ========================
    // Debug visualization
    // ========================
    getStateColor() {
        const colors = {
            [ActorState.IDLE]: 0x888888,
            [ActorState.MOVING]: 0x00ff00,
            [ActorState.BLOCKED]: 0xff0000,
            [ActorState.RECOVERING]: 0xffff00,
            [ActorState.INTERACTING]: 0x00ffff,
            [ActorState.DWELLING]: 0xff00ff
        };
        return colors[this.currentState] || 0xffffff;
    }
    toString() {
        const timeStr = this.getElapsedTime().toFixed(1);
        return `${this.currentState}(${timeStr}s)`;
    }
}
