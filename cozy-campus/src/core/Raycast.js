import * as THREE from "three";

export class Raycast {

    constructor(camera, scene, element = null) {

        this.camera = camera;
        this.scene = scene;
        this.element = element;

        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();

    }

    updateMouse(event) {

        const rect = this.element?.getBoundingClientRect() ?? {
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
