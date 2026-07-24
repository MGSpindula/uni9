const PERFORMANCE_MODES = Object.freeze({
    COMPACT: "compact",
    EXTENDED: "extended",
})

const PHASE_NAMES = Object.freeze([
    "input",
    "controllers",
    "navigation",
    "entities",
])

const INTEGER_FORMATTER = new Intl.NumberFormat("pt-BR")

function normalizeMode(mode) {
    if (mode === PERFORMANCE_MODES.COMPACT) {
        return mode
    }

    if (mode === PERFORMANCE_MODES.EXTENDED) {
        return mode
    }

    throw new RangeError(`Unknown performance debug mode: "${mode}".`)
}

function formatMilliseconds(value, digits = 2) {
    if (!Number.isFinite(value)) {
        return "--"
    }

    return `${value.toFixed(digits)} ms`
}

function formatMegabytes(bytes) {
    if (!Number.isFinite(bytes)) {
        return "n/a"
    }

    return `${(bytes / 1048576).toFixed(1)} MB`
}

export class PerformanceDebugPanel {
    constructor({
        game,
        mount = document.body,
        mode = PERFORMANCE_MODES.COMPACT,
        visible = true,
        refreshInterval = 500,
    } = {}) {
        if (!game) {
            throw new TypeError("PerformanceDebugPanel requires a Game.")
        }

        if (!(mount instanceof HTMLElement)) {
            throw new TypeError(
                "PerformanceDebugPanel requires a valid mount element.",
            )
        }

        if (!Number.isFinite(refreshInterval) || refreshInterval <= 0) {
            throw new RangeError(
                "PerformanceDebugPanel refreshInterval must be greater than zero.",
            )
        }

        this.game = game
        this.mount = mount
        this.mode = normalizeMode(mode)
        this.refreshInterval = refreshInterval

        this.visible = Boolean(visible)
        this.disposed = false

        this.lastRefresh = performance.now()

        this.frames = 0
        this.renderedFrames = 0

        this.frameTime = 0
        this.updateTime = 0
        this.renderTime = 0
        this.maximumFrameTime = 0

        this.phaseTotals = {
            input: 0,
            controllers: 0,
            navigation: 0,
            entities: 0,
        }

        this.latestRenderStats = {
            calls: 0,
            triangles: 0,
            geometries: 0,
            textures: 0,
        }

        this.handleClick = this.handleClick.bind(this)

        this.element = this.createElement()
        this.values = this.collectValues()

        this.element.addEventListener("click", this.handleClick)

        this.mount.appendChild(this.element)

        this.setMode(this.mode)
        this.setVisible(this.visible)
    }

    createElement() {
        const element = document.createElement("aside")

        element.className = "debug-panel performance-debug"

        element.setAttribute("aria-label", "Performance debug")

        element.innerHTML = `
            <div class="performance-debug__header">
                <strong>Performance</strong>

                <button
                    type="button"
                    data-action="toggle-mode"
                    aria-label="Toggle performance details"
                >
                    Expand
                </button>
            </div>

            <span class="performance-debug__fps" data-value="fps">
                -- FPS
            </span>

            <dl>
                <dt>Frame</dt>
                <dd data-value="frame">--</dd>

                <dt>Update</dt>
                <dd data-value="update">--</dd>

                <dt>Render</dt>
                <dd data-value="render">--</dd>

                <dt>Calls</dt>
                <dd data-value="calls">--</dd>

                <dt>Triangles</dt>
                <dd data-value="triangles">--</dd>

                <dt data-detail="extended">Rendered</dt>
                <dd data-detail="extended" data-value="rendered">--</dd>

                <dt data-detail="extended">Worst</dt>
                <dd data-detail="extended" data-value="worst">--</dd>

                <dt data-detail="extended">Input</dt>
                <dd data-detail="extended" data-value="phase-input">--</dd>

                <dt data-detail="extended">Controllers</dt>
                <dd
                    data-detail="extended"
                    data-value="phase-controllers"
                >
                    --
                </dd>

                <dt data-detail="extended">Navigation</dt>
                <dd
                    data-detail="extended"
                    data-value="phase-navigation"
                >
                    --
                </dd>

                <dt data-detail="extended">Entities</dt>
                <dd
                    data-detail="extended"
                    data-value="phase-entities"
                >
                    --
                </dd>

                <dt data-detail="extended">World</dt>
                <dd data-detail="extended" data-value="world">--</dd>

                <dt data-detail="extended">Agents</dt>
                <dd data-detail="extended" data-value="agents">--</dd>

                <dt data-detail="extended">Navmesh</dt>
                <dd data-detail="extended" data-value="navmesh">--</dd>

                <dt data-detail="extended">GPU mem.</dt>
                <dd
                    data-detail="extended"
                    data-value="gpu-memory"
                >
                    --
                </dd>

                <dt data-detail="extended">JS heap</dt>
                <dd
                    data-detail="extended"
                    data-value="js-memory"
                >
                    n/a
                </dd>

                <dt data-detail="extended">Viewport</dt>
                <dd
                    data-detail="extended"
                    data-value="viewport"
                >
                    --
                </dd>
            </dl>
        `

        return element
    }

    collectValues() {
        const values = new Map()

        for (const element of this.element.querySelectorAll("[data-value]")) {
            values.set(element.dataset.value, element)
        }

        return values
    }

    record({ now, frame, update, render, rendered = false, phases = null }) {
        if (this.disposed || !this.visible) {
            return
        }

        this.frames += 1

        this.frameTime += frame
        this.updateTime += update
        this.renderTime += render

        this.maximumFrameTime = Math.max(this.maximumFrameTime, frame)

        if (rendered) {
            this.renderedFrames += 1

            this.captureRenderStats()
        }

        if (phases) {
            for (const name of PHASE_NAMES) {
                this.phaseTotals[name] += phases[name] ?? 0
            }
        }

        const elapsed = now - this.lastRefresh

        if (elapsed < this.refreshInterval) {
            return
        }

        this.refresh(now, elapsed)
    }

    captureRenderStats() {
        const info = this.game.renderer.instance.info

        this.latestRenderStats.calls = info.render.calls
        this.latestRenderStats.triangles = info.render.triangles

        this.latestRenderStats.geometries = info.memory.geometries
        this.latestRenderStats.textures = info.memory.textures
    }

    refresh(now, elapsed) {
        const divisor = Math.max(1, this.frames)

        const averageFrame = this.frameTime / divisor
        const averageUpdate = this.updateTime / divisor
        const averageRender = this.renderTime / divisor

        this.set(
            "fps",
            `${Math.round((this.frames * 1000) / Math.max(1, elapsed))} FPS`,
        )

        this.set("frame", formatMilliseconds(averageFrame))
        this.set("update", formatMilliseconds(averageUpdate))
        this.set("render", formatMilliseconds(averageRender))

        this.set(
            "calls",
            INTEGER_FORMATTER.format(this.latestRenderStats.calls),
        )

        this.set(
            "triangles",
            INTEGER_FORMATTER.format(this.latestRenderStats.triangles),
        )

        this.set("rendered", `${this.renderedFrames}/${this.frames} frames`)

        this.set("worst", formatMilliseconds(this.maximumFrameTime))

        for (const name of PHASE_NAMES) {
            this.set(
                `phase-${name}`,
                formatMilliseconds(this.phaseTotals[name] / divisor, 3),
            )
        }

        this.refreshRuntimeCounts()
        this.refreshMemory()
        this.refreshViewport()

        this.element.dataset.level =
            averageFrame > 25 ? "slow" : averageFrame > 17 ? "warning" : "good"

        this.lastRefresh = now

        this.frames = 0
        this.renderedFrames = 0

        this.frameTime = 0
        this.updateTime = 0
        this.renderTime = 0
        this.maximumFrameTime = 0

        for (const name of PHASE_NAMES) {
            this.phaseTotals[name] = 0
        }
    }

    refreshRuntimeCounts() {
        const world = this.game.world

        this.set(
            "world",
            world
                ? `${world.entities.length} ent / ` +
                      `${world.characters.length} char / ` +
                      `${world.controllers.length} ctrl`
                : "--",
        )

        const agentCount = this.game.services.crowdNavigation.states.size

        this.set("agents", INTEGER_FORMATTER.format(agentCount))

        const navMesh = this.game.services.navMeshWorld.navMesh

        if (!navMesh) {
            this.set("navmesh", "--")

            return
        }

        const polygonCount = navMesh.nodes?.length ?? 0
        const tileCount = Object.keys(navMesh.tiles ?? {}).length

        this.set("navmesh", `${polygonCount} poly / ${tileCount} tile`)
    }

    refreshMemory() {
        this.set(
            "gpu-memory",
            `${this.latestRenderStats.geometries} geo / ` +
                `${this.latestRenderStats.textures} tex`,
        )

        this.set(
            "js-memory",
            formatMegabytes(performance.memory?.usedJSHeapSize),
        )
    }

    refreshViewport() {
        const renderer = this.game.renderer
        const viewport = renderer.getViewport()

        this.set(
            "viewport",
            `${renderer.domElement.width}×${renderer.domElement.height} ` +
                `@${viewport.pixelRatio.toFixed(2)}`,
        )
    }

    set(name, value) {
        const element = this.values.get(name)

        if (element) {
            element.textContent = String(value)
        }
    }

    setMode(mode) {
        const nextMode = normalizeMode(mode)

        this.mode = nextMode

        const extended = nextMode === PERFORMANCE_MODES.EXTENDED

        this.element.classList.toggle("performance-debug--compact", !extended)

        this.element.classList.toggle("performance-debug--extended", extended)

        const button = this.element.querySelector('[data-action="toggle-mode"]')

        if (button) {
            button.textContent = extended ? "Compact" : "Expand"
            button.setAttribute("aria-expanded", String(extended))
        }

        return this.mode
    }

    toggleMode() {
        return this.setMode(
            this.mode === PERFORMANCE_MODES.COMPACT
                ? PERFORMANCE_MODES.EXTENDED
                : PERFORMANCE_MODES.COMPACT,
        )
    }

    setVisible(visible) {
        this.visible = Boolean(visible)
        this.element.hidden = !this.visible

        if (this.visible) {
            this.resetSampling()
        }

        return this.visible
    }

    resetSampling() {
        this.lastRefresh = performance.now()

        this.frames = 0
        this.renderedFrames = 0

        this.frameTime = 0
        this.updateTime = 0
        this.renderTime = 0
        this.maximumFrameTime = 0

        for (const name of PHASE_NAMES) {
            this.phaseTotals[name] = 0
        }
    }

    handleClick(event) {
        if (!(event.target instanceof Element)) {
            return
        }

        const button = event.target.closest('[data-action="toggle-mode"]')

        if (!button || !this.element.contains(button)) {
            return
        }

        this.toggleMode()
    }

    dispose() {
        if (this.disposed) {
            return
        }

        this.disposed = true

        this.element.removeEventListener("click", this.handleClick)
        this.element.remove()

        this.values.clear()

        this.values = null
        this.element = null
        this.game = null
        this.mount = null
    }
}

// Possível de usar no console do navegador para depuração de performance:
// cozyCampus.game.togglePerformanceDebugMode()
// cozyCampus.game.setPerformanceDebugMode(
//     "extended",
// )
// cozyCampus.game.setPerformanceDebugMode(
//     "compact",
// )
// cozyCampus.game.setPerformanceDebugVisible(
//     false,
// )
// cozyCampus.game.setPerformanceDebugVisible(
//     true,
// )
