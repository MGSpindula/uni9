import {
    BufferGeometry,
    Color,
    Float32BufferAttribute,
    Mesh,
    MeshStandardMaterial,
    Vector3,
} from "three"

import { generateSoloNavMesh } from "navcat/blocks"
import { getPositionsAndIndices } from "navcat/three"

const DEFAULT_BUILD_CONFIG = Object.freeze({
    cellSize: 0.15,
    cellHeight: 0.1,

    walkableClimbWorld: 0.45,
    walkableSlopeAngleDegrees: 45,

    borderSize: 0,

    minRegionArea: 8,
    mergeRegionArea: 20,

    maxSimplificationError: 1.3,
    maxEdgeLength: 12,
    maxVerticesPerPoly: 6,

    detailSampleDistanceVoxels: 6,
    detailSampleMaxErrorVoxels: 1,
})

const GROUND_COLOR = 0x6ea96e
const RAMP_COLOR = 0x87b978
const PLATFORM_COLOR = 0x78a96f

function requirePositiveNumber(value, label) {
    if (!Number.isFinite(value) || value <= 0) {
        throw new RangeError(
            `${label} must be a finite number greater than zero.`,
        )
    }

    return value
}

function pushVertex(positions, colors, point, color) {
    positions.push(point.x, point.y, point.z)
    colors.push(color.r, color.g, color.b)
}

function pushQuad(positions, colors, indices, points, colorValue) {
    const color = new Color(colorValue)
    const offset = positions.length / 3

    for (let index = 0; index < points.length; index += 1) {
        pushVertex(positions, colors, points[index], color)
    }

    indices.push(offset, offset + 1, offset + 2, offset, offset + 2, offset + 3)
}

function createHorizontalQuad({ center, width, length, y = center.y }) {
    const halfWidth = width * 0.5
    const halfLength = length * 0.5

    return [
        new Vector3(center.x - halfWidth, y, center.z - halfLength),
        new Vector3(center.x - halfWidth, y, center.z + halfLength),
        new Vector3(center.x + halfWidth, y, center.z + halfLength),
        new Vector3(center.x + halfWidth, y, center.z - halfLength),
    ]
}

function createSlopeQuad({ start, end, width }) {
    const direction = end.clone().sub(start)
    const horizontalLength = Math.hypot(direction.x, direction.z)

    if (horizontalLength <= Number.EPSILON) {
        throw new RangeError("A slope requires horizontal distance.")
    }

    const horizontalX = direction.x / horizontalLength
    const horizontalZ = direction.z / horizontalLength
    const halfWidth = width * 0.5

    const left = new Vector3(
        -horizontalZ * halfWidth,
        0,
        horizontalX * halfWidth,
    )

    const startLeft = start.clone().add(left)
    const startRight = start.clone().sub(left)
    const endLeft = end.clone().add(left)
    const endRight = end.clone().sub(left)

    return [startRight, startLeft, endLeft, endRight]
}

export class CozyCampusNavMeshSource {
    constructor({ agent, build = {} } = {}) {
        if (!agent) {
            throw new TypeError(
                "CozyCampusNavMeshSource requires agent settings.",
            )
        }

        this.agentRadius = requirePositiveNumber(agent.radius, "Agent radius")
        this.agentHeight = requirePositiveNumber(agent.height, "Agent height")

        this.buildConfig = {
            ...DEFAULT_BUILD_CONFIG,
            ...build,
        }

        this.object3D = this.createEnvironmentMesh()
        this.walkableMeshes = [this.object3D]

        this.result = null
        this.disposed = false
    }

    createEnvironmentMesh() {
        const positions = []
        const colors = []
        const indices = []

        pushQuad(
            positions,
            colors,
            indices,
            createHorizontalQuad({
                center: new Vector3(0, 0, 0),
                width: 20,
                length: 20,
            }),
            GROUND_COLOR,
        )

        pushQuad(
            positions,
            colors,
            indices,
            createSlopeQuad({
                start: new Vector3(3, 0, -3),
                end: new Vector3(6, 2, -3),
                width: 2.4,
            }),
            RAMP_COLOR,
        )

        pushQuad(
            positions,
            colors,
            indices,
            createHorizontalQuad({
                center: new Vector3(7.2, 2, -0.6),
                width: 2.4,
                length: 7.2,
            }),
            PLATFORM_COLOR,
        )

        pushQuad(
            positions,
            colors,
            indices,
            createSlopeQuad({
                start: new Vector3(7.2, 2, 3),
                end: new Vector3(7.2, 0, 6.2),
                width: 2.4,
            }),
            RAMP_COLOR,
        )

        const geometry = new BufferGeometry()

        geometry.setAttribute(
            "position",
            new Float32BufferAttribute(positions, 3),
        )

        geometry.setAttribute("color", new Float32BufferAttribute(colors, 3))
        geometry.setIndex(indices)

        geometry.computeVertexNormals()
        geometry.computeBoundingBox()
        geometry.computeBoundingSphere()

        const material = new MeshStandardMaterial({
            vertexColors: true,
            roughness: 0.92,
            metalness: 0,
        })

        const mesh = new Mesh(geometry, material)

        mesh.name = "CozyCampusWalkableEnvironment"
        mesh.receiveShadow = true
        mesh.castShadow = false
        mesh.userData.navMeshSource = true

        mesh.updateMatrix()
        mesh.matrixAutoUpdate = false

        return mesh
    }

    build({ force = false } = {}) {
        this.assertUsable()

        if (this.result && !force) {
            return this.result
        }

        this.object3D.updateMatrixWorld(true)

        const [positions, indices] = getPositionsAndIndices(this.walkableMeshes)

        if (positions.length < 9 || indices.length < 3) {
            throw new Error("Cozy Campus has no valid navigation triangles.")
        }

        const options = this.createBuildOptions()

        const result = generateSoloNavMesh(
            {
                positions,
                indices,
            },
            options,
        )

        if (!result?.navMesh || result.navMesh.nodes.length === 0) {
            throw new Error("navcat generated an empty Cozy Campus navmesh.")
        }

        this.result = result

        return result
    }

    createBuildOptions() {
        const config = this.buildConfig

        const cellSize = requirePositiveNumber(config.cellSize, "cellSize")

        const cellHeight = requirePositiveNumber(
            config.cellHeight,
            "cellHeight",
        )

        const walkableClimbWorld = requirePositiveNumber(
            config.walkableClimbWorld,
            "walkableClimbWorld",
        )

        const detailSampleDistance =
            config.detailSampleDistanceVoxels < 0.9
                ? 0
                : cellSize * config.detailSampleDistanceVoxels

        return {
            cellSize,
            cellHeight,

            walkableRadiusWorld: this.agentRadius,
            walkableRadiusVoxels: Math.ceil(this.agentRadius / cellSize),

            walkableClimbWorld,
            walkableClimbVoxels: Math.ceil(walkableClimbWorld / cellHeight),

            walkableHeightWorld: this.agentHeight,
            walkableHeightVoxels: Math.ceil(this.agentHeight / cellHeight),

            walkableSlopeAngleDegrees: config.walkableSlopeAngleDegrees,

            borderSize: config.borderSize,

            minRegionArea: config.minRegionArea,
            mergeRegionArea: config.mergeRegionArea,

            maxSimplificationError: config.maxSimplificationError,
            maxEdgeLength: config.maxEdgeLength,
            maxVerticesPerPoly: config.maxVerticesPerPoly,

            detailSampleDistance,

            detailSampleMaxError:
                cellHeight * config.detailSampleMaxErrorVoxels,
        }
    }

    getSummary() {
        if (!this.result) {
            return null
        }

        return {
            sourceMeshCount: this.walkableMeshes.length,
            polygonCount: this.result.navMesh.nodes.length,
            tileCount: Object.keys(this.result.navMesh.tiles).length,
        }
    }

    assertUsable() {
        if (this.disposed) {
            throw new Error("CozyCampusNavMeshSource is already disposed.")
        }
    }

    dispose() {
        if (this.disposed) {
            return
        }

        this.disposed = true

        this.object3D.removeFromParent()
        this.object3D.geometry.dispose()
        this.object3D.material.dispose()

        this.walkableMeshes.length = 0
        this.walkableMeshes = null

        this.object3D = null
        this.result = null
        this.buildConfig = null
    }
}
