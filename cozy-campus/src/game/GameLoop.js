export class GameLoop {
    constructor({ game, config, measurePerformance = false }) {
        if (!game) {
            throw new TypeError("GameLoop requires a Game.")
        }

        this.game = game
        this.config = config

        this.measurePerformance = Boolean(measurePerformance)
        this.collectMetrics = false

        this.running = false
        this.animationFrameId = null
        this.previousTime = 0

        this.context = {
            game,
            world: null,
            services: game.services,
            camera: game.renderPipeline.camera,
            delta: 0,
        }

        this.metrics = {
            delta: 0,
            frame: 0,
            update: 0,
            render: 0,
            rendered: false,

            phases: {
                input: 0,
                controllers: 0,
                navigation: 0,
                entities: 0,
            },
        }

        this.frame = this.frame.bind(this)

        this.handleVisibilityChange = this.handleVisibilityChange.bind(this)

        document.addEventListener(
            "visibilitychange",
            this.handleVisibilityChange,
        )
    }

    start() {
        if (this.running) {
            return
        }

        this.running = true
        this.previousTime = performance.now()

        this.animationFrameId = requestAnimationFrame(this.frame)
    }

    stop() {
        if (!this.running) {
            return
        }

        this.running = false

        if (this.animationFrameId !== null) {
            cancelAnimationFrame(this.animationFrameId)

            this.animationFrameId = null
        }
    }

    frame(now) {
        if (!this.running) {
            return
        }

        if (this.config.pauseWhenHidden && document.hidden) {
            this.previousTime = now

            this.animationFrameId = requestAnimationFrame(this.frame)

            return
        }

        const elapsed = Math.max(0, (now - this.previousTime) / 1000)

        const delta = Math.min(elapsed, this.config.maxDelta)

        this.previousTime = now

        const performancePanel = this.game.performanceDebugPanel

        this.collectMetrics =
            this.measurePerformance || Boolean(performancePanel)

        const frameStarted = this.collectMetrics ? performance.now() : 0

        const updateStarted = this.collectMetrics ? performance.now() : 0

        this.update(delta)

        if (this.collectMetrics) {
            this.metrics.update = performance.now() - updateStarted
        }

        const shouldRender =
            this.game.renderRequested || this.game.hasContinuousVisualActivity()

        if (shouldRender) {
            const renderStarted = this.collectMetrics ? performance.now() : 0

            this.game.render(delta)

            if (this.collectMetrics) {
                this.metrics.render = performance.now() - renderStarted
            }
        } else if (this.collectMetrics) {
            this.metrics.render = 0
        }

        this.metrics.delta = delta
        this.metrics.rendered = shouldRender

        if (this.collectMetrics) {
            const frameEnded = performance.now()

            this.metrics.frame = frameEnded - frameStarted

            performancePanel?.record({
                now: frameEnded,

                frame: this.metrics.frame,
                update: this.metrics.update,
                render: this.metrics.render,

                rendered: this.metrics.rendered,

                phases: this.metrics.phases,
            })
        }

        this.animationFrameId = requestAnimationFrame(this.frame)
    }

    update(delta) {
        this.resetPhaseMetrics()

        const game = this.game
        const world = game.world

        if (!world) {
            return
        }

        const services = game.services
        const renderPipeline = game.renderPipeline

        this.context.world = world
        this.context.delta = delta

        let phaseStarted = this.startPhase()

        services.selection.update()

        if (renderPipeline.update(delta)) {
            game.requestRender()
        }

        this.finishPhase("input", phaseStarted)

        phaseStarted = this.startPhase()

        world.updateControllers(delta, this.context)

        this.finishPhase("controllers", phaseStarted)

        phaseStarted = this.startPhase()

        services.update(delta)

        this.finishPhase("navigation", phaseStarted)

        phaseStarted = this.startPhase()

        world.updateEntities(delta, this.context)

        this.finishPhase("entities", phaseStarted)

        if (world.requiresContinuousRender()) {
            game.requestRender()
        }
    }

    startPhase() {
        return this.collectMetrics ? performance.now() : 0
    }

    finishPhase(name, started) {
        if (!this.collectMetrics) {
            return
        }

        this.metrics.phases[name] = performance.now() - started
    }

    resetPhaseMetrics() {
        const phases = this.metrics.phases

        phases.input = 0
        phases.controllers = 0
        phases.navigation = 0
        phases.entities = 0
    }

    handleVisibilityChange() {
        this.previousTime = performance.now()

        if (!document.hidden) {
            this.game.requestRender()

            this.game.performanceDebugPanel?.resetSampling()
        }
    }

    dispose() {
        this.stop()

        document.removeEventListener(
            "visibilitychange",
            this.handleVisibilityChange,
        )
    }
}
