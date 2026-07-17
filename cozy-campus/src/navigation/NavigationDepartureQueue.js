export class NavigationDepartureQueue {

    constructor() {

        this.queues = new Map();
        this.sequence = 0;

    }

    enqueue(originId, actor, { priority = 0 } = {}) {

        const queue = this.queues.get(originId) ?? [];
        let request = queue.find(candidate => candidate.actor === actor);

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

    isFirst(originId, actor) {

        return this.queues.get(originId)?.[0]?.actor === actor;

    }

    has(actor) {

        for (const queue of this.queues.values()) {

            if (queue.some(request => request.actor === actor)) return true;

        }

        return false;

    }

    getActorRequest(actor) {

        for (const [originId, queue] of this.queues) {

            const index = queue.findIndex(request => request.actor === actor);

            if (index >= 0) return {
                originId,
                position: index + 1,
                length: queue.length,
                priority: queue[index].priority
            };

        }

        return null;

    }

    complete(originId, actor) {

        const queue = this.queues.get(originId);

        if (!queue) return;

        const index = queue.findIndex(request => request.actor === actor);

        if (index >= 0) queue.splice(index, 1);
        if (index >= 0) {

            console.log(
                `[NavigationQueue] ✓ ${actor.name} completed "${originId}". ` +
                `Next: ${queue[0]?.actor.name ?? "none"}.`
            );

        }

        if (queue.length === 0) this.queues.delete(originId);

    }

    cancel(actor) {

        for (const [originId, queue] of this.queues) {

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
