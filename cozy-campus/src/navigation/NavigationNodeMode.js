// Describes why an actor currently owns a graph node.
// This is navigation state, not an animation/gameplay EntityState.
export const NavigationNodeMode = Object.freeze({

    // The node is only an intermediate waypoint in an active route.
    TRANSIT: "transit",

    // The node is the actor's destination and it intends to remain there.
    DWELL: "dwell"

});
