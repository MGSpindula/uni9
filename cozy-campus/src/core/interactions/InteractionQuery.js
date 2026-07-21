import * as THREE from "three";

export class InteractionQuery {

    constructor(targets) {

        this.targets = targets;
        this.worldPosition = new THREE.Vector3();

    }

    findNearest({
        actor,
        target = null,
        interactionId = null,
        tags = [],
        available = true,
        excludePoint = null,
        excludePoints = [],
        excludePointIds = []
    }) {

        if (!actor?.object3D) {

            return null;

        }

        const candidates =
            target
                ? [target]
                : this.targets;

        let nearest = null;

        let nearestDistanceSquared =
            Infinity;

        for (
            const candidate of
            candidates
        ) {

            if (!candidate) continue;

            const definitions =
                candidate
                    .getInteractionDefinitions?.() ??
                [];

            for (
                const definition of
                definitions
            ) {

                if (
                    definition.point ===
                    excludePoint ||
                    excludePoints.includes(definition.point) ||
                    excludePointIds.includes(definition.point.id)
                ) {

                    continue;

                }

                if (
                    interactionId &&
                    definition.id !==
                    interactionId
                ) {

                    continue;

                }

                if (
                    !definition.hasTags(tags)
                ) {

                    continue;

                }

                const context = {
                    actor,
                    target: candidate,
                    definition,
                    point:
                        definition.point
                };

                if (
                    available &&
                    !definition.canExecute(
                        context
                    )
                ) {

                    continue;

                }

                const position =
                    definition.point
                        .getWorldPosition(
                            this.worldPosition
                        );

                const distanceSquared =
                    actor.object3D.position
                        .distanceToSquared(
                            position
                        );

                if (
                    distanceSquared >=
                    nearestDistanceSquared
                ) {

                    continue;

                }

                nearestDistanceSquared =
                    distanceSquared;

                nearest = {
                    target: candidate,
                    definition,
                    point:
                        definition.point,

                    distanceSquared
                };

            }

        }

        return nearest;

    }

}
