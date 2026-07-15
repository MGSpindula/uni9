import * as THREE from "three";

import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { Input } from "./core/Input";
import { PostProcessing } from "./postprocessing/PostProcessing";
import { OutlineEffect } from "./postprocessing/OutlineEffect";

import { EntityRegistry } from "./core/EntityRegistry";
import { SelectionManager } from "./core/SelectionManager";

import { Floor } from "./objects/Floor";
import { Cube } from "./objects/Cube";
import { Sphere } from "./objects/Sphere";
import { Cylinder } from "./objects/Cylinder";
import { Chair } from "./objects/Chair";

export class Scene {

    constructor(renderer) {

        this.renderer = renderer;

        this.scene = new THREE.Scene();

        this.scene.background = new THREE.Color(0x87ceeb);

        this.camera = new THREE.PerspectiveCamera(
            60,
            window.innerWidth / window.innerHeight,
            0.1,
            100
        );

        this.camera.position.set(0, 6, 12);

        this.controls = new OrbitControls(
            this.camera,
            this.renderer.renderer.domElement
        );

        this.controls.enableDamping = true;

        this.controls.target.set(0, 0, 0);

        this.objects = [];

        this.registry = new EntityRegistry();

        this.selection = new SelectionManager(
            this.camera,
            this.scene,
            this.registry,
            this.renderer.renderer.domElement
        );

        this.createLights();

        this.createObjects();

        this.input = new Input(this.renderer.renderer.domElement);

        this.input.on("MouseMove", event => {

            const isHovering = this.selection.handleMouseMove(event);
            this.renderer.renderer.domElement.style.cursor =
                isHovering ? "pointer" : "default";

        });

        this.input.on("MouseLeave", () => {

            this.selection.clearHover();
            this.renderer.renderer.domElement.style.cursor = "default";

        });

        this.input.on("Click", event => this.selection.handleClick(event));

        this.postProcessing =
            new PostProcessing(

                this.renderer.renderer,
                this.scene,
                this.camera

            );

        this.outlineEffect =
            new OutlineEffect(

                this.scene,
                this.camera

            );

        this.postProcessing.addEffect(
            this.outlineEffect
        );

        this.selection.addEffect(
            this.outlineEffect
        );

        window.addEventListener(
            "resize",
            () => {

                this.camera.aspect =
                    window.innerWidth /
                    window.innerHeight;

                this.camera.updateProjectionMatrix();

                this.postProcessing.resize(

                    window.innerWidth,
                    window.innerHeight

                );

            }
        );

    }

    createLights() {

        const ambient = new THREE.AmbientLight(
            0xffffff,
            1
        );

        this.scene.add(ambient);

        const sun = new THREE.DirectionalLight(
            0xffffff,
            2
        );

        sun.castShadow = true;

        sun.position.set(10, 20, 10);

        this.scene.add(sun);

    }

    add(object) {

        this.objects.push(object);

        this.scene.add(object.object3D);

        object.register(this.registry);

    }

    createObjects() {

        this.add(new Floor());

        this.add(new Cube());

        this.add(new Sphere());

        this.add(new Cylinder());

        this.add(new Chair());

    }

    update(delta) {

        for (const object of this.objects) {

            if (object.isActive()) {

                object.update(delta);

            }

        }

        this.controls.update();

    }

    start() {

        let previous = performance.now();

        const loop = (now) => {

            const delta =
                (now - previous) / 1000;

            previous = now;

            this.update(delta);

            this.renderer.render(

                this.postProcessing,

                delta

            );

            requestAnimationFrame(loop);

        };

        requestAnimationFrame(loop);

    }

}
