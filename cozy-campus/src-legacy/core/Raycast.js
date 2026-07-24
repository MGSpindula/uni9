import * as THREE from "three";

export class Raycast {

    constructor(camera, element = null) {

        this.camera = camera;
        this.element = element;

        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();

    }

    // -----------------------------
    // Pointer coordinates
    // -----------------------------

    updateMouse(event) {

        const rect =
            this.element?.getBoundingClientRect() ?? {
                left: 0,
                top: 0,
                width: window.innerWidth,
                height: window.innerHeight
            };

        this.mouse.x =
            ((event.clientX - rect.left) / rect.width) * 2 - 1;

        this.mouse.y =
            -((event.clientY - rect.top) / rect.height) * 2 + 1;

    }

    getHit(event, registry) {

        this.updateMouse(event);

        this.raycaster.setFromCamera(
            this.mouse,
            this.camera
        );

        const targets =
            registry.getRaycastTargets();

        if (targets.length === 0) {

            return null;

        }

        const hits =
            this.raycaster.intersectObjects(
                targets,
                true
            );

        for (const hit of hits) {

            const entity =
                registry.get(hit.object);

            if (!entity) continue;

            return {
                entity,
                object: hit.object,
                point: hit.point
            };

        }

        return null;

    }

}