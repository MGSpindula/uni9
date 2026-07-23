import * as THREE from "three";

// Closed loops are level-authored walks, just like Blender circulation paths.
// Do not repeat the first node at the end: CharacterNavigationSystem closes
// the final edge and rotates the list to whichever member the NPC starts at.
export const cozyCampusClosedLoops = Object.freeze([
    {
        id: "upper-promenade",
        nodeIds: Object.freeze([
            "east-exit",
            "west-1",
            "junction",
            "north-2",
            "slope-north-bottom",
            "upper-north",
            "upper-north-2",
            "upper-east",
            "slope-east-bottom"
        ])
    },
    {
        id: "west-stroll",
        nodeIds: Object.freeze([
            "west-2",
            "west-1",
            "west-3",
            "west-exit"
        ])
    },
    {
        id: "north-stroll",
        nodeIds: Object.freeze([
            "north-1",
            "junction",
            "west-1",
            "west-exit"
        ])
    }
]);

// Navigation authored for this level. Future environments can provide another
// module with the same configure(graph) contract without changing Scene.
// graph.addNode("junction", position, {
//     laneRadius: 2.2
// });
export function configureCozyCampusNavigation(graph) {

    const nodes = [
        ["spawn", new THREE.Vector3(0, 0, -8)],
        ["north-1", new THREE.Vector3(-5, 0, -5), {laneRadius: 2}],
        ["junction", new THREE.Vector3(0, 0, 0), {laneRadius: 2}],
        ["west-exit", new THREE.Vector3(-6, 0, 8), {laneRadius: 2.5}],
        ["west-1", new THREE.Vector3(3, 0, 7), {laneRadius: 2}],
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
    connect("spawn", "slope-north-bottom");
    connect("spawn", "junction");
    connect("north-1", "junction");
    connect("north-1", "west-exit");
    connect("north-1", "west-3");
    connect("slope-north-bottom", "junction", {laneCapacity: 1});
    connect("west-1", "west-exit");
    connect("west-1", "west-3");
    connect("west-1", "east-exit");
    connect("junction", "west-1");
    connect("west-3", "west-exit");
    connect("junction", "west-exit");

    // Manual lane portal offsets. Uncomment and tune these when one specific
    // endpoint needs more room for a smooth curve. The key is the node at
    // that end of the connection; values are world units from its center.
    //
    // connect("junction", "west-1", {
    //     metadata: {
    //         portalOffsets: {
    //             junction: 2.2,
    //             "west-1": 1.4
    //         }
    //     }
    // });
    //
    // Runtime/debug alternative:
    // graph.setConnectionPortalOffset("junction", "west-1", "junction", 2.2);

    // Height prototype. Traversal metadata will later select slope/stairs
    // animation clips without changing the route or Locomotion contracts.
    connect("slope-north-bottom", "junction", {
        metadata: { traversal: "flat", laneCapacity: 1 }
    });
    connect("slope-north-bottom", "upper-north", {
        metadata: { traversal: "slope" }
    });
    connect("upper-north", "upper-north-2", {
        metadata: { traversal: "flat", laneCapacity: 1 }
    });
    connect("upper-north-2", "upper-east", {
        metadata: { traversal: "flat" }
    });
    connect("upper-east", "slope-east-bottom", {
        metadata: { traversal: "slope", laneCapacity: 1 }
    });
    connect("slope-east-bottom", "east-exit", {
        metadata: { traversal: "flat" }
    });

    // Level-authored hard block used by the current prototype.
    graph.setConnectionBlocked("spawn", "junction", true);

    // graph.setNodeBlocked("west-1", true);

}
