import * as THREE from "three";

export class SlopeDetector {
    constructor(raycaster = null, terrainMeshes = []) {
        this.raycaster = raycaster || new THREE.Raycaster();
        this.terrainMeshes = terrainMeshes;
        this.maxSlopeAngle = 45;
        this.maxStepHeight = 0.35;
        this.debugRays = false;
    }

    detectSlope(actorPosition, moveDirection, castDistance = 1.0) {
        if (this.terrainMeshes.length === 0) {
            return {
                slopeAngle: 0,
                rayDistance: null,
                isClimbable: true,
                rayHit: false
            };
        }

        const rayCasts = [
            this.castRay(actorPosition, moveDirection, castDistance),
            this.castRay(actorPosition, this.rotateVectorY(moveDirection, 20), castDistance),
            this.castRay(actorPosition, this.rotateVectorY(moveDirection, -20), castDistance)
        ];

        let totalAngle = 0;
        let validRays = 0;
        let avgDistance = null;
        let anyHit = false;

        for (let i = 0; i < rayCasts.length; i++) {
            const ray = rayCasts[i];
            if (!ray.hit) continue;

            anyHit = true;
            totalAngle += this.calculateSlopeAngle(ray.normal);
            validRays++;

            if (i === 0) avgDistance = ray.distance;
        }

        const avgAngle = validRays > 0 ? totalAngle / validRays : 0;
        return {
            slopeAngle: avgAngle,
            rayDistance: avgDistance,
            isClimbable: Math.abs(avgAngle) <= this.maxSlopeAngle,
            rayHit: anyHit
        };
    }

    castRay(origin, direction, castDistance) {
        const downForward = new THREE.Vector3()
            .addVectors(
                direction.clone().normalize().multiplyScalar(0.7),
                new THREE.Vector3(0, -1, 0).multiplyScalar(0.3)
            )
            .normalize();

        this.raycaster.set(origin, downForward);
        this.raycaster.far = castDistance;

        const intersects = this.raycaster.intersectObjects(this.terrainMeshes, true);
        if (intersects.length === 0) {
            return { hit: false, distance: null, normal: null, point: null };
        }

        const hit = intersects[0];
        const faceNormal = this.getWorldNormal(hit);

        if (this.debugRays) {
            console.log(
                `[SlopeDetector] Ray hit: ${hit.distance?.toFixed(2)}m, normal: ` +
                `(${faceNormal.x.toFixed(2)}, ${faceNormal.y.toFixed(2)}, ${faceNormal.z.toFixed(2)})`
            );
        }

        return {
            hit: true,
            distance: hit.distance,
            normal: faceNormal,
            point: hit.point
        };
    }

    sampleGround(position, { upOffset = 1.5, downDistance = 4 } = {}) {
        if (this.terrainMeshes.length === 0) return null;

        const origin = position.clone();
        origin.y += upOffset;

        this.raycaster.set(origin, new THREE.Vector3(0, -1, 0));
        this.raycaster.far = downDistance;

        const intersects = this.raycaster.intersectObjects(this.terrainMeshes, true);
        if (intersects.length === 0) return null;

        const hit = intersects[0];
        return {
            point: hit.point.clone(),
            distance: hit.distance,
            normal: this.getWorldNormal(hit)
        };
    }

    getGroundHeight(position, fallbackY = 0) {
        const hit = this.sampleGround(position);
        return hit ? hit.point.y : fallbackY;
    }

    getWorldNormal(hit) {
        if (!hit?.face?.normal) return new THREE.Vector3(0, 1, 0);

        const normal = hit.face.normal.clone();
        const normalMatrix = new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld);
        normal.applyMatrix3(normalMatrix).normalize();
        return normal;
    }

    calculateSlopeAngle(surfaceNormal) {
        const dot = surfaceNormal.y;
        const angleRad = Math.acos(Math.max(-1, Math.min(1, dot)));
        let angleDeg = THREE.MathUtils.radToDeg(angleRad) - 90;

        if (angleDeg > 90) angleDeg = 180 - angleDeg;
        if (angleDeg < -90) angleDeg = -180 - angleDeg;

        return angleDeg;
    }

    rotateVectorY(vector, angleDegrees) {
        const angleRad = THREE.MathUtils.degToRad(angleDegrees);
        const rotated = vector.clone();
        rotated.applyAxisAngle(new THREE.Vector3(0, 1, 0), angleRad);
        return rotated;
    }

    isTerrainTooSteep(actorPosition, moveDirection) {
        const slope = this.detectSlope(actorPosition, moveDirection);
        return !slope.isClimbable;
    }

    getMovementSpeedMultiplier(slopeAngle) {
        const uphill = Math.max(0, slopeAngle);

        if (uphill > this.maxSlopeAngle) {
            return 0;
        }

        const multiplier = 1 - (uphill * 0.02);
        return Math.max(0.3, multiplier);
    }

    getGravityMultiplier(slopeAngle) {
        const downhill = Math.max(0, -slopeAngle);

        if (downhill < 5) {
            return 1.0;
        }

        return 1 + (downhill * 0.01);
    }

    setDebug(enabled) {
        this.debugRays = enabled;
    }

    addTerrainMesh(mesh) {
        if (!this.terrainMeshes.includes(mesh)) {
            this.terrainMeshes.push(mesh);
        }
    }

    clearTerrainMeshes() {
        this.terrainMeshes = [];
    }
}
