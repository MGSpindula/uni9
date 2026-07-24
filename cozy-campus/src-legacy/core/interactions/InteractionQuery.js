import * as THREE from "three";

// Query Object: enumerates facts, but does not decide what an NPC should do.
// Players may still ask for the nearest exact match; autonomous actors pass
// these candidates to a behavioral selection strategy.
export class InteractionQuery {

    constructor(targets) {

        this.targets = targets;
        this.worldPosition = new THREE.Vector3();

    }

    findCandidates({
        actor,
        target = null,
        interactionId = null,
        tags = [],
        available = true,
        includeTemporarilyUnavailable = false,
        excludePoint = null,
        excludePoints = [],
        excludePointIds = []
    }) {

        if (!actor?.object3D) return [];

        const targets = target ? [target] : this.targets;
        const results = [];

        for (const candidateTarget of targets) {

            if (!candidateTarget) continue;

            const definitions =
                candidateTarget.getInteractionDefinitions?.() ?? [];

            for (const definition of definitions) {

                if (definition.point === excludePoint ||
                    excludePoints.includes(definition.point) ||
                    excludePointIds.includes(definition.point.id)) continue;
                if (interactionId && definition.id !== interactionId) continue;
                if (!definition.hasTags(tags)) continue;

                const context = {
                    actor,
                    target: candidateTarget,
                    definition,
                    point: definition.point
                };

                if (!definition.canConsider(context)) continue;
                if (available &&
                    !includeTemporarilyUnavailable &&
                    !definition.canExecute(context)) continue;

                const position = definition.point.getWorldPosition(
                    this.worldPosition
                );

                results.push({
                    target: candidateTarget,
                    definition,
                    point: definition.point,
                    distanceSquared: actor.object3D.position
                        .distanceToSquared(position),
                    temporarilyAvailable: definition.canExecute(context)
                });

            }

        }

        return results;

    }

    findNearest(request) {

        const candidates = this.findCandidates(request);

        if (candidates.length === 0) return null;

        return candidates.reduce((nearest, candidate) =>
            candidate.distanceSquared < nearest.distanceSquared
                ? candidate
                : nearest
        );

    }

}
