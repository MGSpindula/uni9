import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { PostProcessing } from "../postprocessing/PostProcessing";
import { OutlineEffect } from "../postprocessing/OutlineEffect";

export class RenderPipeline {
    constructor(renderer, onChanged) {
        this.renderer = renderer;
        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 100);
        this.camera.position.set(0, 6, 12);
        this.controls = new OrbitControls(this.camera, renderer.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.target.set(0, 0, 0);
        this.postProcessing = new PostProcessing(renderer.renderer, this.scene, this.camera);
        this.outline = new OutlineEffect(this.scene, this.camera);
        this.postProcessing.addEffect(this.outline);
        this.onChanged = onChanged;
        this.handleResize = () => this.resize();
        addEventListener("resize", this.handleResize);
    }
    resize() {
        this.camera.aspect = innerWidth / innerHeight;
        this.camera.updateProjectionMatrix();
        this.postProcessing.resize(innerWidth, innerHeight);
        this.onChanged?.();
    }
    render(delta) { this.renderer.render(this.postProcessing, delta); }
    setQualityPreset(name) {
        const preset = this.renderer.setQualityPreset(name);
        this.postProcessing.setMultisampling(preset.samples);
        this.resize();
    }
    dispose() {
        removeEventListener("resize", this.handleResize);
        this.controls.dispose();
        this.postProcessing.dispose();
    }
}
