import { Input } from "./Input.js"

import { Raycast } from "./Raycast.js"

export class SelectionManager {
    constructor({ camera, registry, element, onChanged = null }) {
        if (!camera) {
            throw new TypeError("SelectionManager requires a camera.")
        }

        if (!registry) {
            throw new TypeError("SelectionManager requires an EntityRegistry.")
        }

        this.camera = camera
        this.registry = registry
        this.onChanged = onChanged

        this.input = new Input({
            element,
        })

        this.raycast = new Raycast()

        this.effects = new Set()

        this.primaryActionListeners = new Set()

        this.hoveredEntity = null
        this.hoveredObject = null

        this.hoveredIntersection = null

        this.lastPointerVersion = -1

        this.lastPrimaryActionVersion = this.input.primaryActionVersion

        this.lastRegistryVersion = -1

        this.enabled = true
        this.disposed = false
    }

    addEffect(effect) {
        if (
            !effect ||
            typeof effect.setSelection !== "function" ||
            typeof effect.clearSelection !== "function"
        ) {
            throw new TypeError(
                "SelectionManager effects must implement setSelection() and clearSelection().",
            )
        }

        this.effects.add(effect)

        this.syncEffects()

        return effect
    }

    removeEffect(effect) {
        if (!this.effects.delete(effect)) {
            return false
        }

        effect.clearSelection()

        return true
    }

    onPrimaryAction(listener) {
        if (typeof listener !== "function") {
            throw new TypeError(
                "SelectionManager.onPrimaryAction requires a function.",
            )
        }

        this.primaryActionListeners.add(listener)

        return () => {
            this.primaryActionListeners.delete(listener)
        }
    }

    setEnabled(enabled) {
        const nextEnabled = Boolean(enabled)

        if (nextEnabled === this.enabled) {
            return false
        }

        this.enabled = nextEnabled

        this.input.setEnabled(nextEnabled)

        if (!nextEnabled) {
            this.clearHover()
        }

        return true
    }

    update() {
        if (this.disposed || !this.enabled) {
            return false
        }

        const pointerChanged =
            this.input.pointerVersion !== this.lastPointerVersion

        const actionChanged =
            this.input.primaryActionVersion !== this.lastPrimaryActionVersion

        const registryChanged =
            this.registry.version !== this.lastRegistryVersion

        if (!pointerChanged && !actionChanged && !registryChanged) {
            return false
        }

        this.lastPointerVersion = this.input.pointerVersion

        this.lastPrimaryActionVersion = this.input.primaryActionVersion

        this.lastRegistryVersion = this.registry.version

        if (!this.input.pointerInside) {
            return this.clearHover()
        }

        const targets = this.registry.getRaycastTargets()

        const intersection = this.raycast.firstFromCamera(
            this.input.pointer,
            this.camera,
            targets,
        )

        const entity = intersection
            ? this.registry.resolveEntity(intersection.object)
            : null

        let changed = this.setHover(entity, intersection)

        if (actionChanged) {
            this.dispatchPrimaryAction(entity, intersection)

            changed = true
        }

        if (changed) {
            this.onChanged?.()
        }

        return changed
    }

    dispatchPrimaryAction(entity, intersection) {
        entity?.onPrimaryAction?.(intersection, this)

        entity?.dispatchEvent?.({
            type: "primaryaction",

            intersection,
            selection: this,
        })

        for (const listener of this.primaryActionListeners) {
            listener(entity, intersection, this)
        }
    }

    setHover(entity, intersection) {
        const object = intersection?.object ?? null

        if (entity === this.hoveredEntity) {
            const objectChanged = object !== this.hoveredObject

            this.hoveredObject = object

            this.hoveredIntersection = intersection

            entity?.onPointerMove?.(intersection, this)

            if (objectChanged) {
                this.syncEffects()
            }

            return objectChanged
        }

        const previousEntity = this.hoveredEntity

        const previousIntersection = this.hoveredIntersection

        this.hoveredEntity = entity

        this.hoveredObject = object

        this.hoveredIntersection = intersection

        if (previousEntity) {
            previousEntity.onPointerLeave?.(previousIntersection, this)

            previousEntity.dispatchEvent?.({
                type: "pointerleave",

                intersection: previousIntersection,

                selection: this,
            })
        }

        if (entity) {
            entity.onPointerEnter?.(intersection, this)

            entity.dispatchEvent?.({
                type: "pointerenter",

                intersection,
                selection: this,
            })
        }

        this.syncEffects()

        return true
    }

    clearHover() {
        if (!this.hoveredEntity) {
            return false
        }

        const previousEntity = this.hoveredEntity

        const previousIntersection = this.hoveredIntersection

        this.hoveredEntity = null
        this.hoveredObject = null

        this.hoveredIntersection = null

        previousEntity.onPointerLeave?.(previousIntersection, this)

        previousEntity.dispatchEvent?.({
            type: "pointerleave",

            intersection: previousIntersection,

            selection: this,
        })

        this.syncEffects()
        this.onChanged?.()

        return true
    }

    syncEffects() {
        if (!this.hoveredEntity) {
            this.clearEffects()
            return
        }

        const selectionObject =
            typeof this.hoveredEntity.getSelectionObject === "function"
                ? this.hoveredEntity.getSelectionObject(
                      this.hoveredObject,
                      this.hoveredIntersection,
                  )
                : this.hoveredEntity.object3D

        if (!selectionObject) {
            this.clearEffects()
            return
        }

        for (const effect of this.effects) {
            effect.setSelection(selectionObject)
        }
    }

    clearEffects() {
        for (const effect of this.effects) {
            effect.clearSelection()
        }
    }

    dispose() {
        if (this.disposed) {
            return
        }

        this.disposed = true

        this.clearHover()
        this.clearEffects()

        this.effects.clear()

        this.primaryActionListeners.clear()

        this.input.dispose()
        this.raycast.dispose()

        this.input = null
        this.raycast = null
        this.camera = null
        this.registry = null
        this.onChanged = null
    }
}
