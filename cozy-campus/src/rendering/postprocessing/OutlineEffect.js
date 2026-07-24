import { Vector2 } from "three"

import { OutlinePass } from "three/addons/postprocessing/OutlinePass.js"

import { Effect } from "./Effect.js"

const DEFAULT_VISIBLE_EDGE_COLOR = 0xffffff

const DEFAULT_HIDDEN_EDGE_COLOR = 0x3d4654

const EMPTY_SELECTION = Object.freeze([])

export class OutlineEffect extends Effect {
    constructor({ scene, camera, width = 1, height = 1, onChanged = null }) {
        if (!scene || !camera) {
            throw new TypeError("OutlineEffect requires a scene and camera.")
        }

        const selectedObjects = []

        const pass = new OutlinePass(
            new Vector2(width, height),

            scene,
            camera,
            selectedObjects,
        )

        pass.edgeStrength = 3
        pass.edgeGlow = 0
        pass.edgeThickness = 1

        pass.pulsePeriod = 0

        pass.downSampleRatio = 2

        pass.visibleEdgeColor.set(DEFAULT_VISIBLE_EDGE_COLOR)

        pass.hiddenEdgeColor.set(DEFAULT_HIDDEN_EDGE_COLOR)

        super({
            id: "outline",
            pass,
            enabled: false,
            onChanged,
        })

        this.selectedObjects = selectedObjects
    }

    setSelection(selection) {
        const nextSelection = this.normalizeSelection(selection)

        if (this.isSameSelection(nextSelection)) {
            return false
        }

        this.selectedObjects.length = 0

        for (let index = 0; index < nextSelection.length; index += 1) {
            const object = nextSelection[index]

            if (!object?.isObject3D) {
                continue
            }

            this.selectedObjects.push(object)
        }

        const enabledChanged = this.setEnabled(this.selectedObjects.length > 0)

        if (!enabledChanged) {
            this.notifyChanged()
        }

        return true
    }

    clearSelection() {
        return this.setSelection(null)
    }

    normalizeSelection(selection) {
        if (!selection) {
            return EMPTY_SELECTION
        }

        if (Array.isArray(selection)) {
            return selection
        }

        return [selection]
    }

    isSameSelection(selection) {
        if (selection.length !== this.selectedObjects.length) {
            return false
        }

        for (let index = 0; index < selection.length; index += 1) {
            if (selection[index] !== this.selectedObjects[index]) {
                return false
            }
        }

        return true
    }

    requiresPostProcessing() {
        return this.pass.enabled && this.selectedObjects.length > 0
    }

    dispose() {
        if (this.disposed) {
            return
        }

        this.selectedObjects.length = 0

        this.selectedObjects = null

        super.dispose()
    }
}
