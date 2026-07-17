import * as THREE from "three";

export class Renderer {

    constructor() {

        // Low-level WebGL renderer. Scene owns the higher-level render pipeline.
        // antialias disabled: PostProcessing.renderTarget já usa MSAA 4x
        this.renderer = new THREE.WebGLRenderer({
            antialias: false
        });
        this.renderer.shadowMap.enabled = true;
        this.renderer.setSize(
            window.innerWidth,
            window.innerHeight
        );
        this.renderer.setPixelRatio(
            window.devicePixelRatio
        );
        document.body.appendChild(
            this.renderer.domElement
        );
        window.addEventListener(
            "resize",
            () => this.resize()
        );
    }

    // -----------------------------
    // Render lifecycle
    // -----------------------------

    resize() {

        this.renderer.setPixelRatio(
            window.devicePixelRatio
        );

        this.renderer.setSize(
            window.innerWidth,
            window.innerHeight
        );

    }

    render(postProcessing, delta) {

        postProcessing.render(delta);

    }
}
