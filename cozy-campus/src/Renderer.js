// Renderer.js

import * as THREE from "three";


export class Renderer {
    constructor() {
        this.renderer = new THREE.WebGLRenderer({
            antialias: true
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