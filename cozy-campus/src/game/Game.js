import { DebugOverlay, DEBUG_REGIONS } from "../debug/DebugOverlay.js"
import { PerformanceDebugPanel } from "../debug/PerformanceDebugPanel.js"
import { RenderPipeline } from "../rendering/RenderPipeline.js"
import { GameLoop } from "./GameLoop.js"
import { GameServices } from "./GameServices.js"

export class Game {
    constructor({ renderer, config, level }) {
        if (!renderer) {
            throw new TypeError("Game requires a Renderer.")
        }

        if (!config) {
            throw new TypeError("Game requires a configuration object.")
        }

        if (!level) {
            throw new TypeError("Game requires an initial Level.")
        }

        this.renderer = renderer
        this.config = config

        this.initialLevel = level
        this.level = null
        this.world = null

        this.started = false
        this.disposed = false
        this.loadingLevel = false
        this.startPromise = null

        this.renderRequested = true
        this.debugOverlay = null
        this.performanceDebugPanel = null

        this.renderPipeline = new RenderPipeline({
            renderer,
            config: config.render,
            onChanged: () => {
                this.requestRender()
            },
        })

        this.services = new GameServices({
            camera: this.renderPipeline.camera,

            element: renderer.domElement,

            config,

            requestRender: () => {
                this.requestRender()
            },
        })

        if (this.renderPipeline.outline) {
            this.services.selection.addEffect(this.renderPipeline.outline)
        }

        this.loop = new GameLoop({
            game: this,
            config: config.loop,
            measurePerformance: config.debug.measurePerformance,
        })

        if (config.debug.enabled) {
            this.debugOverlay = new DebugOverlay({
                visible: config.debug.visible,
            })
        }

        if (config.debug.performanceVisible) {
            this.createPerformanceDebug({
                mode: config.debug.performanceMode,
            })
        }
    }

    async start() {
        if (this.disposed) {
            throw new Error("Cannot start a disposed Game.")
        }

        if (this.started) {
            return this
        }

        if (this.startPromise) {
            return this.startPromise
        }

        this.startPromise = this.startInternal()

        try {
            return await this.startPromise
        } finally {
            this.startPromise = null
        }
    }

    async startInternal() {
        await this.loadLevel(this.initialLevel)

        this.initialLevel = null

        if (this.disposed) {
            return this
        }

        this.loop.start()
        this.started = true

        return this
    }

    async loadLevel(level) {
        if (this.disposed) {
            throw new Error("Cannot load a level into a disposed Game.")
        }

        if (!level || typeof level.load !== "function") {
            throw new TypeError("A level must implement load(game).")
        }

        if (this.loadingLevel) {
            throw new Error("Another level is already loading.")
        }

        const resumeLoop = this.loop.running

        this.loadingLevel = true
        this.loop.stop()

        this.unloadLevel()

        let world = null

        try {
            world = await level.load(this)

            this.validateWorld(world, level)

            if (this.disposed) {
                world.dispose?.()
                level.unload?.(this)

                return null
            }

            this.level = level
            this.world = world

            this.requestRender()

            if (resumeLoop) {
                this.loop.start()
            }

            return world
        } catch (error) {
            world?.dispose?.()

            try {
                level.unload?.(this)
            } finally {
                this.services.resetLevel()
            }

            if (resumeLoop && !this.disposed) {
                this.loop.start()
            }

            throw error
        } finally {
            this.loadingLevel = false
        }
    }

    validateWorld(world, level) {
        if (!world) {
            throw new Error(
                `Level "${level.id ?? "unknown"}" did not return a World.`,
            )
        }

        if (typeof world.dispose !== "function") {
            throw new TypeError("A World must implement dispose().")
        }

        if (
            typeof world.updateControllers !== "function" ||
            typeof world.updateEntities !== "function"
        ) {
            throw new TypeError("A World must implement its update lifecycle.")
        }
    }

    unloadLevel() {
        const previousWorld = this.world

        const previousLevel = this.level

        this.world = null
        this.level = null

        previousWorld?.dispose()

        try {
            previousLevel?.unload?.(this)
        } finally {
            this.services.resetLevel()
        }
    }

    createPerformanceDebug({
        mode = this.config.debug.performanceMode ?? "compact",
    } = {}) {
        if (this.performanceDebugPanel) {
            this.performanceDebugPanel.setMode(mode)

            this.performanceDebugPanel.setVisible(true)

            return this.performanceDebugPanel
        }

        const mount =
            this.debugOverlay?.getRegion(DEBUG_REGIONS.RIGHT) ?? document.body

        this.performanceDebugPanel = new PerformanceDebugPanel({
            game: this,
            mount,
            mode,
            visible: true,

            refreshInterval:
                this.config.debug.performanceRefreshInterval ?? 500,
        })

        return this.performanceDebugPanel
    }

    setDebugVisible(visible) {
        if (!this.debugOverlay) {
            return false
        }

        return this.debugOverlay.setVisible(visible)
    }

    toggleDebugVisible() {
        if (!this.debugOverlay) {
            return false
        }

        return this.debugOverlay.toggle()
    }

    disposePerformanceDebug() {
        this.performanceDebugPanel?.dispose()

        this.performanceDebugPanel = null
    }

    setPerformanceDebugVisible(visible) {
        const nextVisible = Boolean(visible)

        if (nextVisible) {
            this.createPerformanceDebug()
        } else {
            this.disposePerformanceDebug()
        }

        return nextVisible
    }

    setPerformanceDebugMode(mode) {
        const panel = this.createPerformanceDebug({
            mode,
        })

        return panel.mode
    }

    togglePerformanceDebugMode() {
        return this.createPerformanceDebug().toggleMode()
    }

    requestRender() {
        this.renderRequested = true
    }

    clearRenderRequest() {
        this.renderRequested = false
    }

    hasContinuousVisualActivity() {
        return (
            this.renderPipeline.requiresContinuousRender() ||
            this.world?.requiresContinuousRender() ||
            false
        )
    }

    render(delta) {
        this.renderPipeline.render(delta)
        this.clearRenderRequest()
    }

    setQualityPreset(name) {
        this.renderPipeline.setQualityPreset(name)

        this.requestRender()
    }

    stop() {
        this.loop.stop()
        this.started = false
    }

    dispose() {
        if (this.disposed) {
            return
        }

        this.disposed = true
        this.started = false

        this.loop.dispose()

        this.disposePerformanceDebug()

        this.unloadLevel()

        this.debugOverlay?.dispose()
        this.debugOverlay = null

        this.services.dispose()
        this.renderPipeline.dispose()
    }

    get scene() {
        return this.renderPipeline.scene
    }

    get camera() {
        return this.renderPipeline.camera
    }

    get controls() {
        return this.renderPipeline.controls
    }

    get navigation() {
        return this.services.navigation
    }

    get selection() {
        return this.services.selection
    }

    get registry() {
        return this.services.registry
    }
}
