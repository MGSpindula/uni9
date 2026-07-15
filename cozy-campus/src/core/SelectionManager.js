export class SelectionManager {

    constructor() {

        this.outlinePass = null;

    }

    setOutlinePass(outlinePass) {

        this.outlinePass = outlinePass;

    }

    hover(object) {

        if (!this.outlinePass) {

            return;

        }

        this.outlinePass.selectedObjects = object ? [object] : [];

    }

}