export class Tween {

    constructor({

        object,
        property,
        from,
        to,
        duration = 1,
        easing = Tween.linear,
        onComplete = null

    }) {

        this.object = object;
        this.property = property;

        this.from = from;
        this.to = to;

        this.duration = duration;
        this.elapsed = 0;

        this.easing = easing;
        this.onComplete = onComplete;

        this.finished = false;

        this.object[this.property] = this.from;

    }

    update(delta) {

        if (this.finished) {

            return;

        }

        this.elapsed += delta;

        const t = Math.min(
            this.elapsed / this.duration,
            1
        );

        const value =
            this.from +
            (this.to - this.from) *
            this.easing(t);

        this.object[this.property] = value;

        if (t === 1) {

            this.finished = true;

            if (this.onComplete) {

                this.onComplete();

            }

        }

    }

    static linear(t) {

        return t;

    }


    // Quadratic

    static easeInQuad(t) {

        return t * t;

    }

    static easeOutQuad(t) {

        return 1 - (1 - t) * (1 - t);

    }

    static easeInOutQuad(t) {

        return t < 0.5
            ? 2 * t * t
            : 1 - Math.pow(-2 * t + 2, 2) / 2;

    }


    // Cubic

    static easeInCubic(t) {

        return t * t * t;

    }

    static easeOutCubic(t) {

        return 1 - Math.pow(1 - t, 3);

    }

    static easeInOutCubic(t) {

        return t < 0.5
            ? 4 * t * t * t
            : 1 - Math.pow(-2 * t + 2, 3) / 2;

    }


    // Quartic

    static easeInQuart(t) {

        return t * t * t * t;

    }

    static easeOutQuart(t) {

        return 1 - Math.pow(1 - t, 4);

    }

    static easeInOutQuart(t) {

        return t < 0.5
            ? 8 * Math.pow(t, 4)
            : 1 - Math.pow(-2 * t + 2, 4) / 2;

    }


    // Quintic

    static easeInQuint(t) {

        return t * t * t * t * t;

    }

    static easeOutQuint(t) {

        return 1 - Math.pow(1 - t, 5);

    }

    static easeInOutQuint(t) {

        return t < 0.5
            ? 16 * Math.pow(t, 5)
            : 1 - Math.pow(-2 * t + 2, 5) / 2;

    }


    // Sine

    static easeInSine(t) {

        return 1 - Math.cos((t * Math.PI) / 2);

    }

    static easeOutSine(t) {

        return Math.sin((t * Math.PI) / 2);

    }

    static easeInOutSine(t) {

        return -(Math.cos(Math.PI * t) - 1) / 2;

    }


    // Exponential

    static easeInExpo(t) {

        return t === 0
            ? 0
            : Math.pow(2, 10 * t - 10);

    }

    static easeOutExpo(t) {

        return t === 1
            ? 1
            : 1 - Math.pow(2, -10 * t);

    }

    static easeInOutExpo(t) {

        if (t === 0) return 0;
        if (t === 1) return 1;

        return t < 0.5
            ? Math.pow(2, 20 * t - 10) / 2
            : (2 - Math.pow(2, -20 * t + 10)) / 2;

    }


    // Circular

    static easeInCirc(t) {

        return 1 - Math.sqrt(1 - t * t);

    }

    static easeOutCirc(t) {

        return Math.sqrt(1 - Math.pow(t - 1, 2));

    }

    static easeInOutCirc(t) {

        return t < 0.5
            ? (1 - Math.sqrt(1 - Math.pow(2 * t, 2))) / 2
            : (Math.sqrt(1 - Math.pow(-2 * t + 2, 2)) + 1) / 2;

    }


    // Back (overshoots)

    static easeInBack(t) {

        const c1 = 1.70158;
        const c3 = c1 + 1;

        return c3 * t * t * t - c1 * t * t;

    }

    static easeOutBack(t) {

        const c1 = 1.70158;
        const c3 = c1 + 1;

        return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);

    }

    static easeInOutBack(t) {

        const c1 = 1.70158;
        const c2 = c1 * 1.525;

        return t < 0.5
            ? (Math.pow(2 * t, 2) * ((c2 + 1) * 2 * t - c2)) / 2
            : (Math.pow(2 * t - 2, 2) * ((c2 + 1) * (2 * t - 2) + c2) + 2) / 2;

    }

}