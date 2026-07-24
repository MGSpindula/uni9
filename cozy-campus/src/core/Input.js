import { Vector2 } from "three"

const CLICK_DISTANCE_SQUARED = 36

const CLICK_MAX_DURATION = 0.5

export class Input {
    constructor({ element }) {
        if (!(element instanceof HTMLElement)) {
            throw new TypeError("Input requires a valid HTML element.")
        }

        this.element = element

        this.enabled = true
        this.disposed = false

        this.pointer = new Vector2()

        this.primaryActionPointer = new Vector2()

        this.clientX = 0
        this.clientY = 0

        this.pointerInside = false
        this.primaryDown = false

        this.pointerVersion = 0

        this.primaryActionVersion = 0

        this.activePointerId = null

        this.pointerDownX = 0
        this.pointerDownY = 0
        this.pointerDownTime = 0

        this.bounds = null
        this.boundsDirty = true

        this.resizeObserver = null

        this.handlePointerEnter = this.handlePointerEnter.bind(this)

        this.handlePointerMove = this.handlePointerMove.bind(this)

        this.handlePointerLeave = this.handlePointerLeave.bind(this)

        this.handlePointerDown = this.handlePointerDown.bind(this)

        this.handlePointerUp = this.handlePointerUp.bind(this)

        this.handlePointerCancel = this.handlePointerCancel.bind(this)

        this.handleWindowResize = this.handleWindowResize.bind(this)

        this.addListeners()
        this.observeElement()
    }

    addListeners() {
        this.element.addEventListener("pointerenter", this.handlePointerEnter)

        this.element.addEventListener("pointermove", this.handlePointerMove)

        this.element.addEventListener("pointerleave", this.handlePointerLeave)

        this.element.addEventListener("pointerdown", this.handlePointerDown)

        this.element.addEventListener("pointerup", this.handlePointerUp)

        this.element.addEventListener("pointercancel", this.handlePointerCancel)
    }

    observeElement() {
        if (typeof ResizeObserver === "function") {
            this.resizeObserver = new ResizeObserver(() => {
                this.invalidateBounds()
            })

            this.resizeObserver.observe(this.element)

            return
        }

        window.addEventListener("resize", this.handleWindowResize)
    }

    handleWindowResize() {
        this.invalidateBounds()
    }

    handlePointerEnter(event) {
        if (!this.enabled) {
            return
        }

        this.pointerInside = true

        this.updatePointer(event)
    }

    handlePointerMove(event) {
        if (!this.enabled) {
            return
        }

        this.pointerInside = true

        this.updatePointer(event)
    }

    handlePointerLeave() {
        if (!this.pointerInside) {
            return
        }

        this.pointerInside = false
        this.pointerVersion += 1
    }

    handlePointerDown(event) {
        if (!this.enabled || event.button !== 0) {
            return
        }

        this.pointerInside = true

        this.updatePointer(event)

        this.primaryDown = true

        this.activePointerId = event.pointerId

        this.element.setPointerCapture?.(event.pointerId)

        this.pointerDownX = event.clientX

        this.pointerDownY = event.clientY

        this.pointerDownTime = performance.now() / 1000
    }

    handlePointerUp(event) {
        if (
            !this.enabled ||
            event.button !== 0 ||
            event.pointerId !== this.activePointerId
        ) {
            return
        }

        this.updatePointer(event)

        const deltaX = event.clientX - this.pointerDownX

        const deltaY = event.clientY - this.pointerDownY

        const distanceSquared = deltaX * deltaX + deltaY * deltaY

        const duration = performance.now() / 1000 - this.pointerDownTime

        this.element.releasePointerCapture?.(event.pointerId)

        this.primaryDown = false
        this.activePointerId = null

        if (
            distanceSquared > CLICK_DISTANCE_SQUARED ||
            duration > CLICK_MAX_DURATION
        ) {
            return
        }

        this.primaryActionPointer.copy(this.pointer)

        this.primaryActionVersion += 1
    }

    handlePointerCancel(event) {
        if (event.pointerId !== this.activePointerId) {
            return
        }

        this.element.releasePointerCapture?.(event.pointerId)

        this.primaryDown = false
        this.activePointerId = null
    }

    updatePointer(event) {
        const bounds = this.getBounds()

        this.clientX = event.clientX

        this.clientY = event.clientY

        this.pointer.set(
            ((event.clientX - bounds.left) / bounds.width) * 2 - 1,

            -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
        )

        this.pointerVersion += 1
    }

    getBounds() {
        if (this.boundsDirty || !this.bounds) {
            const nextBounds = this.element.getBoundingClientRect()

            this.bounds = {
                left: nextBounds.left,

                top: nextBounds.top,

                width: Math.max(1, nextBounds.width),

                height: Math.max(1, nextBounds.height),
            }

            this.boundsDirty = false
        }

        return this.bounds
    }

    invalidateBounds() {
        this.boundsDirty = true
    }

    setEnabled(enabled) {
        const nextEnabled = Boolean(enabled)

        if (nextEnabled === this.enabled) {
            return false
        }

        this.enabled = nextEnabled

        if (!nextEnabled) {
            this.pointerInside = false

            this.primaryDown = false

            this.activePointerId = null

            this.pointerVersion += 1
        }

        return true
    }

    copyPointer(target) {
        return target.copy(this.pointer)
    }

    copyPrimaryActionPointer(target) {
        return target.copy(this.primaryActionPointer)
    }

    dispose() {
        if (this.disposed) {
            return
        }

        this.disposed = true

        this.element.removeEventListener(
            "pointerenter",
            this.handlePointerEnter,
        )

        this.element.removeEventListener("pointermove", this.handlePointerMove)

        this.element.removeEventListener(
            "pointerleave",
            this.handlePointerLeave,
        )

        this.element.removeEventListener("pointerdown", this.handlePointerDown)

        this.element.removeEventListener("pointerup", this.handlePointerUp)

        this.element.removeEventListener(
            "pointercancel",
            this.handlePointerCancel,
        )

        this.resizeObserver?.disconnect()

        this.resizeObserver = null

        window.removeEventListener("resize", this.handleWindowResize)

        this.element = null
        this.bounds = null
    }
}
