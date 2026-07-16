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

    }

    // -----------------------------
    // Route
    // -----------------------------

    setDestination(position) {

        this.setPath([position]);

    }

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

    }

    clearRoute() {

        this.path = [];
        this.currentIndex = 0;
        this.waitAtEnd = false;

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
