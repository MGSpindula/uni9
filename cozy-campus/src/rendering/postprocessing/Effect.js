export class Effect {
    constructor({ id, pass, enabled = true, onChanged = null }) {
        if (!id) {
            throw new TypeError("Effect requires an id.")
        }

        if (!pass) {
            throw new TypeError(
                `Effect "${id}" requires a post-processing pass.`,
            )
        }

        this.id = id
        this.pass = pass

        this.onChanged = onChanged

        this.disposed = false

        this.setEnabled(enabled)
    }

    setEnabled(enabled) {
        const nextEnabled = Boolean(enabled)

        if (this.pass.enabled === nextEnabled) {
            return false
        }

        this.pass.enabled = nextEnabled

        this.notifyChanged()

        return true
    }

    requiresPostProcessing() {
        return Boolean(this.pass.enabled)
    }

    requiresContinuousRender() {
        return false
    }

    update() {
        return false
    }

    setSize() {}

    notifyChanged() {
        this.onChanged?.(this)
    }

    dispose() {
        if (this.disposed) {
            return
        }

        this.disposed = true

        this.pass.dispose?.()

        this.pass = null
        this.onChanged = null
    }
}
