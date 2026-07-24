import { DEFAULT_QUERY_FILTER } from "navcat"
import { crowd } from "navcat/blocks"

import {
    NavigationAgentState,
    NavigationIntentPolicy,
    NavigationStatus,
} from "./NavigationAgentState.js"

const DEFAULT_UPDATE_FLAGS =
    crowd.CrowdUpdateFlags.ANTICIPATE_TURNS |
    crowd.CrowdUpdateFlags.OBSTACLE_AVOIDANCE |
    crowd.CrowdUpdateFlags.SEPARATION |
    crowd.CrowdUpdateFlags.OPTIMIZE_VIS |
    crowd.CrowdUpdateFlags.OPTIMIZE_TOPO

const STOPPED_SPEED_EPSILON = 0.025

function positiveNumber(value, fallback, label) {
    const resolved = value ?? fallback

    if (!Number.isFinite(resolved) || resolved <= 0) {
        throw new RangeError(
            `${label} must be a finite number greater than zero.`,
        )
    }

    return resolved
}

function nonNegativeNumber(value, fallback, label) {
    const resolved = value ?? fallback

    if (!Number.isFinite(resolved) || resolved < 0) {
        throw new RangeError(
            `${label} must be a finite number greater than or equal to zero.`,
        )
    }

    return resolved
}

export class CrowdNavigationSystem {
    constructor({ navMeshWorld, config, defaultAgent, onChanged = null }) {
        if (!navMeshWorld) {
            throw new TypeError("CrowdNavigationSystem requires NavMeshWorld.")
        }

        if (!config || !defaultAgent) {
            throw new TypeError(
                "CrowdNavigationSystem requires crowd and default-agent configuration.",
            )
        }

        this.navMeshWorld = navMeshWorld
        this.config = config
        this.defaultAgent = defaultAgent
        this.onChanged = onChanged

        this.maxAgentRadius = positiveNumber(
            config.maxAgentRadius,
            defaultAgent.radius,
            "Crowd maxAgentRadius",
        )

        this.crowd = crowd.create(this.maxAgentRadius)
        this.states = new Map()

        this.fixedTimeStep = positiveNumber(
            config.fixedTimeStep,
            1 / 60,
            "Crowd fixedTimeStep",
        )

        this.maxSubSteps = Math.max(1, Math.floor(config.maxSubSteps ?? 2))

        this.maxAccumulatedTime = positiveNumber(
            config.maxAccumulatedTime,
            1 / 10,
            "Crowd maxAccumulatedTime",
        )

        this.accumulator = 0
        this.disposed = false
    }

    register(actor, options = {}) {
        this.assertUsable()
        this.navMeshWorld.assertReady()

        if (!actor?.object3D?.position) {
            throw new TypeError(
                "CrowdNavigationSystem.register requires an actor with object3D.position.",
            )
        }

        if (this.states.has(actor)) {
            return this.states.get(actor)
        }

        const params = this.createAgentParams(options)
        const sourcePosition = options.position ?? actor.object3D.position

        const projection = this.navMeshWorld.projectPoint(sourcePosition, {
            queryFilter: params.queryFilter,
        })

        if (!projection.success) {
            throw new RangeError(
                `Actor "${actor.id ?? actor.name ?? "unknown"}" could not be projected onto the navmesh.`,
            )
        }

        actor.object3D.position.set(
            projection.position[0],
            projection.position[1],
            projection.position[2],
        )

        const agentId = crowd.addAgent(
            this.crowd,
            this.navMeshWorld.navMesh,
            projection.position,
            params,
        )

        const state = new NavigationAgentState({
            actor,
            agentId,
            params,
            position: projection.position,
        })

        this.states.set(actor, state)

        actor.syncNavigationMotion?.(state, this.getAgentByState(state))

        this.onChanged?.()

        return state
    }

    unregister(actor, { notify = true } = {}) {
        const state = this.states.get(actor)

        if (!state) {
            return false
        }

        crowd.removeAgent(this.crowd, state.agentId)

        actor.clearNavigationMotion?.(state)

        this.states.delete(actor)

        if (notify) {
            this.onChanged?.()
        }

        return true
    }

    moveTo(actor, destination, options = {}) {
        const state = this.requireState(actor)

        const queryFilter = options.queryFilter ?? state.params.queryFilter

        const projection = this.navMeshWorld.projectPoint(destination, {
            halfExtents: options.halfExtents,

            queryFilter,
        })

        if (!projection.success) {
            this.haltAgent(state)
            state.markUnreachable()
            this.syncActorState(state)

            this.onChanged?.()

            return false
        }

        const accepted = crowd.requestMoveTarget(
            this.crowd,
            state.agentId,
            projection.nodeRef,
            projection.position,
        )

        if (!accepted) {
            this.haltAgent(state)
            state.markUnreachable()
            this.syncActorState(state)

            this.onChanged?.()

            return false
        }

        state.setDestination({
            requested: destination,
            projected: projection.position,
            targetRef: projection.nodeRef,

            intentPolicy:
                options.intentPolicy ?? NavigationIntentPolicy.REPLACEABLE,
        })

        this.syncActorState(state)
        this.onChanged?.()

        return true
    }

    stop(actor) {
        const state = this.states.get(actor)

        if (!state) {
            return false
        }

        if (!this.haltAgent(state)) {
            return false
        }

        state.clearDestination()

        this.syncActorState(state)
        this.onChanged?.()

        return true
    }

    pause(actor) {
        const state = this.states.get(actor)

        if (
            !state ||
            !state.hasDestination ||
            state.status === NavigationStatus.PAUSED
        ) {
            return false
        }

        if (!this.haltAgent(state)) {
            return false
        }

        state.markPaused()

        this.syncActorState(state)
        this.onChanged?.()

        return true
    }

    resume(actor) {
        const state = this.states.get(actor)

        if (
            !state ||
            state.status !== NavigationStatus.PAUSED ||
            !state.hasDestination
        ) {
            return false
        }

        return this.moveTo(actor, state.requestedDestination, {
            queryFilter: state.params.queryFilter,

            intentPolicy: state.intentPolicy,
        })
    }

    update(delta) {
        if (
            this.disposed ||
            !this.navMeshWorld.ready ||
            this.states.size === 0
        ) {
            this.accumulator = 0
            return false
        }

        const safeDelta = Number.isFinite(delta) && delta > 0 ? delta : 0

        this.accumulator = Math.min(
            this.accumulator + safeDelta,
            this.maxAccumulatedTime,
        )

        let subSteps = 0
        let changed = false

        while (
            this.accumulator >= this.fixedTimeStep &&
            subSteps < this.maxSubSteps
        ) {
            crowd.update(
                this.crowd,
                this.navMeshWorld.navMesh,
                this.fixedTimeStep,
            )

            changed = this.syncAgents(this.fixedTimeStep) || changed

            this.accumulator -= this.fixedTimeStep
            subSteps += 1
        }

        if (
            subSteps === this.maxSubSteps &&
            this.accumulator >= this.fixedTimeStep
        ) {
            this.accumulator %= this.fixedTimeStep
        }

        if (changed) {
            this.onChanged?.()
        }

        return changed
    }

    syncAgents(delta) {
        let changed = false

        for (const state of this.states.values()) {
            const agent = this.getAgentByState(state)

            if (!agent) {
                continue
            }

            const actorPosition = state.actor.object3D.position
            const previousStatus = state.status

            if (
                state.status === NavigationStatus.PAUSED ||
                (state.status === NavigationStatus.IDLE &&
                    !state.hasDestination)
            ) {
                agent.corners.length = 0

                agent.desiredSpeed = 0

                agent.desiredVelocity[0] = 0
                agent.desiredVelocity[1] = 0
                agent.desiredVelocity[2] = 0

                agent.newVelocity[0] = 0
                agent.newVelocity[1] = 0
                agent.newVelocity[2] = 0

                agent.velocity[0] = 0
                agent.velocity[1] = 0
                agent.velocity[2] = 0

                agent.displacement[0] = 0
                agent.displacement[1] = 0
                agent.displacement[2] = 0
            }

            state.previousPosition.copy(actorPosition)

            actorPosition.set(
                agent.position[0],
                agent.position[1],
                agent.position[2],
            )

            state.displacement.subVectors(actorPosition, state.previousPosition)

            state.actualVelocity.set(
                agent.velocity[0],
                agent.velocity[1],
                agent.velocity[2],
            )

            state.desiredVelocity.set(
                agent.desiredVelocity[0],
                agent.desiredVelocity[1],
                agent.desiredVelocity[2],
            )

            state.actualSpeed = state.actualVelocity.length()

            /*
             * agent.desiredSpeed não representa
             * necessariamente a velocidade efetivamente
             * desejada. O navcat pode mantê-lo em maxSpeed
             * mesmo com desiredVelocity zerado.
             */
            state.desiredSpeed = state.desiredVelocity.length()
            state.agentState = agent.state
            state.targetState = agent.targetState
            state.targetPathIsPartial = Boolean(agent.targetPathIsPartial)

            this.updateStateStatus(state, agent, delta)

            state.actor.syncNavigationMotion?.(state, agent)

            if (
                state.displacement.lengthSq() > 0 ||
                previousStatus !== state.status
            ) {
                changed = true
            }
        }

        return changed
    }

    updateStateStatus(state, agent, delta) {
        if (
            state.status === NavigationStatus.PAUSED ||
            state.status === NavigationStatus.INTERACTING ||
            state.status === NavigationStatus.SPECIAL_TRAVERSAL
        ) {
            state.stoppedElapsed = 0

            return
        }

        if (
            state.status === NavigationStatus.UNREACHABLE &&
            !state.hasDestination
        ) {
            state.stoppedElapsed = 0

            return
        }

        if (agent.targetState === crowd.AgentTargetState.FAILED) {
            this.haltAgent(state)
            state.markUnreachable()

            return
        }

        if (!state.hasDestination) {
            state.status = NavigationStatus.IDLE

            state.stoppedElapsed = 0

            return
        }

        const arrivalThreshold = Math.max(0.05, state.params.radius * 0.25)

        if (
            crowd.isAgentAtTarget(this.crowd, state.agentId, arrivalThreshold)
        ) {
            this.haltAgent(state)
            state.markReached()

            return
        }

        state.status = NavigationStatus.MOVING

        if (state.actualSpeed <= STOPPED_SPEED_EPSILON) {
            state.stoppedElapsed += delta
        } else {
            state.stoppedElapsed = 0
        }
    }

    createAgentParams(options) {
        const radius = positiveNumber(
            options.radius,
            this.defaultAgent.radius,
            "Agent radius",
        )

        if (radius > this.maxAgentRadius) {
            throw new RangeError(
                `Agent radius ${radius} exceeds crowd maxAgentRadius ${this.maxAgentRadius}.`,
            )
        }

        const params = {
            radius,

            height: positiveNumber(
                options.height,
                this.defaultAgent.height,
                "Agent height",
            ),

            maxAcceleration: positiveNumber(
                options.maxAcceleration,
                this.defaultAgent.maxAcceleration,
                "Agent maxAcceleration",
            ),

            maxSpeed: positiveNumber(
                options.maxSpeed,
                this.defaultAgent.maxSpeed,
                "Agent maxSpeed",
            ),

            collisionQueryRange: positiveNumber(
                options.collisionQueryRange,
                radius * 12,
                "Agent collisionQueryRange",
            ),

            pathOptimizationRange: positiveNumber(
                options.pathOptimizationRange,
                radius * 30,
                "Agent pathOptimizationRange",
            ),

            separationWeight: nonNegativeNumber(
                options.separationWeight,
                0.5,
                "Agent separationWeight",
            ),

            updateFlags: options.updateFlags ?? DEFAULT_UPDATE_FLAGS,

            queryFilter:
                options.queryFilter ??
                this.navMeshWorld.queryFilter ??
                DEFAULT_QUERY_FILTER,

            autoTraverseOffMeshConnections:
                options.autoTraverseOffMeshConnections ?? false,

            debugObstacleAvoidance: Boolean(options.debugObstacleAvoidance),
        }

        if (options.obstacleAvoidance) {
            params.obstacleAvoidance = options.obstacleAvoidance
        }

        return params
    }

    haltAgent(state) {
        const agent = this.getAgentByState(state)

        if (!agent) {
            return false
        }

        const reset = crowd.resetMoveTarget(this.crowd, state.agentId)

        if (!reset) {
            return false
        }

        /*
         * resetMoveTarget() não limpa os
         * steering corners. Sem isso,
         * updateSteering() recria a velocidade
         * em direção ao destino anterior.
         */
        agent.corners.length = 0

        agent.desiredSpeed = 0
        agent.targetPathfindingTime = 0
        agent.topologyOptTime = 0

        agent.desiredVelocity[0] = 0
        agent.desiredVelocity[1] = 0
        agent.desiredVelocity[2] = 0

        agent.newVelocity[0] = 0
        agent.newVelocity[1] = 0
        agent.newVelocity[2] = 0

        agent.velocity[0] = 0
        agent.velocity[1] = 0
        agent.velocity[2] = 0

        agent.displacement[0] = 0
        agent.displacement[1] = 0
        agent.displacement[2] = 0

        state.targetState = agent.targetState
        state.agentState = agent.state
        state.targetPathIsPartial = false

        state.resetMotion()

        return true
    }

    syncActorState(state) {
        const agent = this.getAgentByState(state)

        state.actor.syncNavigationMotion?.(state, agent)
    }

    getAgent(actor) {
        const state = this.states.get(actor)

        return state ? this.getAgentByState(state) : null
    }

    getAgentByState(state) {
        return this.crowd.agents[state.agentId] ?? null
    }

    getState(actor) {
        return this.states.get(actor) ?? null
    }

    has(actor) {
        return this.states.has(actor)
    }

    requireState(actor) {
        const state = this.states.get(actor)

        if (!state) {
            throw new Error(
                `Actor "${actor?.id ?? actor?.name ?? "unknown"}" is not registered in navigation.`,
            )
        }

        return state
    }

    reset() {
        const hadAgents = this.states.size > 0

        for (const actor of this.states.keys()) {
            this.unregister(actor, { notify: false })
        }

        this.accumulator = 0

        if (hadAgents) {
            this.onChanged?.()
        }
    }

    assertUsable() {
        if (this.disposed) {
            throw new Error("CrowdNavigationSystem is already disposed.")
        }
    }

    dispose() {
        if (this.disposed) {
            return
        }

        this.reset()

        this.disposed = true
        this.crowd = null
        this.navMeshWorld = null
        this.config = null
        this.defaultAgent = null
        this.maxAgentRadius = 0
        this.onChanged = null
    }
}
