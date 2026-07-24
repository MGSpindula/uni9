import { Vector3 } from "three"

export const NavigationStatus = Object.freeze({
    IDLE: "idle",
    MOVING: "moving",
    PAUSED: "paused",
    SPECIAL_TRAVERSAL: "special-traversal",
    INTERACTING: "interacting",
    UNREACHABLE: "unreachable",
})

export const NavigationIntentPolicy = Object.freeze({
    REPLACEABLE: "replaceable",
    PERSISTENT: "persistent",
})

function copyPosition(target, source) {
    if (Array.isArray(source) || ArrayBuffer.isView(source)) {
        target.set(source[0], source[1], source[2])

        return target
    }

    if (
        source &&
        Number.isFinite(source.x) &&
        Number.isFinite(source.y) &&
        Number.isFinite(source.z)
    ) {
        target.copy(source)

        return target
    }

    throw new TypeError("Navigation positions must contain x, y and z values.")
}

export class NavigationAgentState {
    constructor({ actor, agentId, params, position }) {
        if (!actor) {
            throw new TypeError("NavigationAgentState requires an actor.")
        }

        if (agentId == null) {
            throw new TypeError("NavigationAgentState requires an agent id.")
        }

        this.actor = actor
        this.agentId = agentId
        this.params = params

        this.status = NavigationStatus.IDLE
        this.intentPolicy = NavigationIntentPolicy.REPLACEABLE

        this.requestedDestination = new Vector3()
        this.projectedDestination = new Vector3()
        this.previousPosition = new Vector3()

        this.actualVelocity = new Vector3()
        this.desiredVelocity = new Vector3()
        this.displacement = new Vector3()

        copyPosition(this.previousPosition, position)

        this.targetRef = null
        this.hasDestination = false
        this.reachedDestination = false
        this.targetPathIsPartial = false

        this.actualSpeed = 0
        this.desiredSpeed = 0
        this.stoppedElapsed = 0

        this.agentState = null
        this.targetState = null
    }

    setDestination({ requested, projected, targetRef, intentPolicy }) {
        copyPosition(this.requestedDestination, requested)
        copyPosition(this.projectedDestination, projected)

        this.targetRef = targetRef

        this.intentPolicy = intentPolicy ?? NavigationIntentPolicy.REPLACEABLE

        this.hasDestination = true
        this.reachedDestination = false
        this.targetPathIsPartial = false

        this.resetMotion()

        this.status = NavigationStatus.MOVING
    }

    markPaused() {
        if (!this.hasDestination) {
            return false
        }

        this.status = NavigationStatus.PAUSED
        this.reachedDestination = false
        this.targetPathIsPartial = false

        this.resetMotion()

        return true
    }

    markMoving() {
        if (!this.hasDestination) {
            return false
        }

        this.status = NavigationStatus.MOVING
        this.reachedDestination = false

        return true
    }

    markReached() {
        this.status = NavigationStatus.IDLE

        this.targetRef = null
        this.hasDestination = false
        this.reachedDestination = true
        this.targetPathIsPartial = false

        this.resetMotion()
    }

    markUnreachable() {
        this.status = NavigationStatus.UNREACHABLE

        this.targetRef = null
        this.hasDestination = false
        this.reachedDestination = false
        this.targetPathIsPartial = false

        this.resetMotion()
    }

    clearDestination() {
        this.status = NavigationStatus.IDLE

        this.targetRef = null
        this.hasDestination = false
        this.reachedDestination = false
        this.targetPathIsPartial = false

        this.resetMotion()
    }

    resetMotion() {
        this.actualVelocity.set(0, 0, 0)
        this.desiredVelocity.set(0, 0, 0)
        this.displacement.set(0, 0, 0)

        this.actualSpeed = 0
        this.desiredSpeed = 0
        this.stoppedElapsed = 0
    }

    isMoving() {
        return this.status === NavigationStatus.MOVING
    }
}
