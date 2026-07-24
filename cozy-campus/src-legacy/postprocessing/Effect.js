export class Effect {

    constructor() {

        // Three.js post-processing pass owned by this effect.
        this.pass = null;
        this.enabled = true;

    }

    // -----------------------------
    // Lifecycle hooks
    // -----------------------------

    initialize() {

    }

    dispose() {

    }

    getPass() {

        return this.pass;

    }

    resize(width, height) {

    }

    // -----------------------------
    // State
    // -----------------------------

    enable() {

        this.enabled = true;

        if (this.pass) this.pass.enabled = true;

    }

    disable() {

        this.enabled = false;

        if (this.pass) this.pass.enabled = false;

    }

}
