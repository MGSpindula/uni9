export class NavigationDebugPanel {

    constructor({
        graph,
        connector,
        occupancyDuration = 3000,
        setNodeBlocked,
        setConnectionBlocked,
        occupyNode,
        releaseNode,
        occupyConnection,
        releaseConnection,
        occupyInteractionPoint,
        releaseInteractionPoint
    }) {

        this.graph = graph;
        this.connector = connector;
        this.occupancyDuration = occupancyDuration;

        this.actions = {
            setNodeBlocked,
            setConnectionBlocked,
            occupyNode,
            releaseNode,
            occupyConnection,
            releaseConnection,
            occupyInteractionPoint,
            releaseInteractionPoint
        };

        // Stable tokens are required to release the same simulated occupant later.
        this.occupants = new Map();
        this.timers = new Map();

        this.element = document.createElement("aside");
        this.element.className = "navigation-debug";

        document.body.appendChild(this.element);

        this.render();

    }

    // -----------------------------
    // Rendering
    // -----------------------------

    render() {

        const wasCollapsed = this.element.classList.contains("collapsed");

        this.element.replaceChildren();
        this.element.classList.toggle("collapsed", wasCollapsed);

        const header = document.createElement("header");
        const title = document.createElement("strong");
        const toggle = document.createElement("button");

        title.textContent = "Navigation Debug";
        toggle.textContent = wasCollapsed ? "+" : "−";
        toggle.title = wasCollapsed ? "Expandir" : "Recolher";
        toggle.addEventListener("click", () => {

            this.element.classList.toggle("collapsed");
            this.render();

        });

        header.append(title, toggle);
        this.element.append(header);

        const content = document.createElement("div");
        content.className = "navigation-debug-content";

        content.append(this.createSectionTitle("Nodes"));

        for (const node of this.graph.nodes.values()) {

            content.append(this.createNodeRow(node));

        }

        content.append(this.createSectionTitle("Connections"));

        for (const connection of this.getUniqueConnections()) {

            content.append(this.createConnectionRow(connection));

        }

        content.append(this.createSectionTitle("Interaction Points"));

        for (const point of this.connector?.points.values() ?? []) {

            content.append(this.createInteractionPointRow(point));

        }

        this.element.append(content);

    }

    createSectionTitle(text) {

        const title = document.createElement("h3");
        title.textContent = text;

        return title;

    }

    createNodeRow(node) {

        const key = `node:${node.id}`;
        const status = node.occupants.size > 0 && !node.exclusive
            ? "passable"
            : this.getResourceStatus(node);
        const row = this.createResourceRow(
            node.id,
            status
        );

        row.append(
            this.createButton(
                node.blocked ? "Unblock" : "Block",
                () => this.actions.setNodeBlocked(node.id, !node.blocked)
            ),
            this.createButton(
                "Occupy 3s",
                () => this.occupyTemporarily(
                    key,
                    occupant => this.actions.occupyNode(node.id, occupant),
                    occupant => this.actions.releaseNode(node.id, occupant)
                )
            )
        );

        return row;

    }

    createConnectionRow({ fromId, toId, resource }) {

        const key = `connection:${fromId}:${toId}`;
        const row = this.createResourceRow(
            `${fromId} ↔ ${toId}`,
            this.getResourceStatus(resource)
        );

        row.append(
            this.createButton(
                resource.blocked ? "Unblock" : "Block",
                () => this.actions.setConnectionBlocked(
                    fromId,
                    toId,
                    !resource.blocked
                )
            ),
            this.createButton(
                "Occupy 3s",
                () => this.occupyTemporarily(
                    key,
                    occupant => this.actions.occupyConnection(
                        fromId,
                        toId,
                        occupant
                    ),
                    occupant => this.actions.releaseConnection(
                        fromId,
                        toId,
                        occupant
                    )
                )
            )
        );

        return row;

    }

    createInteractionPointRow(point) {

        const key = `interaction:${point.id}`;
        const row = this.createResourceRow(
            point.id,
            this.getResourceStatus(point)
        );

        row.append(
            this.createButton(
                "Occupy 3s",
                () => this.occupyTemporarily(
                    key,
                    occupant => this.actions.occupyInteractionPoint(
                        point.id,
                        occupant
                    ),
                    occupant => this.actions.releaseInteractionPoint(
                        point.id,
                        occupant
                    )
                )
            )
        );

        return row;

    }

    createResourceRow(label, status) {

        const row = document.createElement("div");
        const name = document.createElement("span");
        const badge = document.createElement("small");

        row.className = "navigation-debug-row";
        name.className = "navigation-debug-name";
        badge.className = `navigation-debug-status ${status}`;

        name.textContent = label;
        badge.textContent = status;

        row.append(name, badge);

        return row;

    }

    createButton(label, action) {

        const button = document.createElement("button");

        button.textContent = label;
        button.addEventListener("click", () => {

            action();
            this.render();

        });

        return button;

    }

    getResourceStatus(resource) {

        if (resource.accessible === false) return "inaccessible";
        if (resource.blocked) return "blocked";
        if (resource.occupants.size > 0) return "occupied";
        if (resource.reservations.size > 0) return "reserved";

        return "free";

    }

    getUniqueConnections() {

        const connections = [];
        const visited = new Set();

        for (const node of this.graph.nodes.values()) {

            for (const [neighborId, resource] of node.connections) {

                const key = [node.id, neighborId].sort().join(":");

                if (visited.has(key)) continue;

                visited.add(key);
                connections.push({
                    fromId: node.id,
                    toId: neighborId,
                    resource
                });

            }

        }

        return connections;

    }

    // -----------------------------
    // Temporary occupancy
    // -----------------------------

    occupyTemporarily(key, occupy, release) {

        const occupant = this.getOccupant(key);

        if (!occupy(occupant)) {

            console.warn(`[Navigation Debug] Não foi possível ocupar ${key}.`);
            return;

        }

        window.clearTimeout(this.timers.get(key));

        this.timers.set(key, window.setTimeout(() => {

            release(occupant);
            this.timers.delete(key);
            this.render();

        }, this.occupancyDuration));

        this.render();

    }

    getOccupant(key) {

        if (!this.occupants.has(key)) {

            this.occupants.set(key, {
                id: `navigation-debug:${key}`
            });

        }

        return this.occupants.get(key);

    }

    // -----------------------------
    // Lifecycle
    // -----------------------------

    dispose() {

        for (const timer of this.timers.values()) {

            window.clearTimeout(timer);

        }

        this.timers.clear();
        this.element.remove();

    }

}
