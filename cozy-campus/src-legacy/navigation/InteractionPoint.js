import * as THREE from "three";

export class InteractionPoint {

    constructor(id, {
        position = new THREE.Vector3(),
        rotationY = 0,
        accessible = true,
        maxConnectionDistance = 3,
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

        // Access authoring:
        // - null: project automatically on the nearest graph segment;
        // - "node-id": simple direct curve to/from that node, with no anchor;
        // - ["a", "b"]: force a segment projection with lane portals.
        // Explicit access is allowed at any distance; maxConnectionDistance is
        // only a safety radius for automatic projection.
        this.connectTo = connectTo;
        this.via = via;

        this.capacity = capacity;
        this.terminal = terminal;

        // Runtime ownership belongs to InteractionTrafficState. These getters
        // below expose a read/write view for debug and authored callbacks while
        // keeping operational data out of the point definition itself.
        this.trafficState = null;

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

        return this.trafficState
            ? this.trafficState.isPointAvailable(this, actor)
            : this.accessible;

    }

    get occupants() {
        return this.trafficState?.getPointState(this).occupants ?? new Set();
    }

    get reservations() {
        return this.trafficState?.getPointState(this).reservations ?? new Set();
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
