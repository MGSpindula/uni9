import { createNavMeshHelper } from "navcat/three"

export class NavMeshDebugView {
    constructor({ scene, navMeshWorld, visible = true, yOffset = 0.02 }) {
        if (!scene) {
            throw new TypeError("NavMeshDebugView requires a Three.js scene.")
        }

        if (!navMeshWorld) {
            throw new TypeError("NavMeshDebugView requires NavMeshWorld.")
        }

        this.scene = scene
        this.navMeshWorld = navMeshWorld
        this.visible = Boolean(visible)
        this.yOffset = yOffset

        this.helper = null
        this.object3D = null
        this.disposed = false

        this.unsubscribe = navMeshWorld.onChanged(() => {
            this.rebuild()
        })

        this.rebuild()
    }

    rebuild() {
        if (this.disposed) {
            return false
        }

        this.clearHelper()

        if (!this.navMeshWorld.ready) {
            return false
        }

        this.helper = createNavMeshHelper(this.navMeshWorld.navMesh)
        this.object3D = this.helper.object

        this.object3D.name = "NavMeshDebugView"
        this.object3D.visible = this.visible
        this.object3D.position.y += this.yOffset
        this.object3D.renderOrder = 1000

        this.scene.add(this.object3D)

        return true
    }

    setVisible(visible) {
        const nextVisible = Boolean(visible)

        if (nextVisible === this.visible) {
            return false
        }

        this.visible = nextVisible

        if (this.object3D) {
            this.object3D.visible = nextVisible
        }

        return true
    }

    clearHelper() {
        if (this.object3D) {
            this.scene.remove(this.object3D)
        }

        this.helper?.dispose?.()

        this.helper = null
        this.object3D = null
    }

    dispose() {
        if (this.disposed) {
            return
        }

        this.disposed = true

        this.unsubscribe?.()
        this.unsubscribe = null

        this.clearHelper()

        this.scene = null
        this.navMeshWorld = null
    }
}
