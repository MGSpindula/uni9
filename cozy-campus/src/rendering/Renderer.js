import { PCFShadowMap, WebGLRenderer } from "three"

export class Renderer {
    constructor({ mount, config }) {
        if (!(mount instanceof HTMLElement)) {
            throw new TypeError("Renderer requires a valid mount element.")
        }

        if (!config) {
            throw new TypeError("Renderer requires a configuration object.")
        }

        this.mount = mount
        this.config = config

        this.width = 1
        this.height = 1
        this.pixelRatio = 1

        this.qualityPresetName = null
        this.qualityPreset = null

        this.resizeListeners = new Set()

        this.resizeObserver = null
        this.disposed = false

        this.instance = new WebGLRenderer({
            antialias: true,
            alpha: config.clearAlpha < 1,

            depth: true,
            stencil: false,

            preserveDrawingBuffer: false,

            powerPreference: config.powerPreference ?? "high-performance",
        })

        this.instance.setClearColor(config.clearColor, config.clearAlpha)

        this.instance.shadowMap.type = PCFShadowMap

        this.instance.domElement.setAttribute("aria-label", "Cozy Campus")

        this.mount.appendChild(this.instance.domElement)

        this.handleWindowResize = this.handleWindowResize.bind(this)

        this.setQualityPreset(config.qualityPreset)

        this.observeMount()
        this.resize()
    }

    observeMount() {
        if (typeof ResizeObserver === "function") {
            this.resizeObserver = new ResizeObserver((entries) => {
                const entry = entries[0]

                if (!entry) {
                    return
                }

                this.resize(
                    entry.contentRect.width,

                    entry.contentRect.height,
                )
            })

            this.resizeObserver.observe(this.mount)

            return
        }

        window.addEventListener("resize", this.handleWindowResize)
    }

    handleWindowResize() {
        this.resize()
    }

    resize(width = null, height = null) {
        if (this.disposed) {
            return false
        }

        const size = this.resolveSize(width, height)

        const nextPixelRatio = this.resolvePixelRatio()

        const sizeChanged =
            size.width !== this.width || size.height !== this.height

        const pixelRatioChanged = nextPixelRatio !== this.pixelRatio

        if (!sizeChanged && !pixelRatioChanged) {
            return false
        }

        this.width = size.width
        this.height = size.height

        this.pixelRatio = nextPixelRatio

        this.instance.setPixelRatio(this.pixelRatio)

        this.instance.setSize(this.width, this.height, false)

        this.notifyResize()

        return true
    }

    resolveSize(width, height) {
        let resolvedWidth = Number(width)

        let resolvedHeight = Number(height)

        if (
            !Number.isFinite(resolvedWidth) ||
            !Number.isFinite(resolvedHeight) ||
            resolvedWidth <= 0 ||
            resolvedHeight <= 0
        ) {
            const bounds = this.mount.getBoundingClientRect()

            resolvedWidth =
                bounds.width || this.mount.clientWidth || window.innerWidth || 1

            resolvedHeight =
                bounds.height ||
                this.mount.clientHeight ||
                window.innerHeight ||
                1
        }

        return {
            width: Math.max(1, Math.round(resolvedWidth)),

            height: Math.max(1, Math.round(resolvedHeight)),
        }
    }

    resolvePixelRatio() {
        const devicePixelRatio = window.devicePixelRatio || 1

        const limit = this.qualityPreset?.pixelRatio ?? 1

        return Math.max(0.5, Math.min(devicePixelRatio, limit))
    }

    setQualityPreset(name) {
        const preset = this.config.qualityPresets?.[name]

        if (!preset) {
            throw new RangeError(`Unknown render quality preset: "${name}".`)
        }

        if (this.qualityPresetName === name) {
            return false
        }

        this.qualityPresetName = name

        this.qualityPreset = preset

        this.instance.shadowMap.enabled = Boolean(preset.shadows)

        this.resize()

        return true
    }

    onResize(listener, { immediate = true } = {}) {
        if (typeof listener !== "function") {
            throw new TypeError("Renderer.onResize requires a function.")
        }

        this.resizeListeners.add(listener)

        if (immediate) {
            listener(this.getViewport())
        }

        return () => {
            this.resizeListeners.delete(listener)
        }
    }

    notifyResize() {
        const viewport = this.getViewport()

        for (const listener of this.resizeListeners) {
            listener(viewport)
        }
    }

    getViewport() {
        return {
            width: this.width,
            height: this.height,
            pixelRatio: this.pixelRatio,
        }
    }

    get multisampling() {
        return Math.max(0, Math.floor(this.qualityPreset?.multisampling ?? 0))
    }

    get shadowsEnabled() {
        return this.instance.shadowMap.enabled
    }

    get domElement() {
        return this.instance.domElement
    }

    render(scene, camera) {
        this.instance.render(scene, camera)
    }

    dispose() {
        if (this.disposed) {
            return
        }

        this.disposed = true

        this.resizeObserver?.disconnect()

        this.resizeObserver = null

        window.removeEventListener("resize", this.handleWindowResize)

        this.resizeListeners.clear()

        this.instance.renderLists?.dispose?.()

        this.instance.dispose()

        this.instance.forceContextLoss?.()

        this.instance.domElement.remove()

        this.mount = null
        this.config = null
    }
}
