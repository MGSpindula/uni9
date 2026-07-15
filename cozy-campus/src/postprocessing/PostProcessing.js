import * as THREE from "three";

import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

export class PostProcessing {

    constructor(renderer, scene, camera) {

        this.renderer = renderer;
        this.scene = scene;
        this.camera = camera;

        const renderTarget = new THREE.WebGLRenderTarget(

            window.innerWidth,
            window.innerHeight,

            {
                samples: 4
            }

        );

        this.composer =
            new EffectComposer(
                renderer,
                renderTarget
            );

        this.composer.setPixelRatio(window.devicePixelRatio);

        this.composer.setSize(
            window.innerWidth,
            window.innerHeight
        );

        this.renderPass =
            new RenderPass(scene, camera);

        this.outputPass =
            new OutputPass();

        this.effects = [];

        this.composer.addPass(
            this.renderPass
        );

        this.composer.addPass(
            this.outputPass
        );

    }

    addEffect(effect) {

        this.effects.push(effect);

        effect.initialize();

        this.composer.insertPass(

            effect.getPass(),

            this.composer.passes.length - 1

        );

    }

    removeEffect(effect) {

        if (!this.effects.includes(effect)) return;

        this.effects = this.effects.filter(item => item !== effect);
        this.composer.removePass(effect.getPass());
        effect.dispose();

    }

    render(delta) {

        this.composer.render(delta);

    }

    resize(width, height) {

        this.composer.setPixelRatio(window.devicePixelRatio);

        this.composer.setSize(width, height);

        for (const effect of this.effects) {

            effect.resize(width, height);

        }

    }

}
