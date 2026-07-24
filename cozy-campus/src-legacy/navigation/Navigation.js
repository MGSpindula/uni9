export class Navigation {

    constructor() {

        // Route owned by this agent.
        this.path = [];
        this.currentIndex = 0;
        this.waitAtEnd = false;
        this.paused = false;

        // Topological location is independent from the current route.
        this.currentNodeId = null;
        this.currentConnection = null;

        // Changes whenever the route itself is replaced. A waypoint callback
        // may install a follow-up route, such as an approach-to-interaction route.
        // Character uses this number to avoid advancing that brand-new route
        // as though it were the route that has just finished.
        this.routeRevision = 0;
        // Authorized curves can change without replacing the topological
        // route. Debug/planning previews use this cheap counter instead of
        // serializing every waypoint on every frame.
        this.geometryRevision = 0;

    }

    // -----------------------------
    // Route
    // -----------------------------

    setPath(positions, options = {}) {

        this.setWaypoints(positions.map(position => ({
            id: null,
            position
        })), options);

    }

    setWaypoints(waypoints, { waitAtEnd = false } = {}) {

        this.path = waypoints.map(waypoint => ({
            ...waypoint,
            position: waypoint.position.clone()
        }));
        this.currentIndex = 0;
        this.waitAtEnd = waitAtEnd;
        this.paused = false;
        this.routeRevision++;
        this.geometryRevision++;

    }

    clearRoute() {

        this.path = [];
        this.currentIndex = 0;
        this.waitAtEnd = false;
        this.routeRevision++;
        this.geometryRevision++;

    }

    cancel() {

        // Traversal is preserved: cancelling midway still leaves the agent on an edge.
        this.clearRoute();
        this.paused = false;

    }

    pause() {

        this.paused = true;

    }

    resume() {

        this.paused = false;

    }

    getCurrentWaypoint() {

        return this.path[this.currentIndex] ?? null;

    }

    getRouteRevision() {

        return this.routeRevision;

    }

    getGeometryRevision() {

        return this.geometryRevision;

    }

    touchGeometry() {

        this.geometryRevision++;

    }

    insertManyBeforeCurrent(waypoints) {

        this.path.splice(
            this.currentIndex,
            0,
            ...waypoints.map(waypoint => ({
                ...waypoint,
                position: waypoint.position.clone()
            }))
        );
        this.geometryRevision++;

    }

    insertManyAfterCurrent(waypoints) {

        this.path.splice(
            this.currentIndex + 1,
            0,
            ...waypoints.map(waypoint => ({
                ...waypoint,
                position: waypoint.position.clone()
            }))
        );
        this.geometryRevision++;

    }

    getNextWaypoint() {

        return this.path[this.currentIndex + 1] ?? null;

    }

    getFollowingWaypoint() {

        // Useful while the current target is an interaction portal: the
        // immediate next waypoint is the graph entry, while this one tells
        // navigation where it will continue after reaching that entry.
        return this.path[this.currentIndex + 2] ?? null;

    }

    getRemainingWaypoints() {

        return this.path.slice(this.currentIndex);

    }

    replaceRemainingWaypoints(waypoints) {

        // Used by local recovery: consumed topology stays consumed, while the
        // obsolete geometric samples ahead are replaced from the actor's real
        // position. Pause and waitAtEnd ownership remain unchanged.
        this.path = waypoints.map(waypoint => ({
            ...waypoint,
            position: waypoint.position.clone()
        }));
        this.currentIndex = 0;
        this.routeRevision++;
        this.geometryRevision++;

    }

    getUpcomingNodeIds(limit = 2) {

        const ids = [];

        for (let index = this.currentIndex; index < this.path.length; index++) {

            const id = this.path[index].id;

            if (!id || ids.at(-1) === id) continue;

            ids.push(id);
            if (ids.length >= limit) break;

        }

        return ids;

    }

    advance() {

        this.currentIndex++;

        if (this.currentIndex >= this.path.length) {

            const shouldWait = this.waitAtEnd;

            this.clearRoute();

            return {
                finished: true,
                shouldWait
            };

        }

        return {
            finished: false,
            shouldWait: false
        };

    }

    hasPath() {

        return this.getCurrentWaypoint() !== null;

    }

    isPaused() {

        return this.paused;

    }

    // -----------------------------
    // Traversal
    // -----------------------------

    setCurrentNode(id) {

        this.currentNodeId = id;
        this.currentConnection = null;

    }

    beginConnection(fromId, toId) {

        this.currentNodeId = null;
        this.currentConnection = {
            fromId,
            toId
        };

    }

    reachNode(id) {

        const completedConnection = this.currentConnection;

        this.currentNodeId = id;
        this.currentConnection = null;

        return completedConnection;

    }

    leaveConnection() {

        const connection = this.currentConnection;

        this.currentNodeId = null;
        this.currentConnection = null;

        return connection;

    }

    getTraversalState() {

        return {
            currentNodeId: this.currentNodeId,
            currentConnection: this.currentConnection
                ? { ...this.currentConnection }
                : null
        };

    }

}
