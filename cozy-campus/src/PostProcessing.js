import * as THREE from "three";

import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

export class PostProcessing {

    constructor(renderer, scene, camera) {

        this.renderer = renderer;
        this.scene = scene;
        this.camera = camera;

        this.composer =
            new EffectComposer(renderer);

        this.renderPass =
            new RenderPass(scene, camera);

        this.outputPass =
            new OutputPass();

        this.composer.addPass(
            this.renderPass
        );

        this.composer.addPass(
            this.outputPass
        );

    }

    addPass(pass) {

        this.composer.insertPass(

            pass,

            this.composer.passes.length - 1

        );

    }

    render(delta) {

        this.composer.render(delta);

    }

    resize(width, height) {

        this.composer.setSize(
            width,
            height
        );

    }

}