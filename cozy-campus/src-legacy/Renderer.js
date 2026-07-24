import * as THREE from "three";

export class Renderer {

    constructor() {

        // Low-level WebGL renderer. Scene owns the higher-level render pipeline.
        // antialias disabled: PostProcessing.renderTarget já usa MSAA 4x
        this.renderer = new THREE.WebGLRenderer({
            antialias: false
        });
        this.qualityPresets = {
            low: { pixelRatio: 1, shadows: false, samples: 0 },
            medium: { pixelRatio: 1.25, shadows: true, samples: 2 },
            high: { pixelRatio: 1.5, shadows: true, samples: 4 }
        };
        this.qualityPreset = "high";
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
            Math.min(
                window.devicePixelRatio,
                this.qualityPresets[this.qualityPreset].pixelRatio
            )
        );

        this.renderer.setSize(
            window.innerWidth,
            window.innerHeight
        );

    }

    setQualityPreset(name) {

        const preset = this.qualityPresets[name];

        if (!preset) throw new Error(`Unknown quality preset "${name}".`);

        this.qualityPreset = name;
        this.renderer.shadowMap.enabled = preset.shadows;
        this.resize();
        return { ...preset };

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
