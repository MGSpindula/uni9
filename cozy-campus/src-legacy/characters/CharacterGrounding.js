import * as THREE from "three";

// Navigation supplies the intended 3D route. Grounding only corrects the final
// foot contact against authored walkable meshes; it never chooses a path.
export class CharacterGrounding {

    constructor(surfaces, {
        castHeight = 2.5,
        maxSnapDistance = 0.75
    } = {}) {

        this.surfaces = surfaces;
        this.castHeight = castHeight;
        this.maxSnapDistance = maxSnapDistance;
        this.raycaster = new THREE.Raycaster();
        this.origin = new THREE.Vector3();
        this.down = new THREE.Vector3(0, -1, 0);
        this.lastPositions = new WeakMap();
        this.positionEpsilon = 0.0001;

    }

    update(actor) {

        const position =
            actor.object3D.position;

        const lastPosition =
            this.lastPositions.get(actor);

        if (lastPosition) {

            const deltaX =
                position.x - lastPosition.x;

            const deltaY =
                position.y - lastPosition.y;

            const deltaZ =
                position.z - lastPosition.z;

            const distanceSquared =
                deltaX * deltaX +
                deltaY * deltaY +
                deltaZ * deltaZ;

            if (distanceSquared <=
                this.positionEpsilon *
                this.positionEpsilon) {

                return false;

            }

        }

        this.origin.copy(position);
        this.origin.y += this.castHeight;

        this.raycaster.set(
            this.origin,
            this.down
        );

        this.raycaster.far =
            this.castHeight +
            this.maxSnapDistance;

        const hits =
            this.raycaster.intersectObjects(
                this.surfaces,
                false
            );

        const hit =
            actor.traversalType === "slope"
                ? hits[0]
                : this.findClosestHeightHit(
                    hits,
                    position.y
                );

        if (!hit) {

            this.rememberPosition(actor);
            return false;

        }

        const difference =
            hit.point.y - position.y;

        if (Math.abs(difference) >
            this.maxSnapDistance) {

            this.rememberPosition(actor);
            return false;

        }

        position.y = hit.point.y;

        this.rememberPosition(actor);

        return true;

    }

    rememberPosition(actor) {

        let storedPosition =
            this.lastPositions.get(actor);

        if (!storedPosition) {

            storedPosition =
                new THREE.Vector3();

            this.lastPositions.set(
                actor,
                storedPosition
            );

        }

        storedPosition.copy(
            actor.object3D.position
        );

    }

    // Caso teleporte manualmente o ator, use `this.characterGrounding.invalidate(actor);` antes ou depois de alterar sua posição.

    invalidate(actor) {

        this.lastPositions.delete(actor);

    }

    projectPosition(position, maxDistance = 1, {
        preferHighest = false
    } = {}) {

        this.origin.copy(position);
        this.origin.y += this.castHeight;
        this.raycaster.set(this.origin, this.down);
        this.raycaster.far = this.castHeight + maxDistance;

        const hits = this.raycaster.intersectObjects(this.surfaces, false);
        const hit = preferHighest
            ? hits[0]
            : this.findClosestHeightHit(hits, position.y);

        if (!hit ||
            (!preferHighest &&
                Math.abs(hit.point.y - position.y) > maxDistance)) {

            return false;

        }

        position.y = hit.point.y;
        return true;

    }

    findClosestHeightHit(hits, referenceY) {

        return hits.reduce((closest, hit) =>
            !closest ||
                Math.abs(hit.point.y - referenceY) <
                Math.abs(closest.point.y - referenceY)
                ? hit
                : closest
            , null);

    }

    validateGraph(graph, tolerance = 0.12) {

        const mismatches = [];

        for (const node of graph.nodes.values()) {

            this.origin.copy(node.position);
            this.origin.y += this.castHeight;
            this.raycaster.set(this.origin, this.down);
            this.raycaster.far = this.castHeight + this.maxSnapDistance;

            const hit = this.findClosestHeightHit(
                this.raycaster.intersectObjects(this.surfaces, false),
                node.position.y
            );

            if (!hit || Math.abs(hit.point.y - node.position.y) <= tolerance) {

                continue;

            }

            mismatches.push({
                node: node.id,
                nodeY: node.position.y.toFixed(2),
                surfaceY: hit.point.y.toFixed(2)
            });

        }

        if (mismatches.length > 0) {

            console.warn(
                "[Grounding] Navigation nodes do not match their walkable surface.",
                mismatches
            );

        }

        return mismatches;

    }

}
