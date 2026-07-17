import * as THREE from "three";

// Navigation authored for this level. Future environments can provide another
// module with the same configure(graph) contract without changing Scene.
export function configureCozyCampusNavigation(graph) {

    const nodes = [
        ["spawn", new THREE.Vector3(0, 0, -8)],
        ["north-1", new THREE.Vector3(-5, 0, -5)],
        ["north-2", new THREE.Vector3(2, 0, -3)],
        ["junction", new THREE.Vector3(0, 0, 0)],
        ["west-exit", new THREE.Vector3(-7, 0, 6)],
        ["west-1", new THREE.Vector3(3, 0, 7)],
        ["west-2", new THREE.Vector3(-3, 0, 8.5)],
        ["west-3", new THREE.Vector3(-8.5, 0, 1)],
        ["east-exit", new THREE.Vector3(7.3, 0, 7)],
        // Transition nodes belong exactly at the center of each physical edge.
        // Do not stretch a slope connection across an adjacent flat gap:
        // Grounding would correctly keep the actor on the flat surface while
        // Navigation incorrectly asks it to gain height there.
        ["slope-north-bottom", new THREE.Vector3(3, 0, -3)],
        ["upper-north", new THREE.Vector3(6, 2, -3)],
        ["upper-north-2", new THREE.Vector3(7.2, 2, -3)],
        ["upper-east", new THREE.Vector3(7.2, 2, 1.8)],
        ["slope-east-bottom", new THREE.Vector3(7.2, 0, 5)]
    ];

    for (const [id, position, metadata = {}] of nodes) {

        graph.addNode(id, position, metadata);

    }

    const connect = (fromId, toId, options = {}) =>
        graph.connect(fromId, toId, options);

    connect("spawn", "north-1");
    connect("spawn", "north-2");
    connect("spawn", "junction");
    connect("north-1", "junction");
    connect("north-1", "west-exit");
    connect("north-1", "west-3");
    connect("north-2", "junction");
    connect("junction", "west-1");
    connect("west-1", "west-exit");
    connect("west-1", "west-2");
    connect("west-1", "west-3");
    connect("west-1", "east-exit");
    connect("west-2", "west-exit");
    connect("west-3", "west-exit");
    connect("junction", "west-exit");

    // Height prototype. Traversal metadata will later select slope/stairs
    // animation clips without changing the route or Locomotion contracts.
    connect("north-2", "slope-north-bottom", {
        metadata: { traversal: "flat" }
    });
    connect("slope-north-bottom", "upper-north", {
        metadata: { traversal: "slope" }
    });
    connect("upper-north", "upper-north-2", {
        metadata: { traversal: "flat" }
    });
    connect("upper-north-2", "upper-east", {
        metadata: { traversal: "flat" }
    });
    connect("upper-east", "slope-east-bottom", {
        metadata: { traversal: "slope" }
    });
    connect("slope-east-bottom", "east-exit", {
        metadata: { traversal: "flat" }
    });

    // Level-authored hard block used by the current prototype.
    graph.setConnectionBlocked("spawn", "junction", true);

}

export function configureCozyCampusDwellSpots(registry, graph) {

    // Author these as Blender empties later. Position is world-space and the
    // empty's Y rotation becomes rotationY. Nodes without spots intentionally
    // exercise the nearest-free-spot fallback.
    const add = (id, nodeId, offset, options = {}) => {

        const position = graph.requireNode(nodeId).position.clone().add(offset);

        registry.add(id, nodeId, { position, ...options });

    };

    add("dwell:junction:stand-01", "junction",
    new THREE.Vector3(1.6, 0, 1), { 
        rotationY: Math.PI * 0.3, 
        pose: "stand" });
    add("dwell:junction:lean-01", "junction",
        new THREE.Vector3(-1.5, 0, 0), {
        rotationY: Math.PI * 1.45,
        pose: "lean",
        metadata: { support: "wall" }
    });
    add("dwell:west-1:stand-01", "west-1",
        new THREE.Vector3(1.2, 0, 1.3), {
        rotationY: Math.PI * 0.2,
        pose: "stand"
    });
    add("dwell:east-exit:stand-01", "east-exit",
        new THREE.Vector3(1, 0, 0));
    add("dwell:spawn:stand-01", "spawn",
        new THREE.Vector3(1.2, 0, -1.1), {
        rotationY: Math.PI * 3 / 4,
        pose: "stand"
    });
    add("dwell:upper-north-2:stand-01", "upper-north-2",
        new THREE.Vector3(0.8, 0, -0.7), {
        rotationY: Math.PI * 3 / 4,
        pose: "stand"
    });

}