export class World {
    constructor({ id = "world", scene, services }) {
        if (!scene) {
            throw new TypeError("World requires a Three.js scene.")
        }

        if (!services) {
            throw new TypeError("World requires GameServices.")
        }

        this.id = id
        this.scene = scene
        this.services = services

        this.entities = []
        this.characters = []
        this.controllers = []
        this.sceneObjects = []

        this.entitySet = new Set()
        this.characterSet = new Set()
        this.controllerSet = new Set()

        this.disposed = false
    }

    addEntity(entity) {
        this.assertUsable()

        if (!entity?.object3D) {
            throw new TypeError("An entity must expose object3D.")
        }

        if (this.entitySet.has(entity)) {
            return entity
        }

        this.entitySet.add(entity)
        this.entities.push(entity)

        this.scene.add(entity.object3D)

        try {
            entity.register?.(this.services.registry)
        } catch (error) {
            this.scene.remove(entity.object3D)

            this.entitySet.delete(entity)

            this.removeFromArray(this.entities, entity)

            throw error
        }

        return entity
    }

    removeEntity(entity, { dispose = true } = {}) {
        if (!this.entitySet.has(entity)) {
            return false
        }

        if (this.characterSet.has(entity)) {
            this.removeCharacter(entity, { dispose })

            return true
        }

        entity.unregister?.(this.services.registry)

        this.scene.remove(entity.object3D)

        this.entitySet.delete(entity)

        this.removeFromArray(this.entities, entity)

        if (dispose) {
            entity.dispose?.()
        }

        return true
    }

    addCharacter(character, navigationOptions = {}) {
        this.assertUsable()

        if (this.characterSet.has(character)) {
            return character
        }

        this.addEntity(character)

        try {
            this.services.navigation.register(character, navigationOptions)
        } catch (error) {
            this.removeEntity(character, { dispose: false })

            throw error
        }

        this.characterSet.add(character)

        this.characters.push(character)

        return character
    }

    removeCharacter(character, { dispose = true } = {}) {
        if (!this.characterSet.has(character)) {
            return false
        }

        this.services.navigation.unregister(character)

        this.characterSet.delete(character)

        this.removeFromArray(this.characters, character)

        character.unregister?.(this.services.registry)

        this.scene.remove(character.object3D)

        this.entitySet.delete(character)

        this.removeFromArray(this.entities, character)

        if (dispose) {
            character.dispose?.()
        }

        return true
    }

    addController(controller) {
        this.assertUsable()

        if (!controller || typeof controller.update !== "function") {
            throw new TypeError(
                "A controller must implement update(delta, context).",
            )
        }

        if (this.controllerSet.has(controller)) {
            return controller
        }

        this.controllerSet.add(controller)

        this.controllers.push(controller)

        return controller
    }

    removeController(controller, { dispose = true } = {}) {
        if (!this.controllerSet.has(controller)) {
            return false
        }

        this.controllerSet.delete(controller)

        this.removeFromArray(this.controllers, controller)

        if (dispose) {
            controller.dispose?.()
        }

        return true
    }

    addSceneObject(object3D, { dispose = null } = {}) {
        this.assertUsable()

        if (!object3D?.isObject3D) {
            throw new TypeError("addSceneObject requires a Three.js Object3D.")
        }

        this.scene.add(object3D)

        this.sceneObjects.push({
            object3D,
            dispose,
        })

        return object3D
    }

    updateControllers(delta, context) {
        for (let index = 0; index < this.controllers.length; index += 1) {
            const controller = this.controllers[index]

            if (controller.enabled === false) {
                continue
            }

            controller.update(delta, context)
        }
    }

    updateEntities(delta, context) {
        for (let index = 0; index < this.entities.length; index += 1) {
            const entity = this.entities[index]

            if (entity.isActive?.() === false) {
                continue
            }

            entity.update?.(delta, context)
        }
    }

    requiresContinuousRender() {
        for (let index = 0; index < this.entities.length; index += 1) {
            const entity = this.entities[index]

            if (entity.isActive?.() === false) {
                continue
            }

            if (entity.requiresContinuousRender?.()) {
                return true
            }
        }

        return false
    }

    removeFromArray(array, value) {
        const index = array.indexOf(value)

        if (index !== -1) {
            array.splice(index, 1)
        }
    }

    assertUsable() {
        if (this.disposed) {
            throw new Error(`World "${this.id}" is already disposed.`)
        }
    }

    dispose() {
        if (this.disposed) {
            return
        }

        this.disposed = true

        for (let index = this.controllers.length - 1; index >= 0; index -= 1) {
            this.controllers[index].dispose?.()
        }

        for (let index = this.characters.length - 1; index >= 0; index -= 1) {
            this.services.navigation.unregister(this.characters[index])
        }

        for (let index = this.entities.length - 1; index >= 0; index -= 1) {
            const entity = this.entities[index]

            entity.unregister?.(this.services.registry)

            this.scene.remove(entity.object3D)

            entity.dispose?.()
        }

        for (let index = this.sceneObjects.length - 1; index >= 0; index -= 1) {
            const record = this.sceneObjects[index]

            this.scene.remove(record.object3D)

            record.dispose?.(record.object3D)
        }

        this.entities.length = 0
        this.characters.length = 0
        this.controllers.length = 0
        this.sceneObjects.length = 0

        this.entitySet.clear()
        this.characterSet.clear()
        this.controllerSet.clear()
    }
}
