export class NavigationDepartureQueue {

    constructor() {

        this.queues = new Map();      // originId → request[]
        this.actorIndex = new Map();  // actor → Map<originId, request>
        this.sequence = 0;

    }

    enqueue(originId, actor, { priority = 0 } = {}) {

        const queue = this.queues.get(originId) ?? [];
        let request = this._getRequest(actor, originId);

        if (!request) {

            request = {
                actor,
                originId,
                order: this.sequence++,
                priority
            };
            queue.push(request);
            queue.sort((first, second) =>
                second.priority - first.priority ||
                first.order - second.order
            );
            this.queues.set(originId, queue);

            let actorEntries = this.actorIndex.get(actor);
            if (!actorEntries) {
                actorEntries = new Map();
                this.actorIndex.set(actor, actorEntries);
            }
            actorEntries.set(originId, request);

            const position = queue.indexOf(request) + 1;
            console.log(
                `[NavigationQueue] + ${actor.name} queued at "${originId}" ` +
                `(position ${position}, ` +
                `${priority > 0 ? "transit priority" : "dwell"}).`
            );

        } else if (priority > request.priority) {

            request.priority = priority;
            queue.sort((first, second) =>
                second.priority - first.priority ||
                first.order - second.order
            );
            console.log(
                `[NavigationQueue] ↑ ${actor.name} promoted at ` +
                `"${originId}" (position ${queue.indexOf(request) + 1}).`
            );

        }

        return request;

    }

    _getRequest(actor, originId) {

        return this.actorIndex.get(actor)?.get(originId) ?? null;

    }

    isFirst(originId, actor) {

        return this.queues.get(originId)?.[0]?.actor === actor;

    }

    hasAt(originId, actor) {

        return this.actorIndex.get(actor)?.has(originId) ?? false;

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
                priority: request.priority
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
            console.log(
                `[NavigationQueue] ✓ ${actor.name} completed "${originId}". ` +
                `Next: ${queue[0]?.actor.name ?? "none"}.`
            );

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
                mode: request.priority > 0 ? "TRANSIT" : "DWELL",
                order: request.order
            }));

        }

        console.table(rows);

        return rows;

    }

}

