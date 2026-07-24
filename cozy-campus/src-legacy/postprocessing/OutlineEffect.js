import * as THREE from "three";

import { OutlinePass } from "three/examples/jsm/postprocessing/OutlinePass.js";

import { Effect } from "./Effect";

export class OutlineEffect extends Effect {

    constructor(scene, camera) {

        super();

        this.pass = new OutlinePass(

            new THREE.Vector2(

                window.innerWidth,
                window.innerHeight

            ),

            scene,

            camera

        );

        // Default outline appearance. Subclasses/callers can override pass values.
        this.pass.edgeStrength = 3;
        this.pass.edgeThickness = 1;
        this.pass.edgeGlow = 0;
        this.pass.pulsePeriod = 0;
        this.pass.visibleEdgeColor.set(0xffffff);
        this.pass.hiddenEdgeColor.set(0xffffff);

        this.hasSelection = false;
        this.pass.enabled = false;

    }

    setObjects(objects = []) {

        const selectedObjects =
            Array.isArray(objects)
                ? objects.filter(Boolean)
                : [];

        this.pass.selectedObjects = selectedObjects;
        this.hasSelection = selectedObjects.length > 0;

        this.pass.enabled =
            this.enabled &&
            this.hasSelection;

    }

    // -----------------------------
    // Configuration
    // -----------------------------

    setColor(visible, hidden = visible) {

        this.pass.visibleEdgeColor.set(visible);
        this.pass.hiddenEdgeColor.set(hidden);

    }

    resize(width, height) {

        this.pass.setSize(

            width,

            height

        );

    }

    hover(entity, object) {

        if (!this.enabled || !entity.hasOutline()) {

            return;

        }

        this.setObjects([object]);

    }

    unhover(entity, object) {

        if (!entity.hasOutline()) {

            return;

        }

        this.setObjects([]);

    }

    // -----------------------------
    // Hover effect
    // -----------------------------

    enable() {

        this.enabled = true;
        this.pass.enabled = this.hasSelection;

    }

    disable() {

        super.disable();
        this.setObjects([]);

    }

    dispose() {

        this.setObjects([]);
        this.pass.dispose?.();

    }

}
