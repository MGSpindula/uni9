import * as THREE from "three";

export class NavigationGraphHelper extends THREE.Group {

    constructor(graph, {
        connector = null,
        nodeColor = 0xffcc33,
        edgeColor = 0x3366ff,
        blockedColor = 0xff3344,
        occupiedColor = 0xff8800,
        reservedColor = 0x33ccff,
        selectionRadiusColor = 0xffee66,
        nodeSize = 0.12,
        height = 0.08
    } = {}) {

        super();

        this.graph = graph;
        this.connector = connector;
        this.nodeColor = nodeColor;
        this.edgeColor = edgeColor;
        this.blockedColor = blockedColor;
        this.occupiedColor = occupiedColor;
        this.reservedColor = reservedColor;
        this.selectionRadiusColor = selectionRadiusColor;
        this.nodeSize = nodeSize;
        this.height = height;

        this.name = "NavigationGraphHelper";
        this.markers = new Map();
        this.highlightedNodeId = null;
        this.interactionMarkers = new Map();
        this.highlightedInteractionPointId = null;

        this.refresh();

    }

    // -----------------------------
    // Visualization
    // -----------------------------

    refresh() {

        this.disposeChildren();
        this.markers.clear();
        this.interactionMarkers.clear();

        const nodeGeometry = new THREE.SphereGeometry(this.nodeSize, 12, 8);
        for (const node of this.graph.nodes.values()) {

            const marker = new THREE.Mesh(
                nodeGeometry,
                new THREE.MeshBasicMaterial({
                    color: this.getNodeColor(
                        node,
                        node.id === this.highlightedNodeId
                    ),
                    depthTest: false
                })
            );

            marker.name = `NavigationNode:${node.id}`;
            marker.position.copy(node.position);
            marker.position.y += this.height;
            marker.renderOrder = 1000;
            marker.userData.navigationNodeId = node.id;

            // Debug markers must not hide the Floor from the interaction raycast.
            marker.raycast = () => {};

            this.add(marker);
            this.add(this.createSelectionRadius(node));
            this.add(this.createLabel(node));
            this.markers.set(node.id, marker);

        }

        const edgePoints = {
            free: [],
            singleFile: [],
            blocked: [],
            occupied: [],
            reserved: []
        };
        const renderedConnections = new Set();

        for (const node of this.graph.nodes.values()) {

            for (const neighborId of node.connections.keys()) {

                const connectionId = [node.id, neighborId].sort().join(":");

                if (renderedConnections.has(connectionId)) continue;

                const neighbor = this.graph.requireNode(neighborId);
                const connection = node.connections.get(neighborId);
                const reverseConnection = neighbor.connections.get(node.id);

                const deltaX = neighbor.position.x - node.position.x;
                const deltaZ = neighbor.position.z - node.position.z;
                const length = Math.hypot(deltaX, deltaZ) || 1;
                const sideX = deltaZ / length;
                const sideZ = -deltaX / length;

                for (const lane of connection.lanes) {

                    const center = (connection.lanes.length - 1) / 2;
                    const offset =
                        (lane.index - center) * connection.laneWidth;
                    const start = node.position.clone();
                    const end = neighbor.position.clone();

                    start.x += sideX * offset;
                    start.z += sideZ * offset;
                    end.x += sideX * offset;
                    end.z += sideZ * offset;
                    start.y += this.height;
                    end.y += this.height;

                    const status = connection.blocked ||
                        reverseConnection?.blocked
                        ? "blocked"
                        : lane.occupants.size > 0
                            ? "occupied"
                            : lane.reservations.size > 0
                                ? "reserved"
                                : !connection.passingAllowed
                                    ? "singleFile"
                                    : "free";

                    edgePoints[status].push(start, end);

                }

                renderedConnections.add(connectionId);

            }

        }

        this.addEdges(edgePoints.free, this.edgeColor, "Free");
        this.addEdges(edgePoints.singleFile, 0x9966ff, "SingleFile");
        this.addEdges(edgePoints.blocked, this.blockedColor, "Blocked");
        this.addEdges(edgePoints.occupied, this.occupiedColor, "Occupied");
        this.addEdges(edgePoints.reserved, this.reservedColor, "Reserved");
        this.addInteractionPoints();

    }

    addInteractionPoints() {

        if (!this.connector) return;

        for (const point of this.connector.points.values()) {

            this.connector.connect(point);

            const worldPosition = point.getWorldPosition();
            const highlighted =
                point.id === this.highlightedInteractionPointId;
            const marker = new THREE.Mesh(
                new THREE.SphereGeometry(this.nodeSize * 1.4, 12, 8),
                new THREE.MeshBasicMaterial({
                    color: highlighted
                        ? 0x33ff66
                        : point.occupants.size > 0
                        ? this.occupiedColor
                        : point.reservations.size > 0
                            ? this.reservedColor
                        : point.connection
                            ? 0xff55dd
                            : 0x777777,
                    depthTest: false
                })
            );

            marker.name = `InteractionPointHelper:${point.id}`;
            marker.position.copy(worldPosition);
            marker.position.y += this.height;
            marker.renderOrder = 1002;
            marker.raycast = () => {};
            this.add(marker);
            this.add(this.createInteractionLabel(point));
            this.interactionMarkers.set(point.id, marker);

            if (!point.connection) continue;

            const accessLine = new THREE.Line(
                new THREE.BufferGeometry().setFromPoints([
                    point.connection.projectedPosition.clone().setY(
                        point.connection.projectedPosition.y + this.height
                    ),
                    worldPosition.clone().setY(worldPosition.y + this.height)
                ]),
                new THREE.LineBasicMaterial({
                    color: point.connection.automatic ? 0xff55dd : 0xffffff,
                    depthTest: false
                })
            );

            accessLine.name = `InteractionAccess:${point.id}`;
            accessLine.renderOrder = 1001;
            accessLine.raycast = () => {};
            this.add(accessLine);

        }

    }

    createInteractionLabel(point) {

        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d");
        const occupied = point.occupants.size > 0;
        const reserved = point.reservations.size > 0;

        canvas.width = 256;
        canvas.height = 64;
        context.fillStyle = "rgba(15, 20, 30, 0.8)";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = occupied
            ? "#ffb366"
            : reserved
                ? "#66ddff"
                : "#ff8bea";
        context.font = "bold 24px sans-serif";
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText(
            occupied
                ? `${point.id} [occupied]`
                : reserved
                    ? `${point.id} [reserved]`
                    : point.id,
            canvas.width / 2,
            canvas.height / 2
        );

        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;

        const label = new THREE.Sprite(
            new THREE.SpriteMaterial({
                map: texture,
                transparent: true,
                depthTest: false
            })
        );

        label.name = `InteractionLabel:${point.id}`;
        label.position.copy(point.getWorldPosition());
        label.position.y += this.height + 0.35;
        label.scale.set(2.2, 0.55, 1);
        label.renderOrder = 1003;
        label.raycast = () => {};

        return label;

    }

    addEdges(points, color, status) {

        if (points.length === 0) return;

        const edges = new THREE.LineSegments(
            new THREE.BufferGeometry().setFromPoints(points),
            new THREE.LineBasicMaterial({ color, depthTest: false })
        );

        edges.name = `NavigationEdges:${status}`;
        edges.renderOrder = 999;
        edges.raycast = () => {};

        this.add(edges);

    }

    getNodeColor(node, highlighted = false) {

        if (node.blocked) return this.blockedColor;
        if (node.occupants.size > 0 &&
            !this.graph.isNodePassable(node.id)) return this.occupiedColor;
        if (highlighted) return 0x33ff66;
        if (node.reservations.size > 0) return this.reservedColor;

        return this.nodeColor;

    }

    createSelectionRadius(node) {

        const points = [];
        const segments = 48;

        for (let index = 0; index < segments; index++) {

            const angle = (index / segments) * Math.PI * 2;

            points.push(new THREE.Vector3(
                Math.cos(angle) * this.graph.selectionRadius,
                0,
                Math.sin(angle) * this.graph.selectionRadius
            ));

        }

        const radius = new THREE.LineLoop(
            new THREE.BufferGeometry().setFromPoints(points),
            new THREE.LineBasicMaterial({
                color: this.selectionRadiusColor,
                transparent: true,
                opacity: 0.55,
                depthTest: false
            })
        );

        radius.name = `NavigationSelectionRadius:${node.id}`;
        radius.position.copy(node.position);
        radius.position.y += this.height * 0.5;
        radius.renderOrder = 998;
        radius.raycast = () => {};

        return radius;

    }

    createLabel(node) {

        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d");

        canvas.width = 256;
        canvas.height = 64;

        context.fillStyle = "rgba(15, 20, 30, 0.8)";
        context.fillRect(0, 0, canvas.width, canvas.height);
        const highlighted = node.id === this.highlightedNodeId;
        const labelColor = node.blocked
                ? "#ff6675"
                : node.occupants.size > 0
                    ? !this.graph.isNodePassable(node.id)
                        ? "#ffb366"
                        : highlighted
                        ? "#66ff8a"
                        : "#66ff8a"
                    : highlighted
                        ? "#66ff8a"
                    : node.reservations.size > 0
                        ? "#66ddff"
                        : "#ffe680";

        // Labels use the same status language as their 3D markers and the
        // InteractionPoint labels, making traffic state readable at a glance.
        context.fillStyle = labelColor;
        context.font = "bold 28px sans-serif";
        context.textAlign = "center";
        context.textBaseline = "middle";
        const status = node.blocked
            ? "blocked"
            : node.occupants.size > 0
                ? this.graph.isNodePassable(node.id)
                    ? "resting, passable"
                    : "occupied, impassable"
                : node.reservations.size > 0
                    ? "reserved"
                    : null;

        context.fillText(
            status ? `${node.id} [${status}]` : node.id,
            canvas.width / 2,
            canvas.height / 2
        );

        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;

        const label = new THREE.Sprite(
            new THREE.SpriteMaterial({
                map: texture,
                transparent: true,
                depthTest: false
            })
        );

        label.name = `NavigationLabel:${node.id}`;
        label.position.copy(node.position);
        label.position.y += this.height + 0.45;
        label.scale.set(2, 0.5, 1);
        label.renderOrder = 1001;
        label.raycast = () => {};

        return label;

    }

    highlightNode(id) {

        this.highlightedNodeId = id;
        this.highlightedInteractionPointId = null;

        for (const [nodeId, marker] of this.markers) {

            const node = this.graph.requireNode(nodeId);

            marker.material.color.set(
                this.getNodeColor(node, nodeId === id)
            );

        }

    }

    highlightInteractionPoint(id) {

        this.highlightedNodeId = null;
        this.highlightedInteractionPointId = id;
        this.refresh();

    }

    // -----------------------------
    // Lifecycle
    // -----------------------------

    disposeChildren() {

        for (const child of this.children) {

            child.geometry?.dispose();
            child.material?.map?.dispose();
            child.material?.dispose();

        }

        this.clear();

    }

    dispose() {

        this.disposeChildren();

    }

}
