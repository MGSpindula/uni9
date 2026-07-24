const EMPTY_TARGETS = Object.freeze([])

export class EntityRegistry {
    constructor() {
        this.records = new Map()

        this.entitiesById = new Map()

        this.targetOwners = new WeakMap()

        this.raycastTargets = []
        this.raycastTargetsDirty = false

        this.version = 0
    }

    register(entity) {
        if (!entity?.id) {
            throw new TypeError(
                "EntityRegistry.register requires an entity with an id.",
            )
        }

        if (this.records.has(entity)) {
            return entity
        }

        const entityWithSameId = this.entitiesById.get(entity.id)

        if (entityWithSameId && entityWithSameId !== entity) {
            throw new Error(`Entity id "${entity.id}" is already registered.`)
        }

        const record = {
            entity,
            targets: [],
        }

        this.records.set(entity, record)

        this.entitiesById.set(entity.id, entity)

        this.updateRecordTargets(record)

        this.markChanged()

        return entity
    }

    unregister(entity) {
        const record = this.records.get(entity)

        if (!record) {
            return false
        }

        this.removeRecordTargets(record)

        this.records.delete(entity)

        if (this.entitiesById.get(entity.id) === entity) {
            this.entitiesById.delete(entity.id)
        }

        this.markChanged()

        return true
    }

    refresh(entity) {
        const record = this.records.get(entity)

        if (!record) {
            return false
        }

        this.removeRecordTargets(record)

        this.updateRecordTargets(record)

        this.markChanged()

        return true
    }

    updateRecordTargets(record) {
        const targets =
            record.entity.getInteractableObjects?.() ?? EMPTY_TARGETS

        for (let index = 0; index < targets.length; index += 1) {
            const target = targets[index]

            if (!target?.isObject3D) {
                continue
            }

            const currentOwner = this.targetOwners.get(target)

            if (currentOwner && currentOwner !== record.entity) {
                throw new Error(
                    `An interactable Object3D cannot belong to both "${currentOwner.id}" and "${record.entity.id}".`,
                )
            }

            this.targetOwners.set(target, record.entity)

            record.targets.push(target)
        }
    }

    removeRecordTargets(record) {
        for (let index = 0; index < record.targets.length; index += 1) {
            const target = record.targets[index]

            if (this.targetOwners.get(target) === record.entity) {
                this.targetOwners.delete(target)
            }
        }

        record.targets.length = 0
    }

    getEntity(id) {
        return this.entitiesById.get(id) ?? null
    }

    has(entity) {
        return this.records.has(entity)
    }

    resolveEntity(object) {
        let current = object

        while (current) {
            const entity = this.targetOwners.get(current)

            if (entity) {
                return entity
            }

            current = current.parent
        }

        return null
    }

    getRaycastTargets() {
        if (!this.raycastTargetsDirty) {
            return this.raycastTargets
        }

        this.raycastTargets.length = 0

        for (const record of this.records.values()) {
            for (let index = 0; index < record.targets.length; index += 1) {
                this.raycastTargets.push(record.targets[index])
            }
        }

        this.raycastTargetsDirty = false

        return this.raycastTargets
    }

    markChanged() {
        this.version += 1

        this.raycastTargetsDirty = true
    }

    clear() {
        for (const record of this.records.values()) {
            this.removeRecordTargets(record)
        }

        this.records.clear()
        this.entitiesById.clear()

        this.raycastTargets.length = 0

        this.raycastTargetsDirty = false

        this.version += 1
    }

    get size() {
        return this.records.size
    }
}
