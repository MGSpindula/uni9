import {
    CapsuleGeometry,
    ConeGeometry,
    Group,
    Mesh,
    MeshStandardMaterial,
    Quaternion,
    Vector3,
} from "three"

import { Entity } from "../core/Entity.js"

const UP_AXIS = new Vector3(0, 1, 0)

const MIN_FACING_SPEED_SQUARED = 0.0025
const TURN_COMPLETION_EPSILON = 0.002

const DEFAULT_NAVIGATION_PROFILE = Object.freeze({
    radius: 0.42,
    height: 1.8,
    maxSpeed: 2.2,
    maxAcceleration: 8,
})

function positiveNumber(value, fallback, label) {
    const resolved = value ?? fallback

    if (!Number.isFinite(resolved) || resolved <= 0) {
        throw new RangeError(
            `${label} must be a finite number greater than zero.`,
        )
    }

    return resolved
}

function createNavigationProfile(profile = {}) {
    return Object.freeze({
        radius: positiveNumber(
            profile.radius,
            DEFAULT_NAVIGATION_PROFILE.radius,
            "Character radius",
        ),

        height: positiveNumber(
            profile.height,
            DEFAULT_NAVIGATION_PROFILE.height,
            "Character height",
        ),

        maxSpeed: positiveNumber(
            profile.maxSpeed,
            DEFAULT_NAVIGATION_PROFILE.maxSpeed,
            "Character maxSpeed",
        ),

        maxAcceleration: positiveNumber(
            profile.maxAcceleration,
            DEFAULT_NAVIGATION_PROFILE.maxAcceleration,
            "Character maxAcceleration",
        ),
    })
}

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

    throw new TypeError(
        "Character position must contain finite x, y and z values.",
    )
}

function createPrototypeVisual({ radius, height, color }) {
    const visual = new Group()

    visual.name = "CharacterVisual"

    const middleHeight = Math.max(0.01, height - radius * 2)

    const bodyGeometry = new CapsuleGeometry(radius, middleHeight, 4, 10, 1)

    const bodyMaterial = new MeshStandardMaterial({
        color,
        roughness: 0.85,
        metalness: 0,
    })

    const body = new Mesh(bodyGeometry, bodyMaterial)

    body.name = "CharacterBody"
    body.position.y = height * 0.5
    body.castShadow = true
    body.receiveShadow = true

    const directionGeometry = new ConeGeometry(
        Math.max(0.05, radius * 0.2),
        Math.max(0.12, radius * 0.55),
        8,
    )

    const directionMaterial = new MeshStandardMaterial({
        color: 0xf7f2e8,
        roughness: 0.8,
        metalness: 0,
    })

    const directionMarker = new Mesh(directionGeometry, directionMaterial)

    directionMarker.name = "CharacterDirectionMarker"

    directionMarker.position.set(0, height * 0.67, radius * 0.92)

    directionMarker.rotation.x = Math.PI * 0.5
    directionMarker.castShadow = true

    visual.add(body)
    visual.add(directionMarker)

    return visual
}

export class Character extends Entity {
    constructor({
        id = null,
        name = null,
        kind = "character",
        color = 0xe2b879,
        position = {
            x: 0,
            y: 0,
            z: 0,
        },
        navigationProfile = {},
        visual = null,
        interactive = true,
        disposeResources = visual === null,
        turnResponsiveness = 12,
    } = {}) {
        const profile = createNavigationProfile(navigationProfile)

        const root = new Group()

        const resolvedVisual =
            visual ??
            createPrototypeVisual({
                radius: profile.radius,
                height: profile.height,
                color,
            })

        root.add(resolvedVisual)

        super({
            id,
            name,
            object3D: root,
            interactive,
            disposeResources,
        })

        this.kind = kind
        this.visual = resolvedVisual

        this.navigationProfile = profile
        this.navigationState = null

        this.turnResponsiveness = positiveNumber(
            turnResponsiveness,
            12,
            "Character turnResponsiveness",
        )

        this.targetOrientation = new Quaternion().copy(this.visual.quaternion)

        this.turning = false

        this.motion = {
            status: "idle",

            displacement: new Vector3(),
            actualVelocity: new Vector3(),
            desiredVelocity: new Vector3(),

            actualSpeed: 0,
            desiredSpeed: 0,

            stoppedElapsed: 0,

            hasDestination: false,
            reachedDestination: false,
            targetPathIsPartial: false,
        }

        copyPosition(this.object3D.position, position)

        this.object3D.userData.character = true
        this.object3D.userData.characterKind = kind
    }

    syncNavigationMotion(state) {
        if (!state) {
            return false
        }

        const previousStatus = this.motion.status

        const previouslyReached = this.motion.reachedDestination

        this.navigationState = state

        this.motion.status = state.status

        this.motion.displacement.copy(state.displacement)

        this.motion.actualVelocity.copy(state.actualVelocity)

        this.motion.desiredVelocity.copy(state.desiredVelocity)

        this.motion.actualSpeed = state.actualSpeed

        this.motion.desiredSpeed = state.desiredSpeed

        this.motion.stoppedElapsed = state.stoppedElapsed

        this.motion.hasDestination = state.hasDestination

        this.motion.reachedDestination = state.reachedDestination

        this.motion.targetPathIsPartial = state.targetPathIsPartial

        if (previousStatus !== this.motion.status) {
            this.dispatchEvent({
                type: "navigationstatuschange",
                previousStatus,
                status: this.motion.status,
                state,
            })
        }

        if (!previouslyReached && this.motion.reachedDestination) {
            this.dispatchEvent({
                type: "destinationreached",
                state,
            })
        }

        return true
    }

    clearNavigationMotion(state = null) {
        if (state && this.navigationState !== state) {
            return false
        }

        const previousStatus = this.motion.status

        this.navigationState = null

        this.motion.status = "idle"

        this.motion.displacement.set(0, 0, 0)

        this.motion.actualVelocity.set(0, 0, 0)

        this.motion.desiredVelocity.set(0, 0, 0)

        this.motion.actualSpeed = 0
        this.motion.desiredSpeed = 0
        this.motion.stoppedElapsed = 0

        this.motion.hasDestination = false

        this.motion.reachedDestination = false

        this.motion.targetPathIsPartial = false

        if (previousStatus !== "idle") {
            this.dispatchEvent({
                type: "navigationstatuschange",
                previousStatus,
                status: "idle",
                state: null,
            })
        }

        return true
    }

    setPosition(position) {
        copyPosition(this.object3D.position, position)

        return this
    }

    setFacingDirection(direction, { immediate = false } = {}) {
        if (
            !direction ||
            !Number.isFinite(direction.x) ||
            !Number.isFinite(direction.z)
        ) {
            throw new TypeError(
                "Facing direction must contain finite x and z values.",
            )
        }

        const horizontalLengthSquared =
            direction.x * direction.x + direction.z * direction.z

        if (horizontalLengthSquared <= MIN_FACING_SPEED_SQUARED) {
            return false
        }

        const yaw = Math.atan2(direction.x, direction.z)

        this.targetOrientation.setFromAxisAngle(UP_AXIS, yaw)

        if (immediate) {
            this.visual.quaternion.copy(this.targetOrientation)

            this.turning = false

            return true
        }

        this.turning = true

        return true
    }

    updateFacing(delta) {
        const actualVelocity = this.motion.actualVelocity

        const desiredVelocity = this.motion.desiredVelocity

        const actualHorizontalSpeedSquared =
            actualVelocity.x * actualVelocity.x +
            actualVelocity.z * actualVelocity.z

        const desiredHorizontalSpeedSquared =
            desiredVelocity.x * desiredVelocity.x +
            desiredVelocity.z * desiredVelocity.z

        if (actualHorizontalSpeedSquared > MIN_FACING_SPEED_SQUARED) {
            this.setFacingDirection(actualVelocity)
        } else if (desiredHorizontalSpeedSquared > MIN_FACING_SPEED_SQUARED) {
            this.setFacingDirection(desiredVelocity)
        }

        if (!this.turning) {
            return false
        }

        const remainingAngle = this.visual.quaternion.angleTo(
            this.targetOrientation,
        )

        if (remainingAngle <= TURN_COMPLETION_EPSILON) {
            this.visual.quaternion.copy(this.targetOrientation)

            this.turning = false

            return true
        }

        const safeDelta = Number.isFinite(delta) && delta > 0 ? delta : 0

        const alpha = 1 - Math.exp(-this.turnResponsiveness * safeDelta)

        this.visual.quaternion.slerp(this.targetOrientation, Math.min(alpha, 1))

        this.turning =
            this.visual.quaternion.angleTo(this.targetOrientation) >
            TURN_COMPLETION_EPSILON

        return true
    }

    onUpdate(delta, context) {
        this.updateFacing(delta)

        this.onCharacterUpdate(delta, context)
    }

    onCharacterUpdate() {}

    getSelectionObject() {
        return this.visual
    }

    requiresContinuousRender() {
        return (
            super.requiresContinuousRender() ||
            this.turning ||
            this.motion.actualSpeed > 0.001 ||
            this.motion.desiredSpeed > 0.001
        )
    }

    dispose() {
        if (this.disposed) {
            return
        }

        super.dispose()

        this.visual = null
        this.navigationProfile = null
        this.navigationState = null
        this.targetOrientation = null
        this.motion = null
    }
}
