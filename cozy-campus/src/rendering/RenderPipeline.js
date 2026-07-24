import { PerspectiveCamera, Scene } from "three"

import { OrbitControls } from "three/addons/controls/OrbitControls.js"

import { OutlineEffect } from "./postprocessing/OutlineEffect.js"
import { PostProcessing } from "./postprocessing/PostProcessing.js"

export class RenderPipeline {
    constructor({ renderer, config, onChanged = null }) {
        if (!renderer) {
            throw new TypeError("RenderPipeline requires a Renderer.")
        }

        if (!config) {
            throw new TypeError(
                "RenderPipeline requires a configuration object.",
            )
        }

        this.renderer = renderer
        this.config = config
        this.onChanged = onChanged

        this.disposed = false
        this.controlsChanged = false

        this.scene = new Scene()

        const viewport = renderer.getViewport()

        this.camera = new PerspectiveCamera(
            config.camera.fieldOfView,

            viewport.width / viewport.height,

            config.camera.near,
            config.camera.far,
        )

        this.camera.position.set(
            config.camera.position.x,
            config.camera.position.y,
            config.camera.position.z,
        )

        this.controls = new OrbitControls(this.camera, renderer.domElement)

        this.controls.target.set(
            config.camera.target.x,
            config.camera.target.y,
            config.camera.target.z,
        )

        this.controls.enableDamping = true

        this.controls.dampingFactor = 0.08

        this.handleControlsChange = this.handleControlsChange.bind(this)

        this.controls.addEventListener("change", this.handleControlsChange)

        this.controls.update()

        this.postProcessing = new PostProcessing({
            renderer: renderer.instance,

            scene: this.scene,

            camera: this.camera,

            width: viewport.width,

            height: viewport.height,

            pixelRatio: viewport.pixelRatio,

            multisampling: renderer.multisampling,
        })

        this.outline = new OutlineEffect({
            scene: this.scene,

            camera: this.camera,

            width: viewport.width,

            height: viewport.height,

            onChanged: () => {
                this.notifyChanged()
            },
        })

        this.postProcessing.addEffect(this.outline)

        this.unsubscribeResize = renderer.onResize((nextViewport) => {
            this.handleResize(nextViewport)
        })
    }

    handleResize({ width, height, pixelRatio }) {
        this.camera.aspect = width / height

        this.camera.updateProjectionMatrix()

        this.postProcessing.setSize({
            width,
            height,
            pixelRatio,
        })

        this.notifyChanged()
    }

    handleControlsChange() {
        this.controlsChanged = true

        this.notifyChanged()
    }

    update(delta) {
        if (this.disposed) {
            return false
        }

        this.controlsChanged = false

        this.controls.update(delta)

        const effectsChanged = this.postProcessing.update(delta)

        return this.controlsChanged || effectsChanged
    }

    render(delta) {
        this.postProcessing.render(delta)
    }

    requiresContinuousRender() {
        return (
            Boolean(this.controls.enabled && this.controls.autoRotate) ||
            this.postProcessing.requiresContinuousRender()
        )
    }

    setQualityPreset(name) {
        const qualityChanged = this.renderer.setQualityPreset(name)

        const samplesChanged = this.postProcessing.setMultisampling(
            this.renderer.multisampling,
        )

        if (qualityChanged || samplesChanged) {
            this.notifyChanged()
        }

        return qualityChanged || samplesChanged
    }

    notifyChanged() {
        this.onChanged?.()
    }

    dispose() {
        if (this.disposed) {
            return
        }

        this.disposed = true

        this.unsubscribeResize?.()
        this.unsubscribeResize = null

        this.controls.removeEventListener("change", this.handleControlsChange)

        this.controls.dispose()

        this.postProcessing.dispose()

        this.scene.clear()

        this.outline = null
        this.postProcessing = null
        this.controls = null
        this.camera = null
        this.scene = null

        this.renderer = null
        this.config = null
        this.onChanged = null
    }
}
