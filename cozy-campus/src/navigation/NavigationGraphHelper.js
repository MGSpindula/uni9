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
        this.isVisible = true;
        this.activeLaneCurveRevision = -1;

        this.refresh();

    }

    // -----------------------------
    // Visibility control
    // -----------------------------

    setVisible(visible) {

        const wasVisible = this.isVisible;
        this.isVisible = visible;
        this.visible = visible;

        if (wasVisible && !visible) {

            // Transitioning to invisible: clean up everything
            this.disposeChildren();
            console.debug("[NavigationGraphHelper] Desativado - geometrias liberadas");

        } else if (!wasVisible && visible) {

            // Transitioning to visible: rebuild everything
            this.refresh();
            console.debug("[NavigationGraphHelper] Ativado - reconstruindo visualização");

        }

    }

    toggleVisible() {

        this.setVisible(!this.isVisible);

    }

    // -----------------------------
    // Visualization
    // -----------------------------

    refresh() {

        if (!this.isVisible) {
            console.debug("[NavigationGraphHelper] refresh() bloqueado - helper invisível");
            return;
        }

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
            blocked: [],
            occupied: [],
            reserved: []
        };
        const lanePortalPoints = {
            start: [],
            end: []
        };
        const lanePortalTransitions = [];
        const renderedConnections = new Set();

        for (const node of this.graph.nodes.values()) {

            for (const neighborId of node.connections.keys()) {

                const connectionId = [node.id, neighborId].sort().join(":");

                if (renderedConnections.has(connectionId)) continue;

                const neighbor = this.graph.requireNode(neighborId);
                const connection = node.connections.get(neighborId);
                const reverseConnection = neighbor.connections.get(node.id);

                // Render with the connection's canonical orientation. Using
                // node -> neighbor mirrored A/B whenever traversal happened to
                // discover the shared bidirectional resource from its other end.
                const canonicalStart = this.graph.requireNode(
                    connection.fromId
                );
                const canonicalEnd = this.graph.requireNode(
                    connection.toId
                );
                const deltaX =
                    canonicalEnd.position.x - canonicalStart.position.x;
                const deltaZ =
                    canonicalEnd.position.z - canonicalStart.position.z;
                const length = Math.hypot(deltaX, deltaZ) || 1;
                const sideX = deltaZ / length;
                const sideZ = -deltaX / length;

                for (const lane of connection.lanes) {

                    const center = (connection.lanes.length - 1) / 2;
                    const offset =
                        (lane.index - center) * connection.laneWidth;
                    const start = canonicalStart.position.clone();
                    const end = canonicalEnd.position.clone();

                    start.x += sideX * offset;
                    start.z += sideZ * offset;
                    end.x += sideX * offset;
                    end.z += sideZ * offset;
                    start.y += this.height;
                    end.y += this.height;

                    // The full lane reaches a node through these portals,
                    // rather than through its exact center. Keeping them
                    // visible makes laneRadius and the curve handoff editable.
                    const laneStart = this.graph
                        .getConnectionLaneNodePosition(
                            connection.fromId,
                            connection.fromId,
                            connection.toId,
                            lane.index
                        )
                        .add(new THREE.Vector3(0, this.height + 0.025, 0));
                    const laneEnd = this.graph
                        .getConnectionLaneNodePosition(
                            connection.toId,
                            connection.fromId,
                            connection.toId,
                            lane.index
                        )
                        .add(new THREE.Vector3(0, this.height + 0.025, 0));

                    lanePortalPoints.start.push(laneStart);
                    lanePortalPoints.end.push(laneEnd);
                    lanePortalTransitions.push(
                        start.clone().add(new THREE.Vector3(0, 0.01, 0)),
                        laneStart.clone(),
                        laneEnd.clone(),
                        end.clone().add(new THREE.Vector3(0, 0.01, 0))
                    );

                    const status = connection.blocked ||
                        reverseConnection?.blocked
                        ? "blocked"
                        : lane.occupants.size > 0
                            ? "occupied"
                            : lane.reservations.size > 0
                                ? "reserved"
                                : "free";

                    edgePoints[status].push(start, end);

                }

                renderedConnections.add(connectionId);

            }

        }

        this.addEdges(edgePoints.free, this.edgeColor, "Free");
        this.addEdges(edgePoints.blocked, this.blockedColor, "Blocked");
        this.addEdges(edgePoints.occupied, this.occupiedColor, "Occupied");
        this.addEdges(edgePoints.reserved, this.reservedColor, "Reserved");
        this.addEdges(
            lanePortalTransitions,
            0x8794aa,
            "LanePortalTransitions"
        );
        this.addLanePortalMarkers(lanePortalPoints);
        this.addActiveLaneCurves();
        this.activeLaneCurveRevision =
            this.graph.activeLaneCurveRevision ?? 0;
        this.addInteractionPoints();
        this.addGeneratedAccessAnchors();

    }

    refreshDynamic() {

        if (!this.isVisible) return;

        // Runtime traffic changes do not alter graph geometry. Update the few
        // mutable presentations in place and preserve expensive canvas labels,
        // textures, selection circles, lane portals and generated anchors.
        this.refreshTrafficEdges();
        this.refreshNodePresentation();
        this.refreshInteractionPresentation();
        this.refreshActiveLaneCurves();

    }

    refreshTrafficEdges() {

        const names = new Set([
            "NavigationEdges:Free",
            "NavigationEdges:Blocked",
            "NavigationEdges:Occupied",
            "NavigationEdges:Reserved"
        ]);

        this.removeChildren(child => names.has(child.name));

        const edgePoints = {
            free: [],
            blocked: [],
            occupied: [],
            reserved: []
        };
        const renderedConnections = new Set();

        for (const node of this.graph.nodes.values()) {

            for (const neighborId of node.connections.keys()) {

                const connectionId = [node.id, neighborId].sort().join(":");
                if (renderedConnections.has(connectionId)) continue;

                const connection = node.connections.get(neighborId);
                const startNode = this.graph.requireNode(connection.fromId);
                const endNode = this.graph.requireNode(connection.toId);
                const deltaX = endNode.position.x - startNode.position.x;
                const deltaZ = endNode.position.z - startNode.position.z;
                const length = Math.hypot(deltaX, deltaZ) || 1;
                const sideX = deltaZ / length;
                const sideZ = -deltaX / length;

                for (const lane of connection.lanes) {

                    const center = (connection.lanes.length - 1) * 0.5;
                    const offset = (lane.index - center) * connection.laneWidth;
                    const start = startNode.position.clone();
                    const end = endNode.position.clone();

                    start.x += sideX * offset;
                    start.z += sideZ * offset;
                    end.x += sideX * offset;
                    end.z += sideZ * offset;
                    start.y += this.height;
                    end.y += this.height;

                    const status = connection.blocked
                        ? "blocked"
                        : lane.occupants.size > 0
                            ? "occupied"
                            : lane.reservations.size > 0
                                ? "reserved"
                                : "free";

                    edgePoints[status].push(start, end);

                }

                renderedConnections.add(connectionId);

            }

        }

        this.addEdges(edgePoints.free, this.edgeColor, "Free");
        this.addEdges(edgePoints.blocked, this.blockedColor, "Blocked");
        this.addEdges(edgePoints.occupied, this.occupiedColor, "Occupied");
        this.addEdges(edgePoints.reserved, this.reservedColor, "Reserved");

    }

    refreshNodePresentation() {

        for (const [id, marker] of this.markers) {

            const node = this.graph.requireNode(id);
            marker.material.color.set(this.getNodeColor(
                node,
                id === this.highlightedNodeId
            ));

            const label = this.getObjectByName(`NavigationLabel:${id}`);
            const key = this.getNodePresentationKey(node);

            if (label && label.userData.presentationKey !== key) {

                this.replaceChild(label, this.createLabel(node));

            }

        }

    }

    refreshInteractionPresentation() {

        if (!this.connector) return;

        for (const [id, marker] of this.interactionMarkers) {

            const point = this.connector.points.get(id);
            if (!point) continue;

            marker.material.color.set(this.getInteractionColor(point));

            const label = this.getObjectByName(`InteractionLabel:${id}`);
            const key = this.getInteractionPresentationKey(point);

            if (label && label.userData.presentationKey !== key) {

                this.replaceChild(label, this.createInteractionLabel(point));

            }

        }

    }

    refreshActiveLaneCurves() {

        const revision = this.graph.activeLaneCurveRevision ?? 0;
        if (revision === this.activeLaneCurveRevision) return;

        this.removeChildren(child =>
            child.name.endsWith(":NavigationSpline") ||
            child.name.endsWith(":NavigationSplineDirection")
        );
        this.addActiveLaneCurves();
        this.activeLaneCurveRevision = revision;

    }

    addLanePortalMarkers({ start, end }) {

        // Green marks the canonical lane start; pink marks its end. Canonical
        // direction is connection.fromId -> connection.toId.
        this.addPortalPoints(start, 0x66ff99, "LaneStartPoints");
        this.addPortalPoints(end, 0xff6b9a, "LaneEndPoints");

    }

    addPortalPoints(points, color, name) {

        if (points.length === 0) return;

        const markers = new THREE.Points(
            new THREE.BufferGeometry().setFromPoints(points),
            new THREE.PointsMaterial({
                color,
                size: this.nodeSize * 1.35,
                sizeAttenuation: false,
                depthTest: false
            })
        );

        markers.name = name;
        markers.renderOrder = 1001;
        markers.raycast = () => {};
        this.add(markers);

    }

    addActiveLaneCurves() {

        for (const [actor, points] of this.graph.activeLaneCurves) {

            if (points.length < 2) continue;

            const curveColor = this.getActorCurveColor(actor);

            const curvePoints = points.map(point => {

                const elevated = point.clone();
                elevated.y += this.height + 0.03;
                return elevated;

            });

            // This is the actor's complete active spline, sampled densely for
            // debugging. Its color matches the actor so simultaneous routes
            // remain readable.
            const curve = new THREE.Line(
                new THREE.BufferGeometry().setFromPoints(curvePoints),
                new THREE.LineBasicMaterial({
                    color: curveColor,
                    depthTest: false
                })
            );
            curve.name = `${actor.name}:NavigationSpline`;
            curve.renderOrder = 1001;
            curve.raycast = () => {};
            this.add(curve);

            const start = curvePoints[0];
            const end = curvePoints[curvePoints.length - 1];
            const previous = curvePoints[curvePoints.length - 2] ?? start;
            const direction = end.clone().sub(previous);
            direction.y = 0;

            if (direction.lengthSq() > 0.0001) {

                const arrow = new THREE.ArrowHelper(
                    direction.normalize(),
                    end,
                    Math.min(0.45, direction.length()),
                    curveColor,
                    0.12,
                    0.08
                );
                arrow.name = `${actor.name}:NavigationSplineDirection`;
                arrow.line.raycast = () => {};
                arrow.cone.raycast = () => {};
                this.add(arrow);

            }

        }

    }

    getActorCurveColor(actor) {

        let color = null;

        actor.visual?.traverse?.(object => {

            if (color || !object.material?.color) return;
            color = object.material.color;

        });

        return color
            ? color.clone().lerp(new THREE.Color(0xffffff), 0.38).getHex()
            : 0x66ffff;

    }

    addGeneratedAccessAnchors() {

        if (!this.connector) return;

        const portalSegments = [];
        const approachSegments = [];

        for (const point of this.connector.points.values()) {

            const anchor = point.connection?.anchor;

            if (!anchor) continue;

            const centerMarker = new THREE.Mesh(
                new THREE.SphereGeometry(this.nodeSize * 0.65, 10, 6),
                new THREE.MeshBasicMaterial({
                    color: 0xffdd33,
                    depthTest: false
                })
            );

            centerMarker.name = `GeneratedAccessAnchor:${anchor.id}`;
            centerMarker.position.copy(anchor.center);
            centerMarker.position.y += this.height + 0.05;
            centerMarker.renderOrder = 1002;
            centerMarker.raycast = () => {};
            this.add(centerMarker);

            for (const [index, portal] of anchor.lanePositions.entries()) {

                const portalMarker = new THREE.Mesh(
                    new THREE.SphereGeometry(this.nodeSize * 0.45, 10, 6),
                    new THREE.MeshBasicMaterial({
                        color: 0x33ffff,
                        depthTest: false
                    })
                );

                portalMarker.name =
                    `GeneratedAccessPortal:${anchor.id}:lane-${index}`;
                portalMarker.position.copy(portal);
                portalMarker.position.y += this.height + 0.06;
                portalMarker.renderOrder = 1003;
                portalMarker.raycast = () => {};
                this.add(portalMarker);

                const center = anchor.center.clone();
                const lane = portal.clone();

                center.y += this.height + 0.04;
                lane.y += this.height + 0.04;
                portalSegments.push(center, lane);

            }

            const center = anchor.center.clone();
            const approach = point.getWorldPosition();

            center.y += this.height + 0.02;
            approach.y += this.height + 0.02;
            approachSegments.push(center, approach);

        }

        this.addEdges(portalSegments, 0x33ffff, "GeneratedAnchorPortals");
        this.addEdges(approachSegments, 0xff55dd, "GeneratedAnchorApproach");

    }

    addInteractionPoints() {

        if (!this.connector) return;

        for (const point of this.connector.points.values()) {

            // Debug refreshes happen during movement. Re-evaluate access for
            // marker colors without pretending that an actor requested it.
            this.connector.connect(point, { silent: true });

            const worldPosition = point.getWorldPosition();
            const marker = new THREE.Mesh(
                new THREE.SphereGeometry(this.nodeSize * 1.4, 12, 8),
                new THREE.MeshBasicMaterial({
                    color: this.getInteractionColor(point),
                    depthTest: false
                })
            );

            marker.name = `InteractionPointHelper:${point.id}`;
            marker.position.copy(worldPosition);
            marker.position.y += this.height;
            marker.renderOrder = 1002;
            marker.raycast = () => {};
            this.add(marker);

            // Facing is meaningful for terminal poses such as a chair seat,
            // but usually adds noise for approach/access points.
            if (point.metadata.showDirection) {

                this.addInteractionDirection(point, worldPosition);

            }

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

    addInteractionDirection(point, worldPosition) {

        // InteractionPoint rotation is local to its entity. Applying the world
        // quaternion here shows the actor's real final +Z facing, including the
        // chair/object rotation inherited by approach and seat empties.
        const direction = point.getWorldDirection();

        const arrow = new THREE.ArrowHelper(
            direction,
            worldPosition.clone().add(
                new THREE.Vector3(0, this.height + 0.08, 0)
            ),
            0.72,
            0xff8bea,
            0.2,
            0.11
        );

        arrow.name = `InteractionPointDirection:${point.id}`;
        arrow.line.raycast = () => {};
        arrow.cone.raycast = () => {};
        arrow.renderOrder = 1003;
        this.add(arrow);

    }

    createInteractionLabel(point) {

        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d");
        const occupied = point.occupants.size > 0;
        const reserved = point.reservations.size > 0;

        canvas.width = 384;
        canvas.height = 64;
        context.fillStyle = "rgba(15, 20, 30, 0.8)";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = occupied
            ? "#ffb366"
            : reserved
                ? "#66ddff"
                : "#ff8bea";
        context.font = "bold 22px sans-serif";
        context.textAlign = "center";
        context.textBaseline = "middle";
        const status = occupied
            ? " [occupied]"
            : reserved
                ? " [reserved]"
                : "";
        context.fillText(
            `${point.id}${status}`,
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
        label.scale.set(3.1, 0.55, 1);
        label.renderOrder = 1003;
        label.raycast = () => {};
        label.userData.presentationKey =
            this.getInteractionPresentationKey(point);

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
        if (node.reservations.size > 0 ||
            node.transitReservations.size > 0) {

            return this.reservedColor;

        }

        return this.nodeColor;

    }

    getInteractionColor(point) {

        if (point.id === this.highlightedInteractionPointId) return 0x33ff66;
        if (point.occupants.size > 0) return this.occupiedColor;
        if (point.reservations.size > 0) return this.reservedColor;
        return point.connection ? 0xff55dd : 0x777777;

    }

    getNodePresentationKey(node) {

        return [
            node.blocked,
            node.occupants.size,
            node.reservations.size,
            node.transitReservations.size,
            this.graph.isNodePassable(node.id),
            node.id === this.highlightedNodeId
        ].join(":");

    }

    getInteractionPresentationKey(point) {

        return [
            point.occupants.size,
            point.reservations.size,
            Boolean(point.connection),
            point.id === this.highlightedInteractionPointId
        ].join(":");

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
                    : node.reservations.size > 0 ||
                        node.transitReservations.size > 0
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
                : node.reservations.size > 0 ||
                    node.transitReservations.size > 0
                    ? node.reservations.size > 0
                        ? "reserved"
                        : "transit reserved"
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
        label.userData.presentationKey = this.getNodePresentationKey(node);

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

        this.refreshNodePresentation();

    }

    highlightInteractionPoint(id) {

        this.highlightedNodeId = null;
        this.highlightedInteractionPointId = id;
        this.refreshNodePresentation();
        this.refreshInteractionPresentation();

    }

    // -----------------------------
    // Lifecycle
    // -----------------------------

    replaceChild(current, replacement) {

        this.remove(current);
        this.disposeObject(current);
        this.add(replacement);

    }

    removeChildren(predicate) {

        for (const child of [...this.children]) {

            if (!predicate(child)) continue;

            this.remove(child);
            this.disposeObject(child);

        }

    }

    disposeObject(object) {

        object.traverse(candidate => {

            candidate.geometry?.dispose();

            const materials = Array.isArray(candidate.material)
                ? candidate.material
                : candidate.material
                    ? [candidate.material]
                    : [];

            for (const material of materials) {

                material.map?.dispose();
                material.dispose();

            }

        });

    }

    disposeChildren() {

        for (const child of this.children) this.disposeObject(child);

        this.clear();

    }

    dispose() {

        this.disposeChildren();

    }

}
