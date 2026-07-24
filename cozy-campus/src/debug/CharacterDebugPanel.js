import { Vector3 } from "three"
import { crowd } from "navcat/blocks"

const DEFAULT_REFRESH_INTERVAL = 0.1
const DEFAULT_LOOP_DELAY = 0.75
const DEFAULT_RANDOM_RADIUS = 8

function copyVector3(value, label) {
    if (
        value &&
        Number.isFinite(value.x) &&
        Number.isFinite(value.y) &&
        Number.isFinite(value.z)
    ) {
        return new Vector3(value.x, value.y, value.z)
    }

    if (Array.isArray(value) || ArrayBuffer.isView(value)) {
        const vector = new Vector3(
            Number(value[0]),
            Number(value[1]),
            Number(value[2]),
        )

        if (
            Number.isFinite(vector.x) &&
            Number.isFinite(vector.y) &&
            Number.isFinite(vector.z)
        ) {
            return vector
        }
    }

    throw new TypeError(`${label} must contain finite x, y and z values.`)
}

function formatNumber(value, digits = 3) {
    if (!Number.isFinite(value)) {
        return "-"
    }

    return value.toFixed(digits)
}

function formatVector(vector) {
    if (!vector) {
        return "-"
    }

    return [
        formatNumber(vector.x),
        formatNumber(vector.y),
        formatNumber(vector.z),
    ].join(", ")
}

function getEnumLabel(enumObject, value) {
    if (value == null) {
        return "-"
    }

    return enumObject[value] ?? String(value)
}

export class CharacterDebugPanel {
    constructor({
        character,
        navigation,
        mount = document.body,
        routePoints = [],
        visible = true,
        collapsed = false,
        autoStart = false,
        refreshInterval = DEFAULT_REFRESH_INTERVAL,
        loopDelay = DEFAULT_LOOP_DELAY,
        randomRadius = DEFAULT_RANDOM_RADIUS,
    }) {
        if (!character) {
            throw new TypeError("CharacterDebugPanel requires a character.")
        }

        if (!navigation) {
            throw new TypeError(
                "CharacterDebugPanel requires NavigationFacade.",
            )
        }

        if (!(mount instanceof HTMLElement)) {
            throw new TypeError(
                "CharacterDebugPanel requires a valid mount element.",
            )
        }

        this.mount = mount
        this.collapsed = Boolean(collapsed)

        this.character = character
        this.navigation = navigation

        this.routePoints = routePoints.map((point, index) =>
            copyVector3(point, `Route point ${index}`),
        )

        this.refreshInterval = refreshInterval
        this.loopDelay = loopDelay
        this.randomRadius = randomRadius

        this.enabled = true
        this.disposed = false

        this.loopEnabled = false
        this.waitingForNextRoute = false
        this.loopDelayRemaining = 0
        this.nextRouteIndex = 0

        this.refreshElapsed = 0
        this.lastCommand = "Ready"

        this.handleClick = this.handleClick.bind(this)

        this.element = this.createElement()

        this.fields = this.collectFields()

        this.element.addEventListener("click", this.handleClick)

        this.mount.appendChild(this.element)

        this.setVisible(visible)
        this.setCollapsed(collapsed)
        this.refresh()

        if (autoStart) {
            this.startLoop()
        }
    }

    createElement() {
        const element = document.createElement("section")

        element.className = "debug-panel character-debug"

        element.setAttribute("aria-label", "Character navigation debug")

        element.innerHTML = `
        <div class="character-debug__header">
            <strong data-field="name"></strong>

            <div class="character-debug__header-actions">
                <span data-field="loop"></span>

                <button
                    type="button"
                    data-action="collapse"
                    aria-expanded="true"
                >
                    Collapse
                </button>
            </div>
        </div>

        <div class="character-debug__body">
            <div class="character-debug__actions">
                <button
                    type="button"
                    data-action="loop"
                >
                    Start loop
                </button>

                <button
                    type="button"
                    data-action="move-a"
                >
                    Move A
                </button>

                <button
                    type="button"
                    data-action="move-b"
                >
                    Move B
                </button>

                <button
                    type="button"
                    data-action="random"
                >
                    Random
                </button>

                <button
                    type="button"
                    data-action="pause"
                >
                    Pause
                </button>

                <button
                    type="button"
                    data-action="resume"
                >
                    Resume
                </button>

                <button
                    type="button"
                    data-action="cancel"
                >
                    Cancel
                </button>
            </div>

            <div class="character-debug__state">
                <div>
                    <span>Status</span>
                    <output data-field="status"></output>
                </div>

                <div>
                    <span>Destination</span>
                    <output data-field="hasDestination"></output>
                </div>

                <div>
                    <span>Reached</span>
                    <output data-field="reached"></output>
                </div>

                <div>
                    <span>Partial</span>
                    <output data-field="partial"></output>
                </div>

                <div>
                    <span>Position</span>
                    <output data-field="position"></output>
                </div>

                <div>
                    <span>Requested</span>
                    <output data-field="requested"></output>
                </div>

                <div>
                    <span>Projected</span>
                    <output data-field="projected"></output>
                </div>

                <div>
                    <span>Velocity</span>
                    <output data-field="velocity"></output>
                </div>

                <div>
                    <span>Desired velocity</span>
                    <output data-field="desiredVelocity"></output>
                </div>

                <div>
                    <span>Actual speed</span>
                    <output data-field="actualSpeed"></output>
                </div>

                <div>
                    <span>Desired speed</span>
                    <output data-field="desiredSpeed"></output>
                </div>

                <div>
                    <span>Stopped</span>
                    <output data-field="stoppedElapsed"></output>
                </div>

                <div>
                    <span>Agent state</span>
                    <output data-field="agentState"></output>
                </div>

                <div>
                    <span>Target state</span>
                    <output data-field="targetState"></output>
                </div>

                <div>
                    <span>Target ref</span>
                    <output data-field="targetRef"></output>
                </div>
            </div>

            <p
                class="character-debug__command"
                data-field="command"
            ></p>
        </div>
    `

        return element
    }

    setCollapsed(collapsed) {
        const nextCollapsed = Boolean(collapsed)

        this.collapsed = nextCollapsed

        this.element.classList.toggle(
            "character-debug--collapsed",
            nextCollapsed,
        )

        const button = this.element.querySelector('[data-action="collapse"]')

        if (button) {
            button.textContent = nextCollapsed ? "Expand" : "Collapse"

            button.setAttribute("aria-expanded", String(!nextCollapsed))
        }

        if (!nextCollapsed) {
            this.refresh()
        }

        return this.collapsed
    }

    toggleCollapsed() {
        return this.setCollapsed(!this.collapsed)
    }

    collectFields() {
        const fields = {}

        const elements = this.element.querySelectorAll("[data-field]")

        for (const element of elements) {
            fields[element.dataset.field] = element
        }

        return fields
    }

    update(delta) {
        if (this.disposed || !this.enabled) {
            return
        }

        this.updateLoop(delta)

        this.refreshElapsed += delta

        if (this.refreshElapsed < this.refreshInterval) {
            return
        }

        this.refreshElapsed %= this.refreshInterval

        this.refresh()
    }

    updateLoop(delta) {
        if (!this.loopEnabled) {
            return
        }

        const state = this.navigation.getState(this.character)

        if (!state) {
            return
        }

        if (
            state.status === "moving" ||
            state.status === "paused" ||
            state.hasDestination
        ) {
            this.waitingForNextRoute = false

            return
        }

        if (!this.waitingForNextRoute) {
            this.waitingForNextRoute = true

            this.loopDelayRemaining = this.loopDelay

            return
        }

        this.loopDelayRemaining -= delta

        if (this.loopDelayRemaining > 0) {
            return
        }

        this.issueNextRoutePoint()
    }

    startLoop() {
        if (this.routePoints.length < 2) {
            this.setCommand("Loop unavailable", false)

            return false
        }

        this.loopEnabled = true
        this.waitingForNextRoute = false

        const nearestIndex = this.findNearestRouteIndex()

        this.nextRouteIndex = (nearestIndex + 1) % this.routePoints.length

        const accepted = this.issueNextRoutePoint()

        this.updateLoopButton()

        return accepted
    }

    stopLoop() {
        const wasEnabled = this.loopEnabled

        this.loopEnabled = false
        this.waitingForNextRoute = false
        this.loopDelayRemaining = 0

        this.updateLoopButton()

        return wasEnabled
    }

    issueNextRoutePoint() {
        if (this.routePoints.length === 0) {
            return false
        }

        const targetIndex = this.nextRouteIndex

        const target = this.routePoints[targetIndex]

        this.nextRouteIndex = (targetIndex + 1) % this.routePoints.length

        this.waitingForNextRoute = false

        const accepted = this.navigation.moveTo(this.character, target)

        this.setCommand(`Loop → ${targetIndex === 0 ? "A" : "B"}`, accepted)

        return accepted
    }

    moveToRoutePoint(index) {
        const target = this.routePoints[index]

        if (!target) {
            this.setCommand(`Move ${index}`, false)

            return false
        }

        this.stopLoop()

        const accepted = this.navigation.moveTo(this.character, target)

        this.setCommand(`Move ${index === 0 ? "A" : "B"}`, accepted)

        return accepted
    }

    moveRandom() {
        this.stopLoop()

        const result = this.navigation.findRandomPoint(
            this.character.object3D.position,

            this.randomRadius,
        )

        const accepted =
            Boolean(result.success) &&
            this.navigation.moveTo(this.character, result.position)

        this.setCommand("Random destination", accepted)

        return accepted
    }

    pause() {
        const accepted = this.navigation.pause(this.character)

        this.setCommand("Pause", accepted)

        return accepted
    }

    resume() {
        const accepted = this.navigation.resume(this.character)

        this.setCommand("Resume", accepted)

        return accepted
    }

    cancel() {
        this.stopLoop()

        const accepted = this.navigation.cancel(this.character)

        this.setCommand("Cancel", accepted)

        return accepted
    }

    findNearestRouteIndex() {
        const position = this.character.object3D.position

        let nearestIndex = 0
        let nearestDistance = Infinity

        for (let index = 0; index < this.routePoints.length; index += 1) {
            const distance = position.distanceToSquared(this.routePoints[index])

            if (distance < nearestDistance) {
                nearestDistance = distance

                nearestIndex = index
            }
        }

        return nearestIndex
    }

    handleClick(event) {
        if (!(event.target instanceof Element)) {
            return
        }

        const button = event.target.closest("button[data-action]")

        if (!button || !this.element.contains(button)) {
            return
        }

        switch (button.dataset.action) {
            case "collapse":
                this.toggleCollapsed()
                break
            case "loop":
                if (this.loopEnabled) {
                    this.stopLoop()

                    this.setCommand("Loop stopped", true)
                } else {
                    this.startLoop()
                }

                break

            case "move-a":
                this.moveToRoutePoint(0)
                break

            case "move-b":
                this.moveToRoutePoint(1)
                break

            case "random":
                this.moveRandom()
                break

            case "pause":
                this.pause()
                break

            case "resume":
                this.resume()
                break

            case "cancel":
                this.cancel()
                break
        }

        this.refresh()
    }

    setCommand(label, accepted) {
        this.lastCommand = `${label}: ${accepted ? "accepted" : "rejected"}`
    }

    updateLoopButton() {
        const button = this.element.querySelector('[data-action="loop"]')

        if (!button) {
            return
        }

        button.textContent = this.loopEnabled ? "Stop loop" : "Start loop"
    }

    refresh() {
        const state = this.navigation.getState(this.character)

        this.fields.name.textContent = this.character.name

        this.fields.loop.textContent = this.loopEnabled ? "LOOP ON" : "LOOP OFF"

        this.fields.position.textContent = formatVector(
            this.character.object3D.position,
        )

        this.fields.command.textContent = this.lastCommand

        this.updateLoopButton()

        if (!state) {
            this.fields.status.textContent = "unregistered"

            return
        }

        this.fields.status.textContent = state.status

        this.fields.hasDestination.textContent = String(state.hasDestination)

        this.fields.reached.textContent = String(state.reachedDestination)

        this.fields.partial.textContent = String(state.targetPathIsPartial)

        this.fields.requested.textContent = state.hasDestination
            ? formatVector(state.requestedDestination)
            : "-"

        this.fields.projected.textContent = state.hasDestination
            ? formatVector(state.projectedDestination)
            : "-"

        this.fields.velocity.textContent = formatVector(state.actualVelocity)

        this.fields.desiredVelocity.textContent = formatVector(
            state.desiredVelocity,
        )

        this.fields.actualSpeed.textContent = formatNumber(state.actualSpeed)

        this.fields.desiredSpeed.textContent = formatNumber(state.desiredSpeed)

        this.fields.stoppedElapsed.textContent = formatNumber(
            state.stoppedElapsed,
        )

        this.fields.agentState.textContent = getEnumLabel(
            crowd.AgentState,
            state.agentState,
        )

        this.fields.targetState.textContent = getEnumLabel(
            crowd.AgentTargetState,
            state.targetState,
        )

        this.fields.targetRef.textContent =
            state.targetRef == null ? "-" : String(state.targetRef)
    }

    setVisible(visible) {
        this.element.hidden = !Boolean(visible)
    }

    dispose() {
        if (this.disposed) {
            return
        }

        this.disposed = true
        this.enabled = false
        this.loopEnabled = false

        this.element.removeEventListener("click", this.handleClick)

        this.element.remove()

        this.fields = null
        this.element = null
        this.character = null
        this.navigation = null
        this.routePoints.length = 0
        this.routePoints = null
        this.mount = null
    }
}
