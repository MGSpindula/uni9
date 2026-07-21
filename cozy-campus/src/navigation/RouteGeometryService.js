// Spatial interpretation of graph topology: lane portals, offsets, route
// waypoints and the transient curves shown by NavigationGraphHelper.
export class RouteGeometryService {

    constructor(graph) {

        this.graph = graph;
        this.activeLaneCurves = new Map();
        this.activeLaneCurveRevision = 0;

    }

    getConnectionLaneNodePosition(nodeId, fromId, toId, laneIndex) {

        const connection = this.graph.requireConnection(fromId, toId);
        const start = this.graph.requireNode(connection.fromId).position;
        const end = this.graph.requireNode(connection.toId).position;
        const deltaX = end.x - start.x;
        const deltaZ = end.z - start.z;
        const length = Math.hypot(deltaX, deltaZ) || 1;
        const sideX = deltaZ / length;
        const sideZ = -deltaX / length;
        const center = (connection.laneCount - 1) / 2;
        const offset = (laneIndex - center) * connection.laneWidth;
        const position = this.graph.requireNode(nodeId).position.clone();
        const travelStart = this.graph.requireNode(fromId).position;
        const travelEnd = this.graph.requireNode(toId).position;
        const travelDirection = travelEnd.clone().sub(travelStart);
        const travelLength = travelDirection.length();
        // Edit laneRadius on a node for all its portals, or portalOffsets on
        // one connection when only that junction arm needs manual tuning.
        const configuredRadius = connection.metadata.portalOffsets?.[nodeId] ??
            this.graph.requireNode(nodeId).metadata.laneRadius ??
            1.75;
        const nodeRadius = Math.min(configuredRadius, travelLength * 0.45);

        if (travelLength > 0) travelDirection.divideScalar(travelLength);

        position.x += sideX * offset;
        position.z += sideZ * offset;
        position.addScaledVector(
            travelDirection,
            nodeId === fromId ? nodeRadius : -nodeRadius
        );

        return position;

    }

    createWaypoints(nodeIds) {

        return this.graph.getPathNodes(nodeIds).map(node => ({
            id: node.id,
            position: node.position.clone(),
            metadata: { ...node.metadata }
        }));

    }

    getPlanarDistanceSquared(first, second) {

        const deltaX = first.x - second.x;
        const deltaZ = first.z - second.z;

        return deltaX * deltaX + deltaZ * deltaZ;

    }

    setActiveLaneCurve(agent, points) {

        this.activeLaneCurves.set(agent, points.map(point => point.clone()));
        this.activeLaneCurveRevision++;

    }

    clearActiveLaneCurve(agent) {

        if (this.activeLaneCurves.delete(agent)) {
            this.activeLaneCurveRevision++;
        }

    }

}
