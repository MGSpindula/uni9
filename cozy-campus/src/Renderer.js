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
            Math.min(window.devicePixelRatio, 1.5)
        );
        document.body.appendChild(
            this.renderer.domElement
        );
        this.handleResize = () => this.resize();
        window.addEventListener(
            "resize",
            this.handleResize
        );
    }

    // -----------------------------
    // Render lifecycle
    // -----------------------------

    resize() {

        this.renderer.setPixelRatio(
            Math.min(window.devicePixelRatio, 1.5)
        );

        this.renderer.setSize(
            window.innerWidth,
            window.innerHeight
        );

    }

    render(postProcessing, delta) {

        postProcessing.render(delta);

    }

    dispose() {

        window.removeEventListener(
            "resize",
            this.handleResize
        );

        this.renderer.dispose();
        this.renderer.domElement.remove();

    }
}
