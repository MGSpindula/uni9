import * as THREE from "three";

export const RouteSegmentType = Object.freeze({
    INTERACTION_EXIT: "interaction-exit",
    JUNCTION_TRANSITION: "junction-transition",
    LANE: "lane",
    INTERACTION_APPROACH: "interaction-approach"
});

// Uma unidade geométrica pequena e validável da rota. O recurso e laneIndex
// registram exatamente qual autorização de tráfego originou esta geometria.
export class RouteSegment {

    constructor({
        type,
        curve,
        resource = null,
        laneIndex = null,
        startDistance = 0,
        endDistance = null
    }) {

        this.type = type;
        this.curve = curve;
        this.startDistance = startDistance;
        this.endDistance = endDistance ??
            startDistance + curve.getLength();
        this.resource = resource;
        this.laneIndex = laneIndex;
        this.validation = null;

    }

    validate({
        axisStart = null,
        axisEnd = null,
        maxAxisDistance = Infinity,
        maxTurnRadians = Math.PI * 0.75,
        allowChordReversal = false,
        samples = 20
    } = {}) {

        const issues = [];
        const points = this.curve.getPoints(samples);
        const routeDirection = points.at(-1).clone()
            .sub(points[0])
            .setY(0);
        let maximumAxisDistance = 0;
        let maximumTurn = 0;
        let reverses = false;

        if (routeDirection.lengthSq() > 0.000001) {

            routeDirection.normalize();

            for (let index = 0; index < samples; index++) {

                const tangent = this.curve.getTangent(
                    (index + 0.5) / samples,
                    new THREE.Vector3()
                ).setY(0);

                if (tangent.lengthSq() > 0.000001 &&
                    tangent.normalize().dot(routeDirection) < -0.05) {

                    reverses = true;

                }

            }

        }

        for (let index = 1; index < points.length - 1; index++) {

            const incoming = points[index].clone()
                .sub(points[index - 1]).setY(0);
            const outgoing = points[index + 1].clone()
                .sub(points[index]).setY(0);

            if (incoming.lengthSq() > 0.000001 &&
                outgoing.lengthSq() > 0.000001) {

                maximumTurn = Math.max(
                    maximumTurn,
                    incoming.angleTo(outgoing)
                );

            }

        }

        if (axisStart && axisEnd) {

            for (const point of points) {

                maximumAxisDistance = Math.max(
                    maximumAxisDistance,
                    this.getPlanarDistanceToSegment(
                        point,
                        axisStart,
                        axisEnd
                    )
                );

            }

        }

        // Junctions may legitimately begin in a direction opposed to the
        // straight chord (an obtuse turn). What matters there is continuous
        // local curvature, not monotonic progress along the chord.
        if (reverses && !allowChordReversal) {
            issues.push("direction-reversal");
        }
        if (maximumTurn > maxTurnRadians) issues.push("excessive-curvature");
        if (maximumAxisDistance > maxAxisDistance) {
            issues.push("outside-corridor");
        }

        this.validation = {
            valid: issues.length === 0,
            issues,
            maximumAxisDistance,
            maximumTurn,
            reverses
        };

        return this.validation;

    }

    getPlanarDistanceToSegment(point, start, end) {

        const axis = end.clone().sub(start).setY(0);
        const relative = point.clone().sub(start).setY(0);
        const lengthSquared = axis.lengthSq();
        const t = lengthSquared > 0
            ? THREE.MathUtils.clamp(relative.dot(axis) / lengthSquared, 0, 1)
            : 0;
        const closest = start.clone().addScaledVector(axis, t);

        return Math.hypot(point.x - closest.x, point.z - closest.z);

    }

}
