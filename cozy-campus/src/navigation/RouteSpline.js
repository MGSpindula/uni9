import * as THREE from "three";

export class RouteSpline extends THREE.Curve {

    constructor(points, { closed = false } = {}) {

        super();

        this.points = points.map(point => point.clone());
        this.closed = closed;
        this.periodicCurve = closed
            ? new THREE.CatmullRomCurve3(
                this.points,
                true,
                "centripetal"
            )
            : null;
        this.knots = closed
            // CatmullRomCurve3 assigns one equal parameter interval to each
            // point of a closed curve. The extra knot at 1 represents coming
            // back to point zero after the final authored anchor.
            ? Array.from(
                { length: this.points.length + 1 },
                (_, index) => index / this.points.length
            )
            : this.createChordLengthKnots(this.points);
        this.x = closed ? null : this.solveAxis("x");
        this.y = closed ? null : this.solveAxis("y");
        this.z = closed ? null : this.solveAxis("z");

        // Arc-length lookup is used every frame by Locomotion. A denser table
        // keeps speed stable even around short node transition portals.
        this.arcLengthDivisions = THREE.MathUtils.clamp(
            this.points.length * 32,
            300,
            1200
        );

    }

    // -----------------------------
    // THREE.Curve contract
    // -----------------------------

    getPoint(t, target = new THREE.Vector3()) {

        const parameter = THREE.MathUtils.clamp(t, 0, 1);

        if (this.closed) {

            return this.periodicCurve.getPoint(parameter, target);

        }

        const interval = this.findInterval(parameter);
        const local = parameter - this.knots[interval];

        return target.set(
            this.evaluate(this.x[interval], local),
            this.evaluate(this.y[interval], local),
            this.evaluate(this.z[interval], local)
        );

    }

    getTangent(t, target = new THREE.Vector3()) {

        const parameter = THREE.MathUtils.clamp(t, 0, 1);

        if (this.closed) {

            return this.periodicCurve.getTangent(parameter, target);

        }

        const interval = this.findInterval(parameter);
        const local = parameter - this.knots[interval];

        target.set(
            this.evaluateDerivative(this.x[interval], local),
            this.evaluateDerivative(this.y[interval], local),
            this.evaluateDerivative(this.z[interval], local)
        );

        return target.lengthSq() > 0.000001
            ? target.normalize()
            : target;

    }

    getDistanceAtAnchor(anchorIndex) {

        const t = this.knots[anchorIndex] ?? 1;
        const divisions = this.arcLengthDivisions;
        const lengths = this.getLengths(divisions);
        const scaled = t * divisions;
        const lower = Math.floor(scaled);
        const upper = Math.min(lower + 1, divisions);

        return THREE.MathUtils.lerp(
            lengths[lower],
            lengths[upper],
            scaled - lower
        );

    }

    getDebugPoints(divisions = 160) {

        // getPoints() samples uniform parameters and can visually skip a knot.
        // Merge every authored knot into the sample list so the helper proves
        // that the rendered spline crosses each lane start/end exactly.
        const parameters = [
            ...Array.from(
                { length: divisions + 1 },
                (_, index) => index / divisions
            ),
            ...this.knots
        ]
            .sort((first, second) => first - second)
            .filter((value, index, values) =>
                index === 0 || Math.abs(value - values[index - 1]) > 0.000001
            );

        return parameters.map(parameter => this.getPoint(parameter));

    }

    // -----------------------------
    // Natural cubic interpolation
    // -----------------------------

    createChordLengthKnots(points) {

        const knots = [0];
        let total = 0;

        for (let index = 1; index < points.length; index++) {

            total += Math.max(
                points[index - 1].distanceTo(points[index]),
                0.0001
            );
            knots.push(total);

        }

        return total > 0
            ? knots.map(value => value / total)
            : knots;

    }

    solveAxis(axis) {

        const values = this.points.map(point => point[axis]);
        const count = values.length;

        if (count === 2) {

            const span = this.knots[1] - this.knots[0];

            return [{
                a: values[0],
                b: (values[1] - values[0]) / span,
                c: 0,
                d: 0
            }];

        }

        const h = Array.from(
            { length: count - 1 },
            (_, index) => this.knots[index + 1] - this.knots[index]
        );
        const alpha = Array(count).fill(0);

        for (let index = 1; index < count - 1; index++) {

            alpha[index] =
                3 / h[index] * (values[index + 1] - values[index]) -
                3 / h[index - 1] * (values[index] - values[index - 1]);

        }

        const lower = Array(count).fill(0);
        const weight = Array(count).fill(0);
        const solution = Array(count).fill(0);
        const c = Array(count).fill(0);

        lower[0] = 1;

        for (let index = 1; index < count - 1; index++) {

            lower[index] =
                2 * (this.knots[index + 1] - this.knots[index - 1]) -
                h[index - 1] * weight[index - 1];
            weight[index] = h[index] / lower[index];
            solution[index] = (
                alpha[index] - h[index - 1] * solution[index - 1]
            ) / lower[index];

        }

        lower[count - 1] = 1;
        const coefficients = Array(count - 1);

        for (let index = count - 2; index >= 0; index--) {

            c[index] = solution[index] - weight[index] * c[index + 1];
            coefficients[index] = {
                a: values[index],
                b: (values[index + 1] - values[index]) / h[index] -
                    h[index] * (c[index + 1] + 2 * c[index]) / 3,
                c: c[index],
                d: (c[index + 1] - c[index]) / (3 * h[index])
            };

        }

        return coefficients;

    }

    findInterval(t) {

        if (t >= 1) return this.knots.length - 2;

        // Route splines may contain every lane start/end in a long route.
        // Binary search avoids scanning all previous anchors for every debug
        // and arc-length sample generated while the route is created.
        let lower = 0;
        let upper = this.knots.length - 1;

        while (lower + 1 < upper) {

            const middle = Math.floor((lower + upper) * 0.5);

            if (t < this.knots[middle]) upper = middle;
            else lower = middle;

        }

        return Math.min(lower, this.knots.length - 2);

    }

    evaluate({ a, b, c, d }, t) {

        return a + b * t + c * t ** 2 + d * t ** 3;

    }

    evaluateDerivative({ b, c, d }, t) {

        return b + 2 * c * t + 3 * d * t ** 2;

    }

}
