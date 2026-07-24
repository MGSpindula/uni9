const EASING = Object.freeze({
    linear: (value) => value,

    easeInQuad: (value) => value * value,

    easeOutQuad: (value) => 1 - (1 - value) * (1 - value),

    easeInOutQuad: (value) =>
        value < 0.5 ? 2 * value * value : 1 - Math.pow(-2 * value + 2, 2) / 2,

    easeOutCubic: (value) => 1 - Math.pow(1 - value, 3),

    easeInOutCubic: (value) =>
        value < 0.5
            ? 4 * value * value * value
            : 1 - Math.pow(-2 * value + 2, 3) / 2,
})

export class Tween {
    static Easing = EASING

    constructor({
        duration = 0,
        delay = 0,
        easing = EASING.linear,
        onUpdate = null,
        onComplete = null,
        onCancel = null,
    } = {}) {
        if (!Number.isFinite(duration) || duration < 0) {
            throw new RangeError(
                "Tween duration must be a finite number greater than or equal to zero.",
            )
        }

        if (!Number.isFinite(delay) || delay < 0) {
            throw new RangeError(
                "Tween delay must be a finite number greater than or equal to zero.",
            )
        }

        if (typeof easing !== "function") {
            throw new TypeError("Tween easing must be a function.")
        }

        this.duration = duration
        this.delay = delay
        this.easing = easing

        this.onUpdate = onUpdate
        this.onComplete = onComplete
        this.onCancel = onCancel

        this.elapsed = 0
        this.progress = 0
        this.value = 0

        this.started = false
        this.completed = false
        this.cancelled = false
    }

    update(delta) {
        if (!this.isActive()) {
            return false
        }

        const safeDelta = Number.isFinite(delta) && delta > 0 ? delta : 0

        this.elapsed += safeDelta

        if (this.elapsed < this.delay) {
            return true
        }

        this.started = true

        const tweenElapsed = this.elapsed - this.delay

        this.progress =
            this.duration === 0 ? 1 : Math.min(tweenElapsed / this.duration, 1)

        this.value = this.easing(this.progress)

        this.onUpdate?.(this.value, this.progress, this)

        if (this.progress >= 1) {
            this.completed = true

            this.onComplete?.(this)
        }

        return this.isActive()
    }

    cancel({ complete = false } = {}) {
        if (!this.isActive()) {
            return false
        }

        if (complete) {
            this.elapsed = this.delay + this.duration

            this.progress = 1
            this.value = 1

            this.onUpdate?.(1, 1, this)

            this.completed = true

            this.onComplete?.(this)

            return true
        }

        this.cancelled = true

        this.onCancel?.(this)

        return true
    }

    isActive() {
        return !this.completed && !this.cancelled
    }

    dispose() {
        if (this.isActive()) {
            this.cancel()
        }

        this.onUpdate = null
        this.onComplete = null
        this.onCancel = null
    }

    static number({ from = 0, to = 1, onUpdate, ...options } = {}) {
        if (typeof onUpdate !== "function") {
            throw new TypeError("Tween.number requires an onUpdate function.")
        }

        const difference = to - from

        return new Tween({
            ...options,

            onUpdate: (value, progress, tween) => {
                onUpdate(
                    from + difference * value,

                    progress,
                    tween,
                )
            },
        })
    }
}

// Exemplo futuro:

// entity.addTween(
//     Tween.number({
//         from: 1,
//         to: 1.2,
//         duration: 0.25,
//         easing:
//             Tween.Easing
//                 .easeOutCubic,

//         onUpdate: value => {
//             entity.object3D
//                 .scale
//                 .setScalar(value);
//         }
//     })
// );
