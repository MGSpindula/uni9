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

    }

    setObjects(objects) {

        this.pass.selectedObjects = objects;

    }

    resize(width, height) {

        this.pass.setSize(

            width,

            height

        );

    }

    hover(entity, object) {

        if (!entity.hasOutline()) {

            return;

        }

        this.pass.selectedObjects = [object];

    }

    unhover(entity) {

        if (!entity.hasOutline()) {

            return;

        }

        this.pass.selectedObjects = [];

    }

}