import * as THREE from "three";

export class Raycast {

    constructor(camera, scene) {

        this.camera = camera;
        this.scene = scene;

        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();

    }

    updateMouse(event) {

        this.mouse.x =
            (event.clientX / window.innerWidth) * 2 - 1;

        this.mouse.y =
            -(event.clientY / window.innerHeight) * 2 + 1;

    }

    getHit(event, registry) {

        this.updateMouse(event);

        this.raycaster.setFromCamera(
            this.mouse,
            this.camera
        );

        const hits = this.raycaster.intersectObjects(
            this.scene.children,
            true
        );

        if (hits.length === 0) {

            return null;

        }

        const object = hits[0].object;

        const entity = registry.get(object);

        if (!entity) {

            return null;

        }

        return {

            entity,
            object

        };

    }

}