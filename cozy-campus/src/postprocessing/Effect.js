export class Effect {

    constructor() {

        this.pass = null;
        this.enabled = true;

    }

    initialize() {

    }

    dispose() {

    }

    getPass() {

        return this.pass;

    }

    resize(width, height) {

    }

    enable() {

        this.enabled = true;

        if (this.pass) this.pass.enabled = true;

    }

    disable() {

        this.enabled = false;

        if (this.pass) this.pass.enabled = false;

    }

}
