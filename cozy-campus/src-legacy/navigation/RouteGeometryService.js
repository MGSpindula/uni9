// Spatial interpretation of graph topology: lane portals, offsets, route
// waypoints and the transient curves shown by NavigationGraphHelper.
export class RouteGeometryService {

    constructor(graph) {

        this.graph = graph;
        this.activeLaneCurves = new Map();
        this.plannedLaneCurves = new Map();
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

    setPlannedLaneCurve(agent, points) {

        this.plannedLaneCurves.set(agent, points.map(point => point.clone()));
        this.activeLaneCurveRevision++;

    }

    clearPlannedLaneCurve(agent) {

        if (this.plannedLaneCurves.delete(agent)) {
            this.activeLaneCurveRevision++;
        }

    }

    getPlannedNodePath(agent, nodeId, radius = null) {

        const points = this.plannedLaneCurves.get(agent) ?? [];
        const node = this.graph.getNode(nodeId);

        if (!node || points.length < 2) return [];

        const nodeRadius = radius ?? (node.metadata.laneRadius ?? 1.75) + 0.8;
        const radiusSquared = nodeRadius * nodeRadius;
        const nearby = points.filter(point =>
            this.getPlanarDistanceSquared(point, node.position) <= radiusSquared
        );

        return nearby.length >= 2 ? nearby : [];

    }

    plannedNodePathsConflict(first, second, nodeId, clearance = 0.9) {

        const firstPath = this.getPlannedNodePath(first, nodeId);
        const secondPath = this.getPlannedNodePath(second, nodeId);

        // Missing geometry is treated conservatively. The queue remains the
        // fallback handshake until both actors have a visible plan.
        if (firstPath.length < 2 || secondPath.length < 2) return true;

        for (let firstIndex = 1; firstIndex < firstPath.length; firstIndex++) {
            for (let secondIndex = 1;
                secondIndex < secondPath.length;
                secondIndex++) {

                if (this.getPlanarSegmentDistance(
                    firstPath[firstIndex - 1],
                    firstPath[firstIndex],
                    secondPath[secondIndex - 1],
                    secondPath[secondIndex]
                ) < clearance) return true;

            }
        }

        return false;

    }

    getPlanarSegmentDistance(firstStart, firstEnd, secondStart, secondEnd) {

        if (this.planarSegmentsIntersect(
            firstStart,
            firstEnd,
            secondStart,
            secondEnd
        )) return 0;

        return Math.min(
            this.getPlanarPointSegmentDistance(firstStart, secondStart, secondEnd),
            this.getPlanarPointSegmentDistance(firstEnd, secondStart, secondEnd),
            this.getPlanarPointSegmentDistance(secondStart, firstStart, firstEnd),
            this.getPlanarPointSegmentDistance(secondEnd, firstStart, firstEnd)
        );

    }

    getPlanarPointSegmentDistance(point, start, end) {

        const axisX = end.x - start.x;
        const axisZ = end.z - start.z;
        const lengthSquared = axisX * axisX + axisZ * axisZ;
        const t = lengthSquared > 0
            ? Math.max(0, Math.min(1,
                ((point.x - start.x) * axisX +
                    (point.z - start.z) * axisZ) / lengthSquared
            ))
            : 0;
        const closestX = start.x + axisX * t;
        const closestZ = start.z + axisZ * t;

        return Math.hypot(point.x - closestX, point.z - closestZ);

    }

    planarSegmentsIntersect(firstStart, firstEnd, secondStart, secondEnd) {

        const cross = (a, b, c) =>
            (b.x - a.x) * (c.z - a.z) -
            (b.z - a.z) * (c.x - a.x);
        const firstA = cross(firstStart, firstEnd, secondStart);
        const firstB = cross(firstStart, firstEnd, secondEnd);
        const secondA = cross(secondStart, secondEnd, firstStart);
        const secondB = cross(secondStart, secondEnd, firstEnd);

        return firstA * firstB <= 0 && secondA * secondB <= 0;

    }

}
