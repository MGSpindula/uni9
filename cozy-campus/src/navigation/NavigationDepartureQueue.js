export class NavigationDepartureQueue {

    constructor() {

        this.queues = new Map();      // originId → request[]
        this.actorIndex = new Map();  // actor → Map<originId, request>
        this.sequence = 0;

    }

    enqueue(originId, actor, {
        rank = 0,
        priority = 0,
        kind = "request",
        payload = null,
        enqueuedAt = null
    } = {}) {

        const queue =
            this.queues.get(
                originId
            ) ??
            [];

        let request =
            this._getRequest(
                actor,
                originId
            );

        if (!request) {

            request = {
                actor,
                originId,

                order:
                    this.sequence++,

                rank,
                priority,
                kind,
                payload,
                enqueuedAt,

                granted:
                    false,

                grantedAt:
                    null
            };

            queue.push(
                request
            );

            this.sort(
                queue
            );

            this.queues.set(
                originId,
                queue
            );

            let actorEntries =
                this.actorIndex.get(
                    actor
                );

            if (!actorEntries) {

                actorEntries =
                    new Map();

                this.actorIndex.set(
                    actor,
                    actorEntries
                );

            }

            actorEntries.set(
                originId,
                request
            );

        } else {

            if (
                payload !== null
            ) {

                const previousMovementId =
                    request.payload
                        ?.movement
                        ?.id ??
                    null;

                const nextMovementId =
                    payload
                        ?.movement
                        ?.id ??
                    null;

                request.payload =
                    payload;

                if (
                    previousMovementId !==
                    nextMovementId
                ) {

                    request.granted =
                        false;

                    request.grantedAt =
                        null;

                }

            }

            if (
                rank > request.rank ||
                priority > request.priority
            ) {

                request.rank =
                    Math.max(
                        request.rank,
                        rank
                    );

                request.priority =
                    priority;

                request.kind =
                    kind;

                this.sort(
                    queue
                );

            }

        }

        return request;

    }

    sort(queue) {

        queue.sort((first, second) =>
            second.rank - first.rank ||
            // Rank describes physical urgency: an actor already occupying a
            // node must be allowed to leave before a remote Player lookahead.
            // Absolute passage wins only within the same operational phase;
            // otherwise it could trap the very NPC asked to clear the node.
            Number(second.actor.navigationPassagePolicy === "absolute") -
            Number(first.actor.navigationPassagePolicy === "absolute") ||
            second.priority - first.priority ||
            first.order - second.order
        );

    }

    getRequest(
        originId,
        actor
    ) {

        return this._getRequest(
            actor,
            originId
        );

    }

    getRequests(
        originId
    ) {

        return [
            ...(
                this.queues.get(
                    originId
                ) ??
                []
            )
        ];

    }

    setGranted(
        originId,
        actor,
        granted,
        grantedAt = null
    ) {

        const request =
            this._getRequest(
                actor,
                originId
            );

        if (!request) {

            return false;

        }

        request.granted =
            granted;

        request.grantedAt =
            granted

                ? grantedAt
                : null;

        return true;

    }

    clearGrants(
        originId
    ) {

        for (
            const request of
            this.queues.get(
                originId
            ) ??
            []
        ) {

            request.granted =
                false;

            request.grantedAt =
                null;

        }

    }

    _getRequest(actor, originId) {

        return this.actorIndex.get(actor)?.get(originId) ?? null;

    }

    isFirst(originId, actor) {

        return this.queues.get(originId)?.[0]?.actor === actor;

    }

    getFirst(originId) {

        return this.queues.get(originId)?.[0]?.actor ?? null;

    }

    getActorsBefore(originId, actor) {

        const queue = this.queues.get(originId) ?? [];
        const index = queue.findIndex(request => request.actor === actor);

        if (index <= 0) return [];

        return queue.slice(0, index).map(request => request.actor);

    }

    getActors(originId) {

        return (this.queues.get(originId) ?? [])
            .map(request => request.actor);

    }

    promote(originId, actor, {
        rank = 4,
        kind = "deadlock-release"
    } = {}) {

        const request = this._getRequest(actor, originId);

        if (!request) return false;

        request.rank = Math.max(request.rank, rank);
        request.kind = kind;
        this.sort(this.queues.get(originId));
        return this.isFirst(originId, actor);

    }

    hasAt(originId, actor) {

        return this.actorIndex
            .get(actor)
            ?.has(originId) ?? false;

    }

    has(actor) {

        return (this.actorIndex.get(actor)?.size ?? 0) > 0;

    }

    getActorRequest(actor) {

        const entries = this.actorIndex.get(actor);
        if (!entries || entries.size === 0) return null;

        for (const [originId, request] of entries) {

            const queue = this.queues.get(originId);
            if (!queue) continue;
            const index = queue.indexOf(request);
            if (index < 0) continue;

            return {
                originId,
                position: index + 1,
                length: queue.length,
                rank: request.rank,
                priority: request.priority,
                kind: request.kind
            };

        }

        return null;

    }

    complete(originId, actor) {

        const queue = this.queues.get(originId);
        if (!queue) return;

        const index = queue.findIndex(request => request.actor === actor);
        if (index >= 0) {

            queue.splice(index, 1);
            /* console.log(
                `[NavigationQueue] ✓ ${actor.name} completed "${originId}". ` +
                `Next: ${queue[0]?.actor.name ?? "none"}.`
            ); */

        }

        if (queue.length === 0) this.queues.delete(originId);

        const actorEntries = this.actorIndex.get(actor);
        if (actorEntries) {

            actorEntries.delete(originId);
            if (actorEntries.size === 0) this.actorIndex.delete(actor);

        }

    }

    cancel(actor) {

        const entries = this.actorIndex.get(actor);
        if (!entries) return;

        for (const originId of entries.keys()) {

            const queue = this.queues.get(originId);
            if (!queue) continue;

            const remaining = queue.filter(request => request.actor !== actor);

            if (remaining.length !== queue.length) {

                console.log(
                    `[NavigationQueue] × ${actor.name} cancelled ` +
                    `"${originId}". Next: ` +
                    `${remaining[0]?.actor.name ?? "none"}.`
                );

            }

            if (remaining.length > 0) this.queues.set(originId, remaining);
            else this.queues.delete(originId);

        }

        this.actorIndex.delete(actor);

    }

    debug() {

        const rows = [];

        for (const [originId, queue] of this.queues) {

            queue.forEach((request, index) => rows.push({
                origin: originId,
                position: index + 1,
                actor: request.actor.name,
                kind: request.kind,
                rank: request.rank,
                priority: request.priority,
                order: request.order
            }));

        }

        console.table(rows);

        return rows;

    }

}

