import * as THREE from "three";

export class InteractionPoint {

    constructor(id, {
        position = new THREE.Vector3(),
        rotationY = 0,
        accessible = true,
        maxConnectionDistance = 2,
        connectTo = null,
        via = null,
        capacity = 1,
        terminal = true,
        metadata = {}
    } = {}) {

        if (!id) {

            throw new Error(
                "InteractionPoint requires an id."
            );

        }

        this.id = id;
        this.accessible = accessible;
        this.maxConnectionDistance =
            maxConnectionDistance;

        this.connectTo = connectTo;
        this.via = via;

        this.capacity = capacity;
        this.terminal = terminal;

        this.occupants = new Set();
        this.reservations = new Set();

        this.metadata = {
            ...metadata
        };

        this.object3D =
            new THREE.Object3D();

        this.object3D.name =
            `InteractionPoint:${id}`;

        this.object3D.position.copy(
            position
        );

        this.object3D.rotation.y =
            rotationY;

        this.entity = null;
        this.connection = null;

    }

    attach(entity) {

        if (!entity?.object3D) {

            throw new Error(
                `InteractionPoint "${this.id}" ` +
                `cannot attach to entity ` +
                `"${entity?.name ?? "unknown"}": ` +
                `the entity has no object3D.`
            );

        }

        this.entity = entity;

        entity.object3D.add(
            this.object3D
        );

        return this;

    }

    isAvailable(actor = null) {

        const users = new Set([
            ...this.occupants,
            ...this.reservations
        ]);

        if (actor) {

            users.delete(actor);

        }

        return (
            this.accessible &&
            users.size < this.capacity
        );

    }

    getWorldPosition(
        target = new THREE.Vector3()
    ) {

        this.object3D.updateWorldMatrix(
            true,
            false
        );

        return this.object3D
            .getWorldPosition(target);

    }

    getWorldDirection(
        target = new THREE.Vector3()
    ) {

        this.object3D.updateWorldMatrix(
            true,
            false
        );

        target
            .set(0, 0, 1)
            .applyQuaternion(
                this.object3D
                    .getWorldQuaternion(
                        new THREE.Quaternion()
                    )
            );

        target.y = 0;

        return target.lengthSq() > 0.0001
            ? target.normalize()
            : target.set(0, 0, 1);

    }

}