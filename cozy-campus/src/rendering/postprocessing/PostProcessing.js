import { WebGLRenderTarget } from "three"

import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js"
import { OutputPass } from "three/addons/postprocessing/OutputPass.js"
import { RenderPass } from "three/addons/postprocessing/RenderPass.js"

export class PostProcessing {
    constructor({
        renderer,
        scene,
        camera,
        width = 1,
        height = 1,
        pixelRatio = 1,
        multisampling = 0,
    }) {
        if (!renderer) {
            throw new TypeError("PostProcessing requires a WebGLRenderer.")
        }

        if (!scene || !camera) {
            throw new TypeError("PostProcessing requires a scene and camera.")
        }

        this.renderer = renderer
        this.scene = scene
        this.camera = camera

        this.width = width
        this.height = height
        this.pixelRatio = pixelRatio

        this.multisampling = this.normalizeSamples(multisampling)

        this.effects = []
        this.effectSet = new Set()

        this.renderPass = new RenderPass(scene, camera)

        this.outputPass = new OutputPass()

        this.composer = null
        this.disposed = false

        this.createComposer()
    }

    createComposer() {
        const renderTarget = new WebGLRenderTarget(1, 1)

        renderTarget.samples = this.multisampling

        this.composer = new EffectComposer(this.renderer, renderTarget)

        this.composer.setPixelRatio(this.pixelRatio)

        this.composer.setSize(this.width, this.height)

        this.composer.addPass(this.renderPass)

        for (let index = 0; index < this.effects.length; index += 1) {
            this.composer.addPass(this.effects[index].pass)
        }

        this.composer.addPass(this.outputPass)
    }

    rebuildComposer() {
        this.composer?.dispose()
        this.composer = null

        this.createComposer()
    }

    addEffect(effect) {
        if (!effect?.pass) {
            throw new TypeError("PostProcessing.addEffect requires an Effect.")
        }

        if (this.effectSet.has(effect)) {
            return effect
        }

        this.effectSet.add(effect)

        this.effects.push(effect)

        const outputIndex = this.composer.passes.indexOf(this.outputPass)

        this.composer.insertPass(
            effect.pass,

            Math.max(1, outputIndex),
        )

        return effect
    }

    removeEffect(effect, { dispose = true } = {}) {
        if (!this.effectSet.has(effect)) {
            return false
        }

        this.effectSet.delete(effect)

        const index = this.effects.indexOf(effect)

        if (index !== -1) {
            this.effects.splice(index, 1)
        }

        this.composer.removePass(effect.pass)

        if (dispose) {
            effect.dispose()
        }

        return true
    }

    update(delta) {
        let changed = false

        for (let index = 0; index < this.effects.length; index += 1) {
            if (this.effects[index].update(delta)) {
                changed = true
            }
        }

        return changed
    }

    render(delta) {
        if (this.hasActiveEffects()) {
            this.composer.render(delta)

            return
        }

        this.renderer.render(this.scene, this.camera)
    }

    hasActiveEffects() {
        for (let index = 0; index < this.effects.length; index += 1) {
            if (this.effects[index].requiresPostProcessing()) {
                return true
            }
        }

        return false
    }

    requiresContinuousRender() {
        for (let index = 0; index < this.effects.length; index += 1) {
            if (this.effects[index].requiresContinuousRender()) {
                return true
            }
        }

        return false
    }

    setSize({ width, height, pixelRatio }) {
        this.width = Math.max(1, Math.round(width))

        this.height = Math.max(1, Math.round(height))

        this.pixelRatio = Math.max(0.5, Number(pixelRatio) || 1)

        this.composer.setPixelRatio(this.pixelRatio)

        this.composer.setSize(this.width, this.height)
    }

    setMultisampling(samples) {
        const nextSamples = this.normalizeSamples(samples)

        if (nextSamples === this.multisampling) {
            return false
        }

        this.multisampling = nextSamples

        this.rebuildComposer()

        return true
    }

    normalizeSamples(samples) {
        const numericSamples = Number(samples)

        if (!Number.isFinite(numericSamples)) {
            return 0
        }

        return Math.max(0, Math.floor(numericSamples))
    }

    dispose() {
        if (this.disposed) {
            return
        }

        this.disposed = true

        this.composer?.dispose()
        this.composer = null

        for (let index = this.effects.length - 1; index >= 0; index -= 1) {
            this.effects[index].dispose()
        }

        this.effects.length = 0
        this.effectSet.clear()

        this.renderPass.dispose?.()

        this.outputPass.dispose?.()

        this.renderPass = null
        this.outputPass = null

        this.renderer = null
        this.scene = null
        this.camera = null
    }
}
