const DEBUG_REGIONS = Object.freeze({
    LEFT: "left",
    RIGHT: "right",
})

export class DebugOverlay {
    constructor({ visible = true, shortcut = "F3" } = {}) {
        this.visible = Boolean(visible)
        this.shortcut = shortcut

        this.disposed = false

        this.handleClick = this.handleClick.bind(this)

        this.handleKeyDown = this.handleKeyDown.bind(this)

        this.element = this.createElement()

        this.regions = {
            [DEBUG_REGIONS.LEFT]: this.element.querySelector(
                '[data-region="left"]',
            ),

            [DEBUG_REGIONS.RIGHT]: this.element.querySelector(
                '[data-region="right"]',
            ),
        }

        this.toggleButton = this.element.querySelector(
            '[data-action="toggle-debug"]',
        )

        this.element.addEventListener("click", this.handleClick)

        window.addEventListener("keydown", this.handleKeyDown)

        document.body.appendChild(this.element)

        this.setVisible(this.visible)
    }

    createElement() {
        const element = document.createElement("div")

        element.className = "debug-overlay"

        element.innerHTML = `
            <div class="debug-overlay__content">
                <div
                    class="debug-overlay__region debug-overlay__region--left"
                    data-region="left"
                ></div>

                <div
                    class="debug-overlay__region debug-overlay__region--right"
                    data-region="right"
                ></div>
            </div>

            <div class="debug-overlay__toolbar">
                <button
                    type="button"
                    data-action="toggle-debug"
                    aria-pressed="false"
                    title="Toggle debug (${this.shortcut})"
                >
                    Hide debug
                </button>
            </div>
        `

        return element
    }

    getRegion(name) {
        const region = this.regions[name]

        if (!region) {
            throw new RangeError(`Unknown debug region: "${name}".`)
        }

        return region
    }

    setVisible(visible) {
        const nextVisible = Boolean(visible)

        this.visible = nextVisible

        this.element.dataset.hidden = String(!nextVisible)

        this.toggleButton.textContent = nextVisible
            ? "Hide debug"
            : "Show debug"

        this.toggleButton.setAttribute("aria-pressed", String(!nextVisible))

        return this.visible
    }

    toggle() {
        return this.setVisible(!this.visible)
    }

    handleClick(event) {
        if (!(event.target instanceof Element)) {
            return
        }

        const button = event.target.closest('[data-action="toggle-debug"]')

        if (!button || !this.element.contains(button)) {
            return
        }

        this.toggle()
    }

    handleKeyDown(event) {
        if (event.key !== this.shortcut || event.repeat) {
            return
        }

        event.preventDefault()

        this.toggle()
    }

    dispose() {
        if (this.disposed) {
            return
        }

        this.disposed = true

        this.element.removeEventListener("click", this.handleClick)

        window.removeEventListener("keydown", this.handleKeyDown)

        this.element.remove()

        this.regions = null
        this.toggleButton = null
        this.element = null
    }
}

export { DEBUG_REGIONS }

// Também será possível controlar pelo console:
// cozyCampus.game.toggleDebugVisible()
// cozyCampus.game.setDebugVisible(false)
// cozyCampus.game.setDebugVisible(true)
// A estrutura passa a suportar outros painéis sem criar novas posições fixas:
// game.debugOverlay.getRegion("left")
// game.debugOverlay.getRegion("right")