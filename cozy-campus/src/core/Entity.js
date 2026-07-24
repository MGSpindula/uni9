import { EventDispatcher, Group } from "three"

import { Tween } from "./Tween.js"

const EMPTY_OBJECTS = Object.freeze([])

let nextEntityId = 1

function disposeMaterial(material) {
    if (!material) {
        return
    }

    if (Array.isArray(material)) {
        for (let index = 0; index < material.length; index += 1) {
            material[index]?.dispose?.()
        }

        return
    }

    material.dispose?.()
}

function disposeOwnedObject3D(root) {
    root.traverse((object) => {
        object.geometry?.dispose?.()

        disposeMaterial(object.material)
    })
}

export class Entity extends EventDispatcher {
    constructor({
        id = null,
        name = null,
        object3D = null,
        active = true,
        visible = true,
        interactive = false,
        disposeResources = false,
    } = {}) {
        super()

        this.id = id ?? `entity-${nextEntityId++}`

        this.name = name ?? this.id

        this.object3D = object3D ?? new Group()

        if (!this.object3D?.isObject3D) {
            throw new TypeError("Entity object3D must be a Three.js Object3D.")
        }

        this.object3D.name = this.object3D.name || this.name

        this.active = Boolean(active)

        this.visible = Boolean(visible)

        this.interactive = false

        this.disposeResources = Boolean(disposeResources)

        this.registry = null
        this.tweens = null
        this.interactableObjects = null

        this.disposed = false

        this.object3D.visible = this.visible

        if (interactive) {
            this.setInteractive(true)
        }
    }

    register(registry) {
        this.assertUsable()

        if (!registry) {
            throw new TypeError("Entity.register requires an EntityRegistry.")
        }

        if (this.registry && this.registry !== registry) {
            throw new Error(
                `Entity "${this.id}" is already registered in another registry.`,
            )
        }

        if (this.registry === registry) {
            return this
        }

        registry.register(this)

        this.registry = registry

        return this
    }

    unregister(registry = this.registry) {
        if (!registry) {
            return false
        }

        const removed = registry.unregister(this)

        if (registry === this.registry) {
            this.registry = null
        }

        return removed
    }

    setActive(active) {
        const nextActive = Boolean(active)

        if (nextActive === this.active) {
            return false
        }

        this.active = nextActive

        this.registry?.refresh(this)

        return true
    }

    isActive() {
        return this.active && !this.disposed
    }

    setVisible(visible) {
        const nextVisible = Boolean(visible)

        if (nextVisible === this.visible) {
            return false
        }

        this.visible = nextVisible

        this.object3D.visible = nextVisible

        this.registry?.refresh(this)

        return true
    }

    setInteractive(interactive) {
        const nextInteractive = Boolean(interactive)

        if (nextInteractive === this.interactive) {
            return false
        }

        this.interactive = nextInteractive

        if (nextInteractive && !this.interactableObjects) {
            this.interactableObjects = [this.object3D]
        }

        this.registry?.refresh(this)

        return true
    }

    setInteractableObjects(objects) {
        if (objects == null) {
            this.interactableObjects = null

            this.interactive = false

            this.registry?.refresh(this)

            return this
        }

        if (!Array.isArray(objects)) {
            throw new TypeError(
                "Entity.setInteractableObjects requires an array or null.",
            )
        }

        const uniqueObjects = []
        const seen = new Set()

        for (let index = 0; index < objects.length; index += 1) {
            const object = objects[index]

            if (!object?.isObject3D) {
                throw new TypeError(
                    "Every interactable object must be a Three.js Object3D.",
                )
            }

            if (seen.has(object)) {
                continue
            }

            seen.add(object)

            uniqueObjects.push(object)
        }

        this.interactableObjects =
            uniqueObjects.length > 0 ? uniqueObjects : null

        this.interactive = this.interactableObjects !== null

        this.registry?.refresh(this)

        return this
    }

    addInteractableObject(object) {
        if (!object?.isObject3D) {
            throw new TypeError(
                "Entity.addInteractableObject requires a Three.js Object3D.",
            )
        }

        if (!this.interactableObjects) {
            this.interactableObjects = []
        }

        if (!this.interactableObjects.includes(object)) {
            this.interactableObjects.push(object)
        }

        this.interactive = true

        this.registry?.refresh(this)

        return object
    }

    removeInteractableObject(object) {
        if (!this.interactableObjects) {
            return false
        }

        const index = this.interactableObjects.indexOf(object)

        if (index === -1) {
            return false
        }

        this.interactableObjects.splice(index, 1)

        if (this.interactableObjects.length === 0) {
            this.interactableObjects = null

            this.interactive = false
        }

        this.registry?.refresh(this)

        return true
    }

    getInteractableObjects() {
        if (
            !this.interactive ||
            !this.active ||
            !this.visible ||
            this.disposed
        ) {
            return EMPTY_OBJECTS
        }

        return this.interactableObjects ?? EMPTY_OBJECTS
    }

    getSelectionObject() {
        return this.object3D
    }

    addTween(tween) {
        this.assertUsable()

        if (!(tween instanceof Tween)) {
            throw new TypeError("Entity.addTween requires a Tween.")
        }

        if (!this.tweens) {
            this.tweens = []
        }

        this.tweens.push(tween)

        return tween
    }

    tween(options) {
        return this.addTween(new Tween(options))
    }

    cancelTweens({ complete = false } = {}) {
        if (!this.tweens) {
            return
        }

        for (let index = 0; index < this.tweens.length; index += 1) {
            const tween = this.tweens[index]

            tween.cancel({
                complete,
            })

            tween.dispose()
        }

        this.tweens.length = 0
        this.tweens = null
    }

    update(delta, context) {
        if (!this.isActive()) {
            return
        }

        this.updateTweens(delta)

        this.onUpdate(delta, context)
    }

    updateTweens(delta) {
        if (!this.tweens) {
            return
        }

        let writeIndex = 0

        for (
            let readIndex = 0;
            readIndex < this.tweens.length;
            readIndex += 1
        ) {
            const tween = this.tweens[readIndex]

            tween.update(delta)

            if (tween.isActive()) {
                this.tweens[writeIndex] = tween

                writeIndex += 1
            } else {
                tween.dispose()
            }
        }

        this.tweens.length = writeIndex

        if (writeIndex === 0) {
            this.tweens = null
        }
    }

    onUpdate() {}

    onPointerEnter() {}

    onPointerMove() {}

    onPointerLeave() {}

    onPrimaryAction() {}

    requiresContinuousRender() {
        return Boolean(this.tweens?.length)
    }

    assertUsable() {
        if (this.disposed) {
            throw new Error(`Entity "${this.id}" is already disposed.`)
        }
    }

    dispose() {
        if (this.disposed) {
            return
        }

        this.unregister()
        this.cancelTweens()

        this.disposed = true
        this.active = false
        this.interactive = false

        if (this.disposeResources) {
            disposeOwnedObject3D(this.object3D)
        }

        this.object3D.removeFromParent()

        this.interactableObjects = null

        this.object3D = null
    }
}

// Subclasses não devem sobrescrever update() sem necessidade. Use onUpdate():
// onUpdate(
//     delta,
//     context
// ) {
//    ... Atualização específica.
// }
