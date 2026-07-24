import { Raycaster, Vector2 } from "three"

export class Raycast {
    constructor({ near = 0, far = Infinity, layer = null } = {}) {
        this.raycaster = new Raycaster()

        this.raycaster.near = near

        this.raycaster.far = far

        this.pointer = new Vector2()

        this.intersections = []

        if (layer !== null) {
            this.setLayer(layer)
        }
    }

    setLayer(layer) {
        this.raycaster.layers.set(layer)

        return this
    }

    enableLayer(layer) {
        this.raycaster.layers.enable(layer)

        return this
    }

    disableLayer(layer) {
        this.raycaster.layers.disable(layer)

        return this
    }

    intersectFromCamera(
        pointer,
        camera,
        objects,
        { recursive = true, filter = null } = {},
    ) {
        this.intersections.length = 0

        if (!camera || !objects || objects.length === 0) {
            return this.intersections
        }

        this.pointer.copy(pointer)

        this.raycaster.setFromCamera(this.pointer, camera)

        const results = this.raycaster.intersectObjects(
            objects,
            recursive,
            this.intersections,
        )

        /*
         * Compatibilidade com versões do
         * Three.js que não reutilizam o
         * terceiro argumento.
         */
        if (results !== this.intersections) {
            for (let index = 0; index < results.length; index += 1) {
                this.intersections.push(results[index])
            }
        }

        if (typeof filter === "function") {
            let writeIndex = 0

            for (
                let readIndex = 0;
                readIndex < this.intersections.length;
                readIndex += 1
            ) {
                const intersection = this.intersections[readIndex]

                if (!filter(intersection)) {
                    continue
                }

                this.intersections[writeIndex] = intersection

                writeIndex += 1
            }

            this.intersections.length = writeIndex
        }

        return this.intersections
    }

    firstFromCamera(pointer, camera, objects, options) {
        const intersections = this.intersectFromCamera(
            pointer,
            camera,
            objects,
            options,
        )

        return intersections[0] ?? null
    }

    dispose() {
        this.intersections.length = 0

        this.raycaster = null
        this.pointer = null
    }
}
