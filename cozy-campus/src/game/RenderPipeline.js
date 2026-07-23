import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { PostProcessing } from "../postprocessing/PostProcessing";
import { OutlineEffect } from "../postprocessing/OutlineEffect";

export class RenderPipeline {
    constructor(renderer, onChanged) {
        this.renderer = renderer;
        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 100);
        this.controls = new OrbitControls(this.camera, renderer.renderer.domElement);
        this.controls.enableDamping = true;
        this.setDefaultCameraView();
        this.postProcessing = new PostProcessing(renderer.renderer, this.scene, this.camera);
        this.outline = new OutlineEffect(this.scene, this.camera);
        this.postProcessing.addEffect(this.outline);
        this.onChanged = onChanged;
        this.handleResize = () => this.resize();
        addEventListener("resize", this.handleResize);
    }
    setDefaultCameraView() {
        this.birdEyePositions = null;
        this.camera.up.set(0, 1, 0);
        this.camera.position.set(0, 6, 12);
        this.camera.near = 0.1;
        this.camera.far = 100;
        this.camera.updateProjectionMatrix();
        this.controls.target.set(0, 0, 0);
        this.camera.lookAt(this.controls.target);
        this.controls.update();
        this.onChanged?.();
    }
    setBirdEyeView(positions, { padding = 1.2 } = {}) {
        if (!positions?.length) return false;

        this.birdEyePositions = positions.map(position => position.clone());
        const bounds = new THREE.Box3().setFromPoints(positions);
        const center = bounds.getCenter(new THREE.Vector3());
        const size = bounds.getSize(new THREE.Vector3());
        const verticalFov = THREE.MathUtils.degToRad(this.camera.fov);
        const requiredViewHeight = Math.max(
            size.z,
            size.x / Math.max(this.camera.aspect, 0.01)
        ) * padding;
        const distance = Math.max(
            8,
            requiredViewHeight / (2 * Math.tan(verticalFov / 2))
        );

        // Looking exactly down makes the default Y-up vector degenerate.
        // -Z remains the top of the screen and keeps the authored map stable.
        this.camera.up.set(0, 0, -1);
        this.camera.position.set(center.x, bounds.max.y + distance, center.z);
        this.camera.near = 0.1;
        this.camera.far = Math.max(100, distance * 3 + size.y);
        this.camera.updateProjectionMatrix();
        this.controls.target.copy(center);
        this.camera.lookAt(center);
        this.camera.updateMatrixWorld();
        this.controls.update();
        this.onChanged?.();
        return true;
    }
    resize() {
        this.camera.aspect = innerWidth / innerHeight;
        if (this.birdEyePositions) {
            this.setBirdEyeView(this.birdEyePositions);
        } else {
            this.camera.updateProjectionMatrix();
        }
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
