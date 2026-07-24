import {
    DEFAULT_QUERY_FILTER,
    FindPathResultFlags,
    INVALID_NODE_REF,
    createFindNearestPolyResult,
    findNearestPoly,
    findPath as findNavMeshPath,
    findRandomPoint as findNavMeshRandomPoint,
    findRandomPointAroundCircle,
} from "navcat"

function writeVec3(target, source, label = "position") {
    if (Array.isArray(source) || ArrayBuffer.isView(source)) {
        target[0] = Number(source[0])
        target[1] = Number(source[1])
        target[2] = Number(source[2])
    } else if (
        source &&
        Number.isFinite(source.x) &&
        Number.isFinite(source.y) &&
        Number.isFinite(source.z)
    ) {
        target[0] = source.x
        target[1] = source.y
        target[2] = source.z
    } else {
        throw new TypeError(`${label} must contain x, y and z values.`)
    }

    if (!target.every(Number.isFinite)) {
        throw new TypeError(`${label} must contain finite x, y and z values.`)
    }

    return target
}

function createProjectionResult() {
    return {
        success: false,
        nodeRef: INVALID_NODE_REF,
        position: [0, 0, 0],
    }
}

export class NavMeshWorld {
    constructor({ config }) {
        if (!config) {
            throw new TypeError("NavMeshWorld requires a configuration object.")
        }

        this.config = config
        this.navMesh = null
        this.queryFilter = DEFAULT_QUERY_FILTER

        this.projectionHalfExtents = [
            config.projectionHalfExtents.x,
            config.projectionHalfExtents.y,
            config.projectionHalfExtents.z,
        ]

        this.nearestPolyResult = createFindNearestPolyResult()
        this.positionScratch = [0, 0, 0]
        this.startScratch = [0, 0, 0]
        this.destinationScratch = [0, 0, 0]
        this.halfExtentsScratch = [0, 0, 0]

        this.changeListeners = new Set()
        this.version = 0
        this.disposed = false
    }

    setNavMesh(navMesh, { queryFilter = DEFAULT_QUERY_FILTER } = {}) {
        this.assertUsable()

        if (!navMesh || typeof navMesh !== "object") {
            throw new TypeError("NavMeshWorld.setNavMesh requires a navmesh.")
        }

        this.navMesh = navMesh
        this.queryFilter = queryFilter
        this.version += 1
        this.notifyChanged()

        return navMesh
    }

    clear() {
        this.assertUsable()

        if (!this.navMesh) {
            return false
        }

        this.navMesh = null
        this.queryFilter = DEFAULT_QUERY_FILTER
        this.version += 1
        this.notifyChanged()

        return true
    }

    projectPoint(
        position,
        {
            halfExtents = this.projectionHalfExtents,
            queryFilter = this.queryFilter,
            out = null,
        } = {},
    ) {
        this.assertReady()

        writeVec3(this.positionScratch, position, "position")
        writeVec3(this.halfExtentsScratch, halfExtents, "halfExtents")

        findNearestPoly(
            this.nearestPolyResult,
            this.navMesh,
            this.positionScratch,
            this.halfExtentsScratch,
            queryFilter,
        )

        const result = out ?? createProjectionResult()

        if (!result.position) {
            result.position = [0, 0, 0]
        }

        result.success = this.nearestPolyResult.success
        result.nodeRef = this.nearestPolyResult.nodeRef
        result.position[0] = this.nearestPolyResult.position[0]
        result.position[1] = this.nearestPolyResult.position[1]
        result.position[2] = this.nearestPolyResult.position[2]

        return result
    }

    findPath(
        start,
        destination,
        {
            halfExtents = this.projectionHalfExtents,
            queryFilter = this.queryFilter,
            options = undefined,
        } = {},
    ) {
        this.assertReady()

        writeVec3(this.startScratch, start, "start")
        writeVec3(this.destinationScratch, destination, "destination")
        writeVec3(this.halfExtentsScratch, halfExtents, "halfExtents")

        return findNavMeshPath(
            this.navMesh,
            this.startScratch,
            this.destinationScratch,
            this.halfExtentsScratch,
            queryFilter,
            options,
        )
    }

    findRandomPoint(
        center = null,
        radius = null,
        { queryFilter = this.queryFilter, random = Math.random } = {},
    ) {
        this.assertReady()

        if (center == null && radius == null) {
            return findNavMeshRandomPoint(this.navMesh, queryFilter, random)
        }

        if (center == null || radius == null) {
            throw new TypeError(
                "findRandomPoint requires both center and radius, or neither.",
            )
        }

        if (!Number.isFinite(radius) || radius <= 0) {
            throw new RangeError(
                "Random-point radius must be greater than zero.",
            )
        }

        const projectedCenter = this.projectPoint(center, { queryFilter })

        if (!projectedCenter.success) {
            return {
                success: false,
                nodeRef: INVALID_NODE_REF,
                position: [0, 0, 0],
            }
        }

        return findRandomPointAroundCircle(
            this.navMesh,
            projectedCenter.nodeRef,
            projectedCenter.position,
            radius,
            queryFilter,
            random,
        )
    }

    isReachable(start, destination, options = {}) {
        const result = this.findPath(start, destination, options)

        return Boolean(
            result.success &&
            (result.flags & FindPathResultFlags.COMPLETE_PATH) !== 0,
        )
    }

    onChanged(listener, { immediate = false } = {}) {
        if (typeof listener !== "function") {
            throw new TypeError("NavMeshWorld.onChanged requires a function.")
        }

        this.changeListeners.add(listener)

        if (immediate) {
            listener(this)
        }

        return () => {
            this.changeListeners.delete(listener)
        }
    }

    notifyChanged() {
        for (const listener of this.changeListeners) {
            listener(this)
        }
    }

    assertReady() {
        this.assertUsable()

        if (!this.navMesh) {
            throw new Error("The navigation mesh has not been configured.")
        }
    }

    assertUsable() {
        if (this.disposed) {
            throw new Error("NavMeshWorld is already disposed.")
        }
    }

    get ready() {
        return this.navMesh !== null
    }

    dispose() {
        if (this.disposed) {
            return
        }

        this.clear()
        this.changeListeners.clear()

        this.disposed = true
        this.config = null
        this.nearestPolyResult = null
        this.positionScratch = null
        this.startScratch = null
        this.destinationScratch = null
        this.halfExtentsScratch = null
    }
}
