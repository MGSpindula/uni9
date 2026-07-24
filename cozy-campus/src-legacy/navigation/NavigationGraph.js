// Static navigation topology only: nodes, connections, costs and authored
// metadata. Actor occupancy belongs to NavigationTrafficState, path search to
// Pathfinder and portals/curves to RouteGeometryService.
export class NavigationGraph {

    constructor({ selectionRadius = 1.25 } = {}) {

        this.nodes = new Map();
        this.selectionRadius = selectionRadius;
        this.invalidNodeIds = new Set();
        this.validationErrors = [];
        this.revision = 0;

    }

    // -----------------------------
    // Nodes
    // -----------------------------

    addNode(id, position, metadata = {}) {

        if (!id || !position?.isVector3) {
            this.reportValidationError(
                "INVALID_NODE",
                `Node "${id ?? "<without id>"}" has invalid data.`
            );
            return null;
        }

        if (this.nodes.has(id) || this.invalidNodeIds.has(id)) {

            this.nodes.delete(id);

            for (const node of this.nodes.values()) {
                node.connections.delete(id);
            }

            this.invalidNodeIds.add(id);
            this.reportValidationError(
                "DUPLICATE_NODE_ID",
                `Duplicate node id "${id}". All copies were ignored.`
            );
            return null;

        }

        const node = {
            id,
            position: position.clone(),
            blocked: metadata.blocked ?? false,
            exclusive: metadata.exclusive ?? false,
            capacity: metadata.capacity ??
                (metadata.exclusive ? 1 : Infinity),
            metadata: { ...metadata },
            connections: new Map()
        };

        this.nodes.set(id, node);
        this.revision++;
        return node;

    }

    getNode(id) {

        return this.nodes.get(id) ?? null;

    }

    getNodeEntries() {

        return this.nodes.entries();

    }

    hasNode(id) {

        return this.nodes.has(id);

    }

    requireNode(id) {

        const node = this.getNode(id);

        if (!node) {
            throw new Error(`NavigationGraph does not contain node "${id}".`);
        }

        return node;

    }

    setNodePosition(id, position) {

        const node = this.requireNode(id);
        if (node.position.equals(position)) return;

        node.position.copy(position);
        this.revision++;

    }

    setNodeBlocked(id, blocked = true) {

        const node = this.requireNode(id);
        if (node.blocked === blocked) return;

        node.blocked = blocked;
        this.revision++;

    }

    isNodeBlocked(id) {

        return this.requireNode(id).blocked;

    }

    // -----------------------------
    // Connections
    // -----------------------------

    connect(fromId, toId, {
        bidirectional = true,
        metadata = {},
        laneWidth = 1.0,
        laneCapacity = 1
    } = {}) {

        const from =
            this.getNode(fromId);

        const to =
            this.getNode(toId);

        if (!from || !to) {

            this.reportValidationError(
                "INVALID_CONNECTION",
                `Connection "${fromId}" -> "${toId}" ` +
                `references a missing or invalid node.`
            );

            return null;

        }

        const delta =
            to.position.clone()
                .sub(from.position);

        const horizontalDistance =
            Math.hypot(
                delta.x,
                delta.z
            );

        const resource = {
            fromId,
            toId,

            blocked: false,

            laneWidth,

            /*
             * Duas lanes direcionais:
             *
             * lane 0: fromId → toId
             * lane 1: toId → fromId
             */
            laneCount: 2,

            /*
             * Capacidade máxima de cada lane.
             */
            laneCapacity,

            /*
             * Mantida para compatibilidade com
             * APIs genéricas que ainda consultam
             * resource.capacity.
             *
             * Não deve ser usada para controlar
             * uma lane individual.
             */
            capacity:
                metadata.capacity ??
                laneCapacity,

            metadata: {
                traversal:
                    "flat",

                slopeAngle:
                    Math.atan2(
                        Math.abs(delta.y),
                        horizontalDistance ||
                        Number.EPSILON
                    ),

                rise:
                    delta.y,

                ...metadata
            }
        };

        from.connections.set(
            toId,
            resource
        );

        if (bidirectional) {

            to.connections.set(
                fromId,
                resource
            );

        }

        this.revision++;

        return resource;

    }

    disconnect(fromId, toId, { bidirectional = true } = {}) {

        this.requireNode(fromId).connections.delete(toId);
        if (bidirectional) this.requireNode(toId).connections.delete(fromId);
        this.revision++;

    }

    requireConnection(fromId, toId) {

        const connection = this.requireNode(fromId).connections.get(toId);

        if (!connection) {
            throw new Error(
                `NavigationGraph nodes "${fromId}" and "${toId}" are not connected.`
            );
        }

        return connection;

    }

    areConnected(fromId, toId) {

        return this.requireNode(fromId).connections.has(toId);

    }

    setConnectionBlocked(fromId, toId, blocked = true) {

        const connection = this.requireConnection(fromId, toId);
        if (connection.blocked === blocked) return;

        connection.blocked = blocked;
        this.revision++;

    }

    isConnectionBlocked(fromId, toId) {

        return this.requireConnection(fromId, toId).blocked;

    }

    setConnectionPortalOffset(fromId, toId, nodeId, distance) {

        const connection = this.requireConnection(fromId, toId);

        if (nodeId !== connection.fromId && nodeId !== connection.toId) {
            this.reportValidationError(
                "INVALID_PORTAL_OFFSET",
                `Node "${nodeId}" is not an endpoint of "${fromId}" -> "${toId}".`
            );
            return false;
        }

        if (!Number.isFinite(distance) || distance < 0) {
            this.reportValidationError(
                "INVALID_PORTAL_OFFSET",
                `Portal offset for "${nodeId}" must be a non-negative number.`
            );
            return false;
        }

        connection.metadata.portalOffsets ??= {};
        connection.metadata.portalOffsets[nodeId] = distance;
        this.revision++;
        return true;

    }

    // -----------------------------
    // Structural validation
    // -----------------------------

    reportValidationError(type, message) {

        const error = { type, message };
        this.validationErrors.push(error);
        console.log(`[NavigationGraph:${type}] ${message}`);
        return error;

    }

    isValid() {

        return this.validationErrors.length === 0;

    }

    getPathNodes(nodeIds) {

        const nodes = nodeIds.map(id => this.requireNode(id));

        for (let index = 0; index < nodes.length - 1; index++) {

            const current = nodes[index];
            const next = nodes[index + 1];
            const connection = current.connections.get(next.id);

            if (!connection || connection.blocked || next.blocked) {
                throw new Error(
                    `NavigationGraph route "${current.id}" -> "${next.id}" is blocked.`
                );
            }

        }

        return nodes;

    }

}
