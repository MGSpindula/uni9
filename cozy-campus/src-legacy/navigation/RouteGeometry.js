import * as THREE from "three";

// Geometria composta somente pelo trecho já autorizado. Não representa toda
// a rota topológica e, portanto, pode ser descartada quando uma lane muda sem
// reconstruir os demais nós do plano.
export class RouteGeometry {

    constructor(segments = []) {

        this.segments = [];
        this.curve = new THREE.CurvePath();

        for (const segment of segments) this.add(segment);

    }

    add(segment) {

        segment.startDistance = this.getLength();
        this.curve.add(segment.curve);
        this.curve.updateArcLengths();
        segment.endDistance = this.getLength();
        this.segments.push(segment);
        return segment;

    }

    getLength() {

        return this.curve.getLength();

    }

    getDebugPoints(samplesPerSegment = 24) {

        const points = [];

        for (const segment of this.segments) {

            const samples = segment.curve.getPoints(samplesPerSegment);

            if (points.length > 0) samples.shift();
            points.push(...samples);

        }

        return points;

    }

}
