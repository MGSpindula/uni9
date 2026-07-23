import assert from "node:assert/strict";
import { test } from "node:test";
import * as THREE from "three";
import * as CANNON from "cannon-es";

import { Character } from "../../src/characters/Character";
import { EntityState } from "../../src/core/EntityState";
import { InteractionPoint } from "../../src/navigation/InteractionPoint";
import { NavigationConnector } from "../../src/navigation/NavigationConnector";
import { NavigationGraph } from "../../src/navigation/NavigationGraph";
import { CharacterNavigationSystem } from "../../src/navigation/CharacterNavigationSystem";
import { WaitReason } from "../../src/navigation/WaitReason";
import { UseAvailableInteractionBehavior } from "../../src/characters/behaviors/UseAvailableInteractionBehavior";
import { GameLoop } from "../../src/game/GameLoop";
import { NavigationAgent } from "../../src/navigation/NavigationAgent";
import { NavigationPhase } from "../../src/navigation/NavigationPhase";
import { RouteSegmentType } from "../../src/navigation/RouteSegment";
import { NavigationGraphHelper } from "../../src/navigation/NavigationGraphHelper";
import { NavigationTrafficState } from "../../src/navigation/NavigationTrafficState";
import { Pathfinder } from "../../src/navigation/Pathfinder";
import { InteractionSelectionStrategy } from "../../src/characters/behaviors/InteractionSelectionStrategy";
import { ShortTermBehaviorMemory } from "../../src/characters/behaviors/ShortTermBehaviorMemory";
import { SpatialHash } from "../../src/navigation/SpatialHash.js";
import { NPCController } from "../../src/characters/NPCController";
import { Game } from "../../src/Game";

const STEP = 1 / 30;

function createGraph({ nodes, connections }) {

    const graph = new NavigationGraph({ selectionRadius: 2 });

    for (const [id, x, z, metadata = {}] of nodes) {

        graph.addNode(id, new THREE.Vector3(x, 0, z), metadata);

    }

    for (const [fromId, toId, options = {}] of connections) {

        graph.connect(fromId, toId, options);

    }

    return graph;

}

function createLineGraph() {

    return createGraph({
        nodes: [
            ["a", 0, 0],
            ["b", 4, 0],
            ["c", 8, 0]
        ],
        connections: [
            ["a", "b"],
            ["b", "c"]
        ]
    });

}

function createRingGraph(nodeCount = 16, radius = 12) {

    const nodes = [];
    const connections = [];

    for (let index = 0; index < nodeCount; index++) {

        const angle = index / nodeCount * Math.PI * 2;
        nodes.push([
            `ring-${index}`,
            Math.cos(angle) * radius,
            Math.sin(angle) * radius
        ]);
        connections.push([
            `ring-${index}`,
            `ring-${(index + 1) % nodeCount}`
        ]);

    }

    return createGraph({ nodes, connections });

}

function createHarness(graph = createLineGraph()) {

    const connector = new NavigationConnector(graph);
    const system = new CharacterNavigationSystem({
        graph,
        connector,
        helper: null
    });
    const actors = [];

    const addActor = (name, spawnId, {
        intentPolicy = "persistent",
        priority = 0
    } = {}) => {

        const actor = new Character(name);

        actor.navigationIntentPolicy = intentPolicy;
        actor.navigationPriority = priority;
        system.registerActor(actor, { spawnId });
        actors.push(actor);
        return actor;

    };

    const update = (frames = 1, delta = STEP) => {

        for (let frame = 0; frame < frames; frame++) {

            system.update(delta);
            assertNavigationInvariants({ graph, connector, system });

        }

    };

    const dispose = () => {

        for (const actor of [...actors]) {

            system.unregisterActor(actor);

        }

        system.dispose();

    };

    return {
        graph,
        connector,
        system,
        actors,
        addActor,
        update,
        dispose
    };

}

test("topology and pathfinding work without actors or traffic state", () => {

    const graph = createLineGraph();
    const pathfinder = new Pathfinder(graph);
    const path = pathfinder.findShortestPath("a", "c");

    assert.deepEqual(path.nodeIds, ["a", "b", "c"]);
    assert.equal(path.cost, 8);
    assert.equal("occupants" in graph.requireNode("a"), false);
    assert.equal("reservations" in graph.requireConnection("a", "b"), false);

});

test("spatial hash returns nearby actors across cell boundaries", () => {

    const nearLeft = { position: new THREE.Vector3(-0.1, 0, 0) };
    const nearRight = { position: new THREE.Vector3(0.1, 0, 0) };
    const far = { position: new THREE.Vector3(8, 0, 8) };
    const hash = new SpatialHash(1.8);

    hash.rebuild([nearLeft, nearRight, far], actor => actor.position);

    const neighbors = hash.queryRadius(
        new THREE.Vector3(0, 0, 0),
        1.8
    );

    assert.equal(neighbors.includes(nearLeft), true);
    assert.equal(neighbors.includes(nearRight), true);
    assert.equal(neighbors.includes(far), false);

});

test("offscreen NPCs keep choosing activities on a reduced cadence", () => {

    let choices = 0;
    const npc = {
        name: "Background NPC",
        isState: () => false
    };
    const controller = new NPCController({
        npc,
        navigationSystem: {
            getOccupiedInteractionPoint: () => null
        },
        interactionBehavior: {
            update() { },
            tryStart() {
                choices++;
                return true;
            }
        },
        closedLoopChance: 0
    });

    controller.update(1, { visible: false, distance: 30 });
    assert.equal(choices, 0);

    controller.update(1, { visible: false, distance: 30 });
    assert.equal(choices, 1);

});

test("offscreen NPCs leave completed interactions", () => {

    const point = { id: "background:interaction" };
    let excludedPoint = null;
    const npc = {
        name: "Interacting NPC",
        isState: () => false
    };
    const controller = new NPCController({
        npc,
        navigationSystem: {
            getOccupiedInteractionPoint: () => point
        },
        interactionBehavior: {
            update() { },
            tryStart(actor, options) {
                excludedPoint = options.excludePoint;
                return true;
            }
        },
        closedLoopChance: 0
    });

    controller.update(5.1, { visible: false, distance: 30 });

    assert.equal(excludedPoint, point);

});

test("NPC leaves its current interaction when no replacement activity is available", () => {

    const point = { id: "occupied:interaction" };
    let leaveRequests = 0;
    const npc = {
        name: "Independent NPC",
        isState: () => false
    };
    const controller = new NPCController({
        npc,
        navigationSystem: {
            getOccupiedInteractionPoint: () => point,
            leaveInteraction(actor) {
                assert.equal(actor, npc);
                leaveRequests++;
                return true;
            }
        },
        interactionBehavior: {
            update() { },
            tryStart() { return false; }
        },
        closedLoopChance: 0
    });

    controller.update(5.1, { visible: true, distance: 4 });

    assert.equal(leaveRequests, 1);
    assert.equal(controller.state, "leaving interaction");

});

test("continuous rendering follows each entity visual activity contract", () => {

    const active = { isActive: () => true, requiresContinuousRender: () => true };
    const still = { isActive: () => true, requiresContinuousRender: () => false };
    const inactive = { isActive: () => false, requiresContinuousRender: () => true };
    const probe = { world: { entities: [still, inactive, active] } };

    assert.equal(Game.prototype.hasContinuousVisualActivity.call(probe), true);
    probe.world.entities = [still, inactive];
    assert.equal(Game.prototype.hasContinuousVisualActivity.call(probe), false);

});

test("NPC interaction scoring prefers route cost and low congestion", () => {

    const actor = { name: "Planner NPC" };
    const createCandidate = (id, pathCost, congestion) => ({
        target: {},
        point: { id: `point:${id}` },
        definition: {
            id,
            repetitionKey: id,
            getUtility: () => 0
        },
        navigation: { reachable: true, pathCost, congestion }
    });
    const geometricallyNearButCostly = createCandidate("near", 12, 1);
    const fartherButClear = createCandidate("clear", 5, 0);
    const memory = new ShortTermBehaviorMemory();
    const strategy = new InteractionSelectionStrategy();
    const ranked = strategy.rank({
        actor,
        candidates: [geometricallyNearButCostly, fartherButClear],
        memory,
        evaluate: candidate => candidate.navigation
    });

    assert.equal(ranked[0].definition.id, "clear");

});

test("short-term behavior memory enforces cooldown and activity variety", () => {

    const actor = { name: "Memory NPC" };
    const repeated = {
        target: {},
        point: { id: "chair:01" },
        definition: {
            id: "sit:01",
            repetitionKey: "sit",
            getUtility: () => 0
        }
    };
    const alternative = {
        target: {},
        point: { id: "window:01" },
        definition: {
            id: "observe:01",
            repetitionKey: "observe",
            getUtility: () => 0
        }
    };
    const memory = new ShortTermBehaviorMemory();
    const strategy = new InteractionSelectionStrategy();

    memory.remember(repeated, 8);

    const ranked = strategy.rank({
        actor,
        candidates: [repeated, alternative],
        memory,
        evaluate: () => ({
            reachable: true,
            pathCost: 4,
            congestion: 0
        })
    });

    assert.deepEqual(
        ranked.map(candidate => candidate.definition.id),
        ["observe:01"]
    );

    memory.update(9);
    assert.equal(memory.isCoolingDown(repeated), false);
    assert.ok(memory.getRepetitionPenalty(repeated) > 0);

});

test("GameLoop executes character frame phases in authoritative order", () => {

    const calls = [];
    const character = {
        isActive: () => true,
        authorizeMovementTraffic: () => calls.push("traffic authorization"),
        prepareMovement: () => calls.push("movement intent"),
        evaluateMovementGuard: () => calls.push("collision brake"),
        updateMovement: () => calls.push("locomotion"),
        updateGrounding: () => calls.push("grounding"),
        updateAnimation: () => calls.push("animation")
    };
    const worldEntity = {
        isActive: () => true,
        update: () => calls.push("world entity")
    };
    const navigation = {
        updatePlanning: () => calls.push("planning"),
        updateTraffic: () => calls.push("traffic update"),
        prepareCollisionFrame: () => { },
        resolveCharacterOverlaps: () => { },
        resolveResidualCharacterOverlaps: () =>
            calls.push("collision projection"),
        solvePhysics: () => calls.push("physics")
    };
    const game = {
        services: {
            selection: { update: () => calls.push("input") },
            characterNavigation: navigation
        },
        renderPipeline: {
            controls: { update: () => calls.push("camera input") },
            camera: null
        },
        world: {
            entities: [worldEntity, character],
            characters: [character],
            controllers: [{ update: () => calls.push("npc decision") }]
        },
        hasContinuousVisualActivity: () => false,
        requestRender() { }
    };

    new GameLoop(game).update(STEP);

    assert.deepEqual(calls, [
        "input",
        "camera input",
        "world entity",
        "npc decision",
        "planning",
        "traffic update",
        "traffic authorization",
        "movement intent",
        "collision brake",
        "locomotion",
        "collision projection",
        "physics",
        "grounding",
        "animation"
    ]);

});

test("CollisionFailsafe brake cannot alter route or move the actor", () => {

    const actor = new Character("Braked");
    const target = new THREE.Vector3(2, 0, 0);

    actor.navigation.setCurrentNode("origin");
    actor.followWaypoints([{ id: null, position: target }]);
    actor.setMovementGuard(() => false);
    const revision = actor.navigation.getRouteRevision();

    assert.equal(actor.authorizeMovementTraffic(), true);
    assert.equal(actor.prepareMovement(), true);
    assert.equal(actor.evaluateMovementGuard(STEP), false);
    actor.updateMovement(STEP);

    assert.equal(actor.object3D.position.lengthSq(), 0);
    assert.equal(actor.navigation.getRouteRevision(), revision);
    assert.equal(actor.navigation.getCurrentWaypoint().position.equals(target), true);

});

test("collision solver backsteps on its own spline without pushing blocker", () => {

    const harness = createHarness();
    const blocker = harness.addActor("Blocker", "a");
    const yielding = harness.addActor("Yielding", "b");
    const curve = new THREE.LineCurve3(
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(2, 0, 0)
    );

    blocker.object3D.position.set(1.2, 0, 0);
    yielding.object3D.position.set(0.5, 0, 0);
    yielding.locomotion.activeCurve = curve;
    yielding.locomotion.curveDistance = 0.5;
    const originalProgress = yielding.locomotion.curveDistance;
    const blockerPosition = blocker.object3D.position.clone();
    harness.system.prepareCollisionFrame([blocker, yielding]);

    harness.system.resolveCharacterOverlaps(
        [blocker, yielding],
        STEP
    );

    assert.equal(blocker.object3D.position.equals(blockerPosition), true);
    assert.ok(yielding.object3D.position.x < 0.5);
    assert.ok(Math.abs(yielding.object3D.position.z) < 0.0001);
    assert.ok(yielding.locomotion.curveDistance < originalProgress);
    assert.equal(
        yielding.locomotion.getMotionState().retreating,
        true
    );
    harness.dispose();

});

test("node traffic state has no obsolete resting ownership", () => {

    const state = new NavigationTrafficState(createLineGraph());
    const node = state.getNodeState("b");

    assert.equal(Object.hasOwn(node, "restingAgents"), false);

});

test("authorized compatible crossings are not rejected by node capacity", () => {

    const graph = createGraph({
        nodes: [["junction", 0, 0, { capacity: 1 }]],
        connections: []
    });
    const state = new NavigationTrafficState(graph);
    const first = new Character("First crossing");
    const second = new Character("Second crossing");

    assert.equal(
        state.occupyNode("junction", first, { crossing: true }),
        true
    );
    assert.equal(state.canCrossNode("junction", second, () => true), true);
    assert.equal(
        state.occupyNode("junction", second, { crossing: true }),
        true
    );
    assert.equal(state.getNodeState("junction").occupants.size, 2);

});

test("collision negotiation elects one stable winner instead of reciprocal waiting", () => {

    const harness = createHarness();
    const first = harness.addActor("First", "a");
    const second = harness.addActor("Second", "b");
    const firstTarget = new THREE.Vector3(2, 0, 0);
    const secondTarget = new THREE.Vector3(-2, 0, 0);

    // Keep bodies outside physical contact: right-of-way authorizes one actor
    // while the encounter is still predictive.
    first.object3D.position.set(-0.55, 0, 0);
    second.object3D.position.set(0.55, 0, 0);
    harness.system.prepareCollisionFrame([first, second]);

    const firstMayMove = harness.system.collisionFailsafe.canMove(
        first,
        firstTarget
    );
    const secondMayMove = harness.system.collisionFailsafe.canMove(
        second,
        secondTarget
    );

    assert.equal(Number(firstMayMove) + Number(secondMayMove), 1);
    const encounter = harness.system.collisionFailsafe.encounters[0];
    const winner = encounter.winner;

    // The next frame may temporarily brake the winner while the yielder opens
    // physical clearance, but query order must never reverse their roles.
    harness.system.prepareCollisionFrame([first, second]);
    harness.system.collisionFailsafe.canMove(second, secondTarget);
    harness.system.collisionFailsafe.canMove(first, firstTarget);
    assert.equal(harness.system.collisionFailsafe.encounters[0], encounter);
    assert.equal(encounter.winner, winner);
    harness.dispose();

});

test("right-of-way never permits an actor to walk through physical contact", () => {

    const harness = createHarness();
    const winner = harness.addActor("Contact winner", "a");
    const yielding = harness.addActor("Contact yielder", "b");

    winner.object3D.position.set(-0.3, 0, 0);
    yielding.object3D.position.set(0.3, 0, 0);
    harness.system.prepareCollisionFrame([winner, yielding]);

    assert.equal(
        harness.system.collisionFailsafe.canMove(
            winner,
            new THREE.Vector3(2, 0, 0)
        ),
        false
    );
    assert.equal(
        harness.system.collisionFailsafe.canMove(
            yielding,
            new THREE.Vector3(-2, 0, 0)
        ),
        false
    );

    // The winner may leave contact in the opposite direction; the failsafe
    // blocks penetration, not escape.
    assert.equal(
        harness.system.collisionFailsafe.canMove(
            winner,
            new THREE.Vector3(-2, 0, 0)
        ),
        true
    );
    harness.dispose();

});

test("perpendicular lane conflict cannot push either actor sideways", () => {

    const harness = createHarness();
    const winner = harness.addActor("Crossing winner", "a");
    const yielding = harness.addActor("Crossing yielder", "b");
    const curve = new THREE.LineCurve3(
        new THREE.Vector3(0, 0, -2),
        new THREE.Vector3(0, 0, 2)
    );

    winner.object3D.position.set(0.3, 0, 0);
    yielding.object3D.position.set(0, 0, 0.3);
    yielding.locomotion.activeCurve = curve;
    yielding.locomotion.curveDistance = 2.3;
    const winnerPosition = winner.object3D.position.clone();

    for (let frame = 0; frame < 60; frame++) {
        yielding.locomotion.beginFrame();
        harness.system.prepareCollisionFrame([winner, yielding]);
        harness.system.resolveCharacterOverlaps(
            [winner, yielding],
            STEP
        );
    }

    assert.equal(winner.object3D.position.equals(winnerPosition), true);
    assert.ok(Math.abs(yielding.object3D.position.x) < 0.0001);
    assert.ok(yielding.object3D.position.z >= -0.6001);
    assert.ok(yielding.locomotion.curveDistance >= 1.3999);
    harness.dispose();

});

test("parallel lane conflict steps outward and preserves route progress", () => {

    const harness = createHarness();
    const winner = harness.addActor("Parallel winner", "a");
    const yielding = harness.addActor("Parallel yielder", "b");
    const curve = new THREE.LineCurve3(
        new THREE.Vector3(0, 0, 0.5),
        new THREE.Vector3(4, 0, 0.5)
    );

    winner.object3D.position.set(1.1, 0, 0.5);
    yielding.object3D.position.set(0.5, 0, 0.5);
    winner.locomotion.activeCurve = curve;
    winner.locomotion.curveDistance = 1.1;
    yielding.locomotion.activeCurve = curve;
    yielding.locomotion.curveDistance = 0.5;
    winner.navigation.beginConnection("a", "b");
    yielding.navigation.beginConnection("a", "b");
    harness.system.trafficState.occupyConnectionLane(
        "a", "b", yielding, 0
    );
    const progress = yielding.locomotion.curveDistance;

    harness.system.prepareCollisionFrame([winner, yielding]);
    harness.system.resolveCharacterOverlaps([winner, yielding], STEP);

    const maneuver = harness.system.collisionSolver.getManeuver(yielding);
    assert.equal(maneuver.strategy, "lane-side-step");
    assert.ok(yielding.object3D.position.z > 0.5);
    assert.equal(yielding.locomotion.curveDistance, progress);
    assert.equal(yielding.locomotion.motion.avoiding, true);
    harness.dispose();

});

test("collision near a node marks it unavailable to external routes", () => {

    const harness = createHarness();
    const first = harness.addActor("Node collision A", "a");
    const second = harness.addActor("Node collision B", "b");
    const outsider = harness.addActor("External route", "c");

    first.object3D.position.set(0, 0, 0);
    second.object3D.position.set(0.3, 0, 0);
    harness.system.prepareCollisionFrame([first, second, outsider]);
    const encounter = harness.system.collisionFailsafe
        .getOrCreateEncounter(first, second);
    harness.system.collisionFailsafe.markEncounterCollision(
        encounter,
        first,
        second
    );

    const state = harness.system.trafficState.getNodeState("a");
    assert.equal(state.collisionBlocks.size, 1);
    assert.equal(
        harness.system.trafficState.isNodeAvailable("a", outsider),
        false
    );
    assert.equal(harness.system.trafficState.isNodePassable("a"), false);

    harness.system.collisionFailsafe.cancel(second);
    assert.equal(state.collisionBlocks.size, 0);
    harness.dispose();

});

test("stale node abandons competing routes and distributes local exits", () => {

    const harness = createHarness();
    const first = harness.addActor("Stale first", "a");
    const second = harness.addActor("Stale second", "c");
    const node = harness.graph.requireNode("b");

    for (const actor of [first, second]) {
        harness.system.trafficState.releaseAgent(actor);
        actor.navigation.cancel();
        actor.navigation.setCurrentNode("b");
        actor.object3D.position.copy(node.position);
        harness.system.trafficState.occupyNode(
            "b",
            actor,
            { crossing: true }
        );
    }

    assert.equal(harness.system.evacuateStaleNode("b"), true);
    const destinations = new Set([
        first.navigation.getCurrentWaypoint()?.id,
        second.navigation.getCurrentWaypoint()?.id
    ]);

    assert.deepEqual(destinations, new Set(["a", "c"]));
    harness.dispose();

});

test("different reserved lanes do not suppress a real body overlap", () => {

    const harness = createHarness();
    const first = harness.addActor("Lane A", "a");
    const second = harness.addActor("Lane B", "b");

    harness.system.trafficState.reserveSpecificConnectionLane(
        "a",
        "b",
        0,
        first
    );
    harness.system.trafficState.reserveSpecificConnectionLane(
        "a",
        "b",
        1,
        second
    );
    first.navigation.beginConnection("a", "b");
    second.navigation.beginConnection("b", "a");
    first.object3D.position.set(-0.3, 0, 0);
    second.object3D.position.set(0.3, 0, 0);
    harness.system.prepareCollisionFrame([first, second]);

    const decisions = [
        harness.system.collisionFailsafe.canMove(
            first,
            new THREE.Vector3(2, 0, 0)
        ),
        harness.system.collisionFailsafe.canMove(
            second,
            new THREE.Vector3(-2, 0, 0)
        )
    ];

    // Separate lane reservations never suppress body collision. Once actors
    // are already touching, neither may advance through the other.
    assert.equal(decisions.filter(Boolean).length, 0);
    harness.dispose();

});

test("residual collision registers negotiation without moving either actor", () => {

    const harness = createHarness();
    const first = harness.addActor("Residual first", "a");
    const second = harness.addActor("Residual second", "b");
    first.object3D.position.set(0, 0, 0);
    second.object3D.position.set(0.25, 0, 0);
    second.locomotion.activeCurve = new THREE.LineCurve3(
        new THREE.Vector3(-2, 0, 0),
        new THREE.Vector3(2, 0, 0)
    );
    second.locomotion.curveDistance = 2.25;
    const firstPosition = first.object3D.position.clone();
    const secondPosition = second.object3D.position.clone();
    harness.system.prepareCollisionFrame([first, second]);
    harness.system.resolveResidualCharacterOverlaps(
        [first, second],
        STEP
    );

    assert.equal(first.object3D.position.equals(firstPosition), true);
    assert.equal(second.object3D.position.equals(secondPosition), true);
    assert.ok(harness.system.collisionSolver.getManeuver(second));
    harness.dispose();

});

test("residual contact never projects actors out of a crowded cluster", () => {

    const harness = createHarness();
    const actors = [
        harness.addActor("Cluster A", "a"),
        harness.addActor("Cluster B", "b"),
        harness.addActor("Cluster C", "c")
    ];

    actors[0].object3D.position.set(0, 0, 0);
    actors[1].object3D.position.set(0.15, 0, 0);
    actors[2].object3D.position.set(0.3, 0, 0);
    const positions = actors.map(actor => actor.object3D.position.clone());
    harness.system.prepareCollisionFrame(actors);
    harness.system.resolveResidualCharacterOverlaps(actors, STEP);

    for (let index = 0; index < actors.length; index++) {
        assert.equal(
            actors[index].object3D.position.equals(positions[index]),
            true
        );
    }
    harness.dispose();

});

test("collision waiting preserves the route before its stale timeout", () => {

    const harness = createHarness();
    const winner = harness.addActor("Winner", "a");
    const yielder = harness.addActor("Yielder", "b", {
        intentPolicy: "replaceable"
    });
    const target = new THREE.Vector3(-2, 0, 0);
    const agent = harness.system.requireContext(yielder);

    winner.object3D.position.set(-0.35, 0, 0);
    yielder.object3D.position.set(0.35, 0, 0);
    agent.intent.position = target;
    yielder.followWaypoints([{ id: "a", position: target }]);
    const revision = yielder.navigation.getRouteRevision();

    harness.system.prepareCollisionFrame([winner, yielder]);
    assert.equal(
        harness.system.collisionFailsafe.canMove(yielder, target),
        false
    );

    harness.system.monitorNavigationProgress(agent, 2);

    assert.equal(yielder.navigation.getRouteRevision(), revision);
    assert.equal(
        yielder.navigation.getCurrentWaypoint().position.equals(target),
        true
    );
    assert.equal(agent.intent.position.equals(target), true);
    harness.dispose();

});

test("persistent collision intent is not discarded by the NPC timeout", () => {

    const harness = createHarness();
    const winner = harness.addActor("Winner", "a");
    const player = harness.addActor("Player", "b", {
        intentPolicy: "persistent"
    });
    const target = new THREE.Vector3(-2, 0, 0);
    const agent = harness.system.requireContext(player);

    // This contact is deliberately off-node. Node collisions now use group
    // evacuation; an isolated off-graph Player collision still preserves the
    // original command.
    harness.system.trafficState.releaseAgent(winner);
    harness.system.trafficState.releaseAgent(player);
    winner.navigation.setCurrentNode(null);
    player.navigation.setCurrentNode(null);
    winner.object3D.position.set(20, 0, 0);
    player.object3D.position.set(20.7, 0, 0);
    agent.intent.position = target;
    player.followWaypoints([{ id: "a", position: target }]);
    const revision = player.navigation.getRouteRevision();
    harness.system.prepareCollisionFrame([winner, player]);
    assert.equal(
        harness.system.collisionFailsafe.canMove(player, target),
        false
    );

    assert.equal(harness.system.monitorNavigationProgress(agent, 10), false);
    assert.equal(player.navigation.getRouteRevision(), revision);
    assert.equal(agent.intent.position.equals(target), true);
    harness.dispose();

});

test("collision backstep is not traffic route progress", () => {

    const harness = createHarness();
    const blocker = harness.addActor("Blocker", "a");

    blocker.locomotion.motion.moving = true;
    blocker.locomotion.motion.retreating = true;
    assert.equal(harness.system.traffic.isBlockerProgressing(blocker), false);

    blocker.locomotion.motion.retreating = false;
    assert.equal(harness.system.traffic.isBlockerProgressing(blocker), true);
    harness.dispose();

});

test("stale NPC collision wait releases its route and reservations", () => {

    const harness = createHarness();
    const winner = harness.addActor("Winner", "a");
    const yielder = harness.addActor("Yielder", "b", {
        intentPolicy: "replaceable"
    });
    const target = new THREE.Vector3(-2, 0, 0);
    const agent = harness.system.requireContext(yielder);

    // Off-node collision keeps the individual recovery fallback. Physical
    // collisions near nodes are covered by collective stale evacuation.
    harness.system.trafficState.releaseAgent(winner);
    harness.system.trafficState.releaseAgent(yielder);
    winner.navigation.setCurrentNode(null);
    yielder.navigation.setCurrentNode(null);
    winner.object3D.position.set(20, 0, 0);
    yielder.object3D.position.set(20.7, 0, 0);
    agent.intent.position = target;
    yielder.followWaypoints([{ id: "a", position: target }]);
    harness.system.traffic.arrivals.enqueue("a", yielder, {
        rank: 2,
        kind: "arrival"
    });
    harness.system.prepareCollisionFrame([winner, yielder]);
    assert.equal(
        harness.system.collisionFailsafe.canMove(yielder, target),
        false
    );

    assert.equal(harness.system.monitorNavigationProgress(agent, 5), true);
    assert.equal(yielder.navigation.hasPath(), false);
    assert.equal(agent.intent.position, null);
    assert.equal(harness.system.traffic.isQueued(yielder), false);
    assert.equal(harness.system.collisionFailsafe.isWaiting(yielder), false);
    harness.dispose();

});

test("collision backstep is bounded and releases after winner clears", () => {

    const harness = createHarness();
    const blocker = harness.addActor("Blocker", "a");
    const yielding = harness.addActor("Yielding", "b");
    const curve = new THREE.LineCurve3(
        new THREE.Vector3(-2, 0, 0),
        new THREE.Vector3(2, 0, 0)
    );

    blocker.object3D.position.set(0, 0, 0);
    yielding.object3D.position.set(0.25, 0, 0);
    yielding.locomotion.activeCurve = curve;
    yielding.locomotion.curveDistance = 2.25;
    harness.system.prepareCollisionFrame([blocker, yielding]);
    harness.system.resolveResidualCharacterOverlaps(
        [blocker, yielding],
        STEP
    );
    harness.system.resolveCharacterOverlaps([blocker, yielding], 1);

    const backedPosition = yielding.object3D.position.x;
    const backedProgress = yielding.locomotion.curveDistance;
    harness.system.resolveCharacterOverlaps([blocker, yielding], 1);

    assert.ok(backedPosition < 0.25);
    assert.equal(yielding.object3D.position.x, backedPosition);
    assert.equal(yielding.locomotion.curveDistance, backedProgress);
    assert.equal(blocker.object3D.position.x, 0);

    blocker.object3D.position.x = 2;
    harness.system.resolveCharacterOverlaps([blocker, yielding], 1);

    assert.equal(harness.system.collisionSolver.getManeuver(yielding), null);
    assert.equal(yielding.object3D.position.x, backedPosition);
    harness.dispose();

});

test("traffic restores missing physical lane occupancy before authorization", () => {

    const harness = createHarness();
    const actor = harness.addActor("Lane owner", "a");
    const target = harness.graph.requireNode("b").position.clone();

    actor.followWaypoints([{
        id: "b",
        position: target,
        authorizedLaneIndex: 0
    }]);
    harness.system.trafficState.releaseNode("a", actor);
    actor.navigation.beginConnection("a", "b");
    harness.system.trafficState.releaseConnection("a", "b", actor);

    harness.system.updateTraffic(STEP);

    const lane = harness.system.trafficState
        .getConnectionState("a", "b")
        .lanes[0];
    assert.equal(lane.occupants.has(actor), true);
    assert.deepEqual(lane.directions.get(actor), {
        fromId: "a",
        toId: "b"
    });
    harness.dispose();

});

test("same-lane rear contact makes the follower brake without blocking leader", () => {

    const harness = createHarness();
    const follower = harness.addActor("Follower", "a", { priority: 100 });
    const leader = harness.addActor("Leader", "b");
    const target = harness.graph.requireNode("b").position.clone();
    const curve = new THREE.LineCurve3(
        harness.graph.requireNode("a").position.clone(),
        target.clone()
    );
    const lane = harness.system.trafficState
        .getConnectionState("a", "b")
        .lanes[0];

    harness.system.trafficState.releaseAgent(follower);
    harness.system.trafficState.releaseAgent(leader);
    follower.navigation.beginConnection("a", "b");
    leader.navigation.beginConnection("a", "b");
    follower.followWaypoints([{ id: "b", position: target.clone() }]);
    leader.followWaypoints([{ id: "b", position: target.clone() }]);
    follower.locomotion.activeCurve = curve;
    leader.locomotion.activeCurve = curve;
    follower.locomotion.curveDistance = 1;
    leader.locomotion.curveDistance = 1.5;
    follower.object3D.position.set(1, 0, 0);
    leader.object3D.position.set(1.5, 0, 0);

    for (const actor of [follower, leader]) {
        lane.occupants.add(actor);
        lane.directions.set(actor, { fromId: "a", toId: "b" });
    }

    harness.system.prepareCollisionFrame([follower, leader]);
    const encounter = harness.system.collisionFailsafe.getOrCreateEncounter(
        follower,
        leader
    );
    const maneuver = harness.system.collisionSolver.requestClearance(encounter);

    assert.equal(encounter.kind, "same-lane-following");
    assert.equal(encounter.winner, leader);
    assert.equal(encounter.yielder, follower);
    assert.equal(maneuver.strategy, "follow-wait");
    assert.equal(
        harness.system.collisionFailsafe.canMove(leader, target),
        true
    );
    assert.equal(
        harness.system.collisionFailsafe.canMove(follower, target),
        false
    );

    harness.system.resolveCharacterOverlaps([follower, leader], 1);
    assert.ok(follower.object3D.position.x < 1);
    assert.equal(follower.object3D.position.z, 0);
    assert.equal(leader.object3D.position.x, 1.5);

    leader.object3D.position.x = 3;
    harness.system.resolveCharacterOverlaps([follower, leader], STEP);
    assert.equal(harness.system.collisionSolver.getManeuver(follower), null);
    harness.dispose();

});

test("completed curve stays cached while endpoint arrival is denied", () => {

    const actor = new Character("Endpoint waiter");
    const curve = new THREE.LineCurve3(
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(1, 0, 0)
    );
    const originalProjection = actor.locomotion.findClosestCurveDistance
        .bind(actor.locomotion);
    let projections = 0;

    actor.locomotion.findClosestCurveDistance = (...args) => {
        projections++;
        return originalProjection(...args);
    };

    actor.locomotion.moveAlongCurve(curve, 1);
    for (let frame = 0; frame < 20; frame++) {
        actor.locomotion.moveAlongCurve(curve, STEP);
    }

    assert.equal(actor.locomotion.activeCurve, curve);
    assert.equal(projections, 1);

});

test("absolute passage takes queue head within the same operational phase", () => {

    const harness = createHarness();
    const npc = harness.addActor("Queued NPC", "a");
    const player = harness.addActor("Priority Player", "c");

    player.navigationPassagePolicy = "absolute";
    harness.system.traffic.departures.enqueue("b", npc, {
        rank: 5,
        priority: 999,
        kind: "older-grant"
    });
    harness.system.traffic.departures.enqueue("b", player, {
        rank: 5,
        priority: 0,
        kind: "player-command"
    });

    assert.equal(
        harness.system.traffic.departures.getFirst("b"),
        player
    );
    harness.dispose();

});

test("physical node occupant evacuates before absolute remote lookahead", () => {

    const harness = createHarness();
    const occupant = harness.addActor("Node occupant", "b");
    const player = harness.addActor("Priority Player", "a");

    player.navigationPassagePolicy = "absolute";
    harness.system.traffic.departures.enqueue("b", player, {
        rank: 0,
        priority: 100,
        kind: "lookahead"
    });
    harness.system.traffic.departures.enqueue("b", occupant, {
        rank: 3,
        priority: 0,
        kind: "departure"
    });

    assert.equal(
        harness.system.traffic.departures.getFirst("b"),
        occupant
    );
    harness.dispose();

});

test("priority evacuation replanning is throttled", () => {

    const harness = createHarness();
    const player = harness.addActor("Priority Player", "a");
    const blocker = harness.addActor("Idle blocker", "b");
    let plans = 0;

    player.navigationPassagePolicy = "absolute";
    harness.system.moveToClosestNode = () => {
        plans++;
        return false;
    };

    const request = () => harness.system.requestPriorityPassage(
        player,
        [blocker],
        { resourceType: "node", nodeId: "b" }
    );

    request();
    request();
    assert.equal(plans, 1);

    harness.system.navigationTime += 0.75;
    request();
    assert.equal(plans, 2);
    harness.dispose();

});

test("absolute passage shares compatible lane flow and displaces node claims", () => {

    const harness = createHarness();
    const npc = harness.addActor("Reserved NPC", "c");
    const player = harness.addActor("Priority Player", "a");

    player.navigationPassagePolicy = "absolute";
    assert.equal(
        harness.system.trafficState.reserveSpecificConnectionLane(
            "a",
            "b",
            0,
            npc
        ),
        0
    );
    assert.equal(
        harness.system.traffic.reserveLane(player, "a", "b", 0),
        0
    );
    assert.equal(
        harness.system.trafficState.getConnectionLaneIndex("a", "b", npc),
        0
    );

    assert.equal(
        harness.system.trafficState.reserveNodeForTransit("b", npc),
        true
    );
    harness.system.traffic.arrivals.enqueue("b", npc, {
        rank: 5,
        kind: "physical-arrival"
    });
    harness.system.traffic.claimPhysicalArrival("b", player);

    assert.equal(harness.system.traffic.arrivals.getFirst("b"), player);
    assert.equal(
        harness.system.trafficState
            .getNodeState("b").transitReservations.has(npc),
        false
    );
    harness.dispose();

});

test("absolute interaction claim evicts reservations and requests physical exit", () => {

    const harness = createHarness();
    const npc = harness.addActor("Interaction NPC", "c");
    const player = harness.addActor("Priority Player", "a");
    const point = new InteractionPoint("priority:test");
    const state = harness.system.interactionTraffic.getPointState(point);
    const requests = [];

    player.navigationPassagePolicy = "absolute";
    state.reservations.add(npc);

    assert.equal(
        harness.system.interactionTraffic.reservePoint(point, player),
        true
    );
    assert.equal(state.reservations.has(npc), false);

    harness.system.interactionTraffic.releasePoint(point, player);
    state.occupants.add(npc);
    harness.system.requestPriorityPassage = (...args) => {
        requests.push(args);
        return true;
    };

    assert.equal(
        harness.system.interactionTraffic.reservePoint(point, player),
        false
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0][0], player);
    assert.deepEqual(requests[0][1], [npc]);
    harness.dispose();

});

test("PhysicsWorld character bodies are permanently detection-only", () => {

    const harness = createHarness();
    const actor = harness.addActor("Detection only", "a");
    const body = harness.system.physics.actorBodies.get(actor);

    assert.equal(body.type, CANNON.Body.KINEMATIC);
    assert.equal(body.collisionResponse, false);
    assert.equal("manualContactSeparation" in harness.system.physics, false);
    harness.dispose();

});

test("registered actors own structured NavigationAgent state", () => {

    const harness = createHarness();
    const actor = harness.addActor("Agent", "a");
    const agent = harness.system.requireContext(actor);
    const target = new THREE.Vector3(8, 0, 0);

    assert.ok(agent instanceof NavigationAgent);

    // NavigationAgent exposes one canonical location for every state value.
    agent.intent.position = target;
    assert.equal(agent.intent.position, target);
    agent.interaction.exitCommitted = true;
    assert.equal(agent.interaction.exitCommitted, true);
    assert.equal(agent.syncPhase(), NavigationPhase.LEAVING_INTERACTION);

    agent.interaction.exitCommitted = false;
    agent.intent.position = null;
    actor.setState(EntityState.WAITING);
    assert.equal(agent.syncPhase(WaitReason.LANE_FULL), NavigationPhase.WAITING);
    assert.equal(agent.wait.reason, WaitReason.LANE_FULL);

    harness.dispose();

});

test("RoutePlanner creates a plan without moving or reserving for its actor", () => {

    const harness = createHarness();
    const actor = harness.addActor("Planner", "a");
    const agent = harness.system.requireContext(actor);
    const positionBefore = actor.object3D.position.clone();
    const revisionBefore = actor.navigation.getRouteRevision();
    const reservationsBefore = [...harness.graph.nodes.values()]
        .map(node => harness.system.trafficState
            .getNodeState(node.id).reservations.has(actor));

    const candidate = harness.system.routePlanner.findBestPlan(
        agent,
        new THREE.Vector3(8, 0, 0)
    );

    assert.ok(candidate);
    assert.equal(actor.object3D.position.equals(positionBefore), true);
    assert.equal(actor.navigation.getRouteRevision(), revisionBefore);
    assert.deepEqual(
        [...harness.graph.nodes.values()]
            .map(node => harness.system.trafficState
                .getNodeState(node.id).reservations.has(actor)),
        reservationsBefore
    );

    harness.dispose();

});

test("RoutePlanner finds graph origins while an actor occupies an interaction point", () => {

    const harness = createHarness(createGraph({
        nodes: [
            ["a", 0, 0],
            ["b", 4, 0]
        ],
        connections: [["a", "b"]]
    }));
    const actor = harness.addActor("Interaction origin", "a");
    const approach = new InteractionPoint("origin:approach", {
        position: new THREE.Vector3(2, 0, 1),
        connectTo: ["a", "b"]
    });
    harness.connector.register(approach);

    const agent = harness.system.requireContext(actor);
    agent.traversal.interactionPoint = approach;
    actor.navigation.setCurrentNode(null);

    const origins = harness.system.routePlanner.getOrigins(agent);

    assert.deepEqual(
        origins.map(origin => origin.id).sort(),
        ["a", "b"]
    );
    harness.dispose();

});

test("CharacterNavigationSystem facade moves by node id and fully cancels intent", () => {

    const harness = createHarness();
    const actor = harness.addActor("Facade", "a");
    const agent = harness.system.requireContext(actor);

    assert.equal(harness.system.moveTo(actor, "c"), true);
    assert.equal(agent.intent.destinationId, "c");
    assert.equal(actor.navigation.hasPath(), true);

    assert.equal(harness.system.cancel(actor), true);
    assert.equal(agent.intent.position, null);
    assert.equal(agent.intent.interaction, null);
    assert.equal(actor.navigation.hasPath(), false);
    assert.equal(agent.phase, NavigationPhase.IDLE);

    harness.dispose();

});

test("lane geometry is built only after Traffic authorizes the lane", () => {

    const harness = createHarness();
    const actor = harness.addActor("Late geometry", "a");

    assert.equal(harness.system.moveTo(actor, "c"), true);

    const first = actor.navigation.getCurrentWaypoint();
    const future = actor.navigation.getNextWaypoint();

    assert.equal(first.id, "b");
    assert.equal(first.routeGeometry, undefined);
    assert.equal(first.authorizedLaneIndex, undefined);
    assert.equal(future.id, "c");
    assert.equal(future.routeGeometry, undefined);

    assert.equal(actor.authorizeMovementTraffic(), true);
    assert.ok(first.routeGeometry);
    assert.ok(Number.isInteger(first.authorizedLaneIndex));
    assert.equal(future.routeGeometry, undefined);

    const types = first.routeGeometry.segments.map(segment => segment.type);
    assert.deepEqual(types, [
        RouteSegmentType.JUNCTION_TRANSITION,
        RouteSegmentType.LANE
    ]);

    harness.dispose();

});

test("authorized route segments remain smooth and inside their lane", () => {

    const harness = createHarness();
    const actor = harness.addActor("Smooth geometry", "a");

    harness.system.moveTo(actor, "c");
    actor.authorizeMovementTraffic();

    const geometry = actor.navigation.getCurrentWaypoint().routeGeometry;
    const transition = geometry.segments[0];
    const lane = geometry.segments[1];
    const transitionTangent = transition.curve.getTangent(1)
        .setY(0).normalize();
    const laneTangent = lane.curve.getTangent(0)
        .setY(0).normalize();

    // G1 continuity: both local curves share a direction at the portal.
    assert.ok(transitionTangent.dot(laneTangent) > 0.999);
    assert.equal(lane.validation.valid, true);
    assert.equal(lane.validation.reverses, false);
    assert.ok(
        lane.validation.maximumAxisDistance <=
        lane.resource.laneWidth * 0.5
    );

    harness.dispose();

});

test("geometry follows the lane reserved after planning, not a predicted lane", () => {

    const harness = createHarness();
    const actor = harness.addActor("Late lane", "a");
    const blocker = new Character("Lane blocker");

    harness.system.moveTo(actor, "c");
    const waypoint = actor.navigation.getCurrentWaypoint();

    assert.equal(
        harness.system.trafficState.reserveSpecificConnectionLane(
            "a",
            "b",
            0,
            blocker
        ),
        0
    );
    assert.equal(waypoint.routeGeometry, undefined);
    assert.equal(actor.authorizeMovementTraffic(), true);
    assert.equal(waypoint.authorizedLaneIndex, 0);
    assert.equal(
        waypoint.routeSegment.laneIndex,
        waypoint.authorizedLaneIndex
    );

    harness.system.trafficState.releaseAgent(blocker);
    harness.dispose();

});

test("interaction exit and its authorized lane join with one tangent", () => {

    const harness = createHarness();
    const actor = harness.addActor("Interaction exit", "a");
    const approach = new InteractionPoint("exit-approach", {
        position: new THREE.Vector3(2, 0, 0),
        connectTo: ["a", "b"],
        terminal: false
    });

    harness.connector.register(approach);
    harness.system.trafficState.releaseNode("a", actor);
    actor.navigation.setCurrentNode(null);
    actor.object3D.position.copy(approach.getWorldPosition());
    approach.occupants.add(actor);

    const agent = harness.system.requireContext(actor);
    agent.traversal.interactionPoint = approach;
    agent.interaction.active = { point: approach, target: null };

    const leaving = harness.connector.createExitWaypoints(approach, "b")[0];
    const destination = {
        id: "b",
        position: harness.graph.requireNode("b").position.clone()
    };

    actor.followWaypoints([leaving, destination]);

    assert.ok(Number.isInteger(
        leaving.connectionEntry.preferredLaneIndex
    ));
    assert.equal(leaving.connectionEntry.laneIndex, undefined);
    assert.equal(
        harness.system.traffic.preflightInteractionExit(
            actor,
            leaving.connectionEntry
        ),
        true
    );
    assert.equal(
        harness.system.traffic.tryEnterFromInteraction(
            actor,
            leaving.connectionEntry,
            leaving
        ),
        true
    );

    const authorizedDestination = actor.navigation.getNextWaypoint();

    assert.ok(leaving.routeCurve, "interaction exit curve was not created");
    assert.ok(
        authorizedDestination.routeCurve,
        "authorized lane curve was not created"
    );

    const exitTangent = leaving.routeCurve.getTangent(1)
        .setY(0).normalize();
    const laneTangent = authorizedDestination.routeCurve.getTangent(0)
        .setY(0).normalize();

    assert.ok(exitTangent.dot(laneTangent) > 0.999);
    assert.equal(
        authorizedDestination.routeSegment.laneIndex,
        harness.system.trafficState.getConnectionLaneIndex("a", "b", actor)
    );

    harness.dispose();

});

test("explicit node access may place an interaction point far from the graph", () => {

    const harness = createHarness();
    const point = new InteractionPoint("remote-point", {
        position: new THREE.Vector3(0, 0, 30),
        connectTo: "a",
        maxConnectionDistance: 0.5
    });

    const registered = harness.connector.register(point);
    const connection = point.connection;

    assert.equal(registered, true);
    assert.deepEqual(connection.nodeIds, ["a"]);
    assert.equal(connection.anchor, null);
    assert.equal(connection.automatic, false);
    harness.dispose();

});

test("direct interaction exit targets the next lane portal and skips node center", () => {

    const harness = createHarness();
    const point = new InteractionPoint("direct-exit", {
        position: new THREE.Vector3(-2, 0, 3),
        rotationY: Math.PI / 2,
        connectTo: "a"
    });

    harness.connector.register(point);

    const leaving = harness.connector.createExitWaypoints(
        point,
        "a",
        { nextNodeId: "b" }
    )[0];
    const laneIndex = harness.connector.getRightHandLaneIndex("a", "b");
    const expectedPortal = harness.system.routeGeometry
        .getConnectionLaneNodePosition("a", "a", "b", laneIndex);
    const nodeCenter = harness.graph.requireNode("a").position;

    assert.ok(leaving.position.distanceTo(expectedPortal) < 0.0001);
    assert.ok(leaving.position.distanceTo(nodeCenter) > 0.01);
    assert.equal(leaving.skipGraphOrigin, true);
    assert.deepEqual(
        {
            fromId: leaving.connectionEntry.fromId,
            toId: leaving.connectionEntry.toId,
            preferredLaneIndex: leaving.connectionEntry.preferredLaneIndex
        },
        { fromId: "a", toId: "b", preferredLaneIndex: laneIndex }
    );
    harness.dispose();

});

test("obtuse junction preserves the incoming tangent between lanes", () => {

    const graph = createGraph({
        nodes: [
            ["a", -4, 0],
            ["b", 0, 0],
            ["c", -3, 2]
        ],
        connections: [
            ["a", "b"],
            ["b", "c"]
        ]
    });
    const harness = createHarness(graph);
    const actor = harness.addActor("Obtuse turn", "a");
    const first = harness.system.geometryBuilder
        .createAuthorizedConnectionGeometry({
            actor,
            fromId: "a",
            toId: "b",
            laneIndex: 0
        });
    const second = harness.system.geometryBuilder
        .createAuthorizedConnectionGeometry({
            actor,
            fromId: "b",
            toId: "c",
            laneIndex: 0,
            startPosition: first.laneEnd,
            departureDirection: first.arrivalDirection
        });
    const incoming = first.geometry.curve.getTangent(1).setY(0).normalize();
    const outgoing = second.geometry.curve.getTangent(0).setY(0).normalize();
    const transitionEnd = second.geometry.segments[0].curve
        .getTangent(1).setY(0).normalize();
    const laneStart = second.geometry.segments.at(-1).curve
        .getTangent(0).setY(0).normalize();

    assert.ok(incoming.dot(outgoing) > 0.999);
    assert.ok(transitionEnd.dot(laneStart) > 0.999);
    harness.dispose();

});

test("junction transition uses circular handles between lane portals", () => {

    const graph = createGraph({
        nodes: [
            ["west", -5, 0],
            ["junction", 0, 0],
            ["north", 0, -5]
        ],
        connections: [
            ["west", "junction"],
            ["junction", "north"]
        ]
    });
    const harness = createHarness(graph);
    const actor = harness.addActor("Circular turn", "west");
    const arrival = harness.system.geometryBuilder
        .createAuthorizedConnectionGeometry({
            actor,
            fromId: "west",
            toId: "junction",
            laneIndex: 0
        });
    const departure = harness.system.geometryBuilder
        .createAuthorizedConnectionGeometry({
            actor,
            fromId: "junction",
            toId: "north",
            laneIndex: 0,
            startPosition: arrival.laneEnd,
            departureDirection: arrival.arrivalDirection
        });
    const curve = departure.geometry.segments[0].curve;
    const chord = Math.hypot(
        curve.v3.x - curve.v0.x,
        curve.v3.z - curve.v0.z
    );
    const turn = arrival.arrivalDirection.angleTo(
        departure.arrivalDirection
    );
    const expected = chord /
        (3 * Math.cos(turn / 4) ** 2);
    const firstHandle = curve.v1.distanceTo(curve.v0);
    const secondHandle = curve.v3.distanceTo(curve.v2);

    assert.ok(Math.abs(firstHandle - expected) < 0.0001);
    assert.ok(Math.abs(secondHandle - expected) < 0.0001);
    harness.dispose();

});

test("authorized next lane keeps the physical arrival tangent after replanning", () => {

    const graph = createGraph({
        nodes: [
            ["a", -4, 0],
            ["b", 0, 0],
            ["c", 0, -4]
        ],
        connections: [
            ["a", "b"],
            ["b", "c"]
        ]
    });
    const harness = createHarness(graph);
    const actor = harness.addActor("Replanned tangent", "a");
    const context = harness.system.requireContext(actor);
    const physicalTangent = new THREE.Vector3(1, 0, 0);
    const waypoint = {
        id: "c",
        position: graph.requireNode("c").position.clone()
    };

    harness.system.trafficState.releaseNode("a", actor);
    harness.system.trafficState.occupyNode("b", actor);
    actor.navigation.setCurrentNode("b");
    actor.followWaypoints([waypoint]);
    context.traversal.transitTangent = {
        nodeId: "b",
        // This is intentionally stale. The physical arrival direction at b
        // remains valid even when the formerly planned next node changed.
        nextNodeId: "obsolete-plan",
        direction: physicalTangent
    };

    const originalBuilder = harness.system.geometryBuilder
        .createAuthorizedConnectionGeometry.bind(
            harness.system.geometryBuilder
        );
    let receivedDeparture = null;
    harness.system.geometryBuilder.createAuthorizedConnectionGeometry =
        options => {
            receivedDeparture = options.departureDirection;
            return originalBuilder(options);
        };

    assert.equal(
        harness.system.traffic.tryStartConnection(
            actor,
            "b",
            "c",
            waypoint
        ),
        true
    );
    assert.equal(receivedDeparture, physicalTangent);
    harness.dispose();

});

test("traffic cancellation preserves tangent while physically on a lane", () => {

    const harness = createHarness();
    const actor = harness.addActor("Mid-lane command", "a");

    harness.system.moveTo(actor, "c");
    actor.authorizeMovementTraffic();

    const agent = harness.system.requireContext(actor);
    const tangent = agent.traversal.transitTangent;

    harness.system.traffic.cancel(actor);

    assert.equal(agent.traversal.transitTangent, tangent);
    assert.ok(agent.traversal.transitTangent.direction.lengthSq() > 0.9);
    harness.dispose();

});

test("approach exit uses the near portal for the node on the actor's right", () => {

    const graph = createGraph({
        nodes: [
            ["left", -5, 0],
            ["right", 5, 0]
        ],
        connections: [["left", "right"]]
    });
    const harness = createHarness(graph);
    const approach = new InteractionPoint("directional:approach", {
        position: new THREE.Vector3(0, 0, 1),
        // Entry faces -Z; the authored 180-degree exit faces +Z. With +Z as
        // forward, the actor's right-hand destination is world -X (left).
        rotationY: Math.PI,
        connectTo: ["left", "right"],
        terminal: false
    });

    harness.connector.register(approach);

    const access = approach.connection;
    const pointPosition = approach.getWorldPosition();
    const nearLaneIndex = access.anchor.lanePositions.reduce(
        (closest, position, index) =>
            position.distanceToSquared(pointPosition) <
                access.anchor.lanePositions[closest]
                    .distanceToSquared(pointPosition)
                ? index
                : closest,
        0
    );
    const farLaneIndex = nearLaneIndex === 0 ? 1 : 0;
    const rightExit = harness.connector.createExitWaypoints(
        approach,
        "left"
    )[0];
    const leftExit = harness.connector.createExitWaypoints(
        approach,
        "right"
    )[0];

    assert.equal(rightExit.preferredLaneIndex, nearLaneIndex);
    assert.equal(leftExit.preferredLaneIndex, farLaneIndex);
    assert.ok(
        rightExit.position.distanceToSquared(
            access.anchor.lanePositions[nearLaneIndex]
        ) < 0.0001
    );

    harness.dispose();

});

test("direct interaction exit does not revisit its graph origin", () => {

    const harness = createHarness();
    const actor = harness.addActor("Direct exit route", "a");
    const point = new InteractionPoint("ambient:direct-exit", {
        position: new THREE.Vector3(-2, 0, 3),
        rotationY: Math.PI / 2,
        connectTo: "a"
    });

    harness.connector.register(point);
    harness.system.trafficState.releaseNode("a", actor);
    actor.navigation.setCurrentNode(null);
    actor.object3D.position.copy(point.getWorldPosition());
    point.occupants.add(actor);

    const agent = harness.system.requireContext(actor);
    agent.traversal.interactionPoint = point;
    agent.interaction.active = { point, target: null };

    assert.equal(harness.system.moveToClosestNode(
        actor,
        harness.graph.requireNode("c").position,
        {
            skipInteractionExit: true,
            skipTurnaround: true
        }
    ), true);

    const waypoints = actor.navigation.getRemainingWaypoints();
    const leaving = waypoints[0];
    const graphIds = waypoints
        .map(waypoint => waypoint.id)
        .filter(Boolean);

    assert.deepEqual(
        [leaving.connectionEntry.fromId, leaving.connectionEntry.toId],
        ["a", "b"]
    );
    assert.deepEqual(graphIds, ["b", "c"]);
    assert.equal(graphIds.includes("a"), false);

    harness.dispose();

});

test("direct action exit hands off to an approach lane portal without node center", () => {

    const harness = createHarness();
    const actor = harness.addActor("Interaction handoff", "a");
    const source = new InteractionPoint("ambient:source", {
        position: new THREE.Vector3(-2, 0, 2),
        connectTo: "a"
    });
    const approach = new InteractionPoint("target:approach", {
        position: new THREE.Vector3(1.5, 0, 1),
        terminal: false
    });

    harness.connector.register(source);
    harness.connector.register(approach);
    harness.system.trafficState.releaseNode("a", actor);
    actor.navigation.setCurrentNode(null);
    actor.object3D.position.copy(source.getWorldPosition());
    source.occupants.add(actor);

    const agent = harness.system.requireContext(actor);
    agent.traversal.interactionPoint = source;
    agent.interaction.active = { point: source, target: null };

    assert.equal(harness.system.moveToInteraction(
        actor,
        approach,
        null,
        {
            skipInteractionExit: true,
            skipTurnaround: true
        }
    ), true);

    const waypoints = actor.navigation.getRemainingWaypoints();
    const exit = waypoints[0];
    const approachDeparture = waypoints[1];

    assert.equal(exit.leavingInteraction, true);
    assert.equal(exit.graphEntryNodeId, "a");
    assert.equal(approachDeparture.leavingGraph, true);
    assert.ok(approachDeparture.laneStartPosition);
    assert.ok(
        exit.position.distanceToSquared(
            approachDeparture.laneStartPosition
        ) < 0.0001
    );
    assert.ok(
        exit.position.distanceToSquared(
            harness.graph.requireNode("a").position
        ) > 0.0001
    );
    assert.equal(
        waypoints.some(waypoint => waypoint.id === "a"),
        false
    );

    harness.system.refreshPlannedRoutePreview(agent, true);
    const preview = harness.system.routeGeometry.plannedLaneCurves.get(actor);
    const nodeCenter = harness.graph.requireNode("a").position;

    assert.ok(preview?.length > 2);
    assert.equal(
        preview.some(point => point.distanceToSquared(nodeCenter) < 0.0001),
        false
    );

    const speculativeSignature = agent.route.previewSignature;
    approachDeparture.routeCurve = new THREE.LineCurve3(
        approachDeparture.laneStartPosition.clone(),
        approachDeparture.position.clone()
    );
    actor.navigation.touchGeometry();
    harness.system.refreshPlannedRoutePreview(agent);

    assert.notEqual(agent.route.previewSignature, speculativeSignature);

    harness.dispose();

});

test("interaction approach curve arrives along the authored point direction", () => {

    const harness = createHarness();
    const authoredDirection = new THREE.Vector3(1, 0, 0);
    const geometry = harness.system.geometryBuilder.createInteractionGeometry({
        start: new THREE.Vector3(0, 0, 0),
        portal: new THREE.Vector3(4, 0, 2),
        departureDirection: new THREE.Vector3(1, 0, 0),
        arrivalDirection: authoredDirection
    });
    const arrivalTangent = geometry.curve.getTangent(1).setY(0).normalize();

    assert.ok(arrivalTangent.dot(authoredDirection) > 0.999);
    harness.dispose();

});

test("planned route geometry exists before traffic authorizes movement", () => {

    const harness = createHarness();
    const actor = harness.addActor("Planner", "a");
    const context = harness.system.requireContext(actor);

    harness.system.moveTo(actor, "c");
    harness.system.refreshPlannedRoutePreview(context, true);

    const planned = harness.system.routeGeometry.plannedLaneCurves.get(actor);

    assert.ok(planned?.length > 2);
    assert.equal(
        harness.system.routeGeometry.activeLaneCurves.has(actor),
        false
    );
    assert.equal(actor.navigation.getCurrentWaypoint().routeGeometry, undefined);
    harness.dispose();

});

test("junction handshake serializes crossing plans and admits independent ones", () => {

    const harness = createHarness();
    const first = harness.addActor("First handshake", "a");
    const second = harness.addActor("Second handshake", "c");
    const geometry = harness.system.routeGeometry;

    harness.system.traffic.arrivals.enqueue("b", first, {
        rank: 5,
        kind: "physical-arrival"
    });
    harness.system.traffic.arrivals.enqueue("b", second, {
        rank: 5,
        kind: "physical-arrival"
    });
    geometry.setPlannedLaneCurve(first, [
        new THREE.Vector3(2, 0, 0),
        new THREE.Vector3(6, 0, 0)
    ]);
    geometry.setPlannedLaneCurve(second, [
        new THREE.Vector3(4, 0, -2),
        new THREE.Vector3(4, 0, 2)
    ]);

    assert.equal(harness.system.traffic.hasArrivalGrant("b", second), false);

    geometry.setPlannedLaneCurve(second, [
        new THREE.Vector3(2, 0, 1.5),
        new THREE.Vector3(6, 0, 1.5)
    ]);

    assert.equal(harness.system.traffic.hasArrivalGrant("b", second), true);
    assert.equal(
        harness.system.trafficState.occupyNode("b", first, { crossing: true }),
        true
    );
    assert.equal(harness.system.traffic.canCrossNode("b", second), true);
    harness.dispose();

});

test("NavigationGraphHelper removes current and legacy route lines", () => {

    const names = [
        "Actor:NavigationSegments",
        "Actor:NavigationSegmentsDirection",
        "Actor:NavigationPlan",
        "Actor:NavigationPlanDirection",
        "Actor:NavigationSpline",
        "Actor:NavigationSplineDirection",
        "NavigationEdges:Free"
    ];
    const removed = [];
    const helper = {
        routeGeometry: { activeLaneCurveRevision: 2 },
        activeLaneCurveRevision: 1,
        removeChildren(predicate) {

            for (const name of names) {

                if (predicate({ name })) removed.push(name);

            }

        },
        addActiveLaneCurves() { }
    };

    NavigationGraphHelper.prototype.refreshActiveLaneCurves.call(helper);

    assert.deepEqual(removed, names.slice(0, 6));
    assert.equal(helper.activeLaneCurveRevision, 2);

});


function getAllConnections(graph) {

    return [...new Set(
        [...graph.nodes.values()].flatMap(node =>
            [...node.connections.values()]
        )
    )];

}

function getInteractionLocation(context) {

    return context.interaction.active?.point ??
        context.traversal.interactionPoint ??
        null;

}

function assertNavigationInvariants({ graph, connector, system }) {

    for (const node of graph.nodes.values()) {

        const nodeState = system.trafficState.getNodeState(node.id);
        const activeOccupants = [...nodeState.occupants].filter(actor =>
            !nodeState.crossingAgents.has(actor)
        );

        assert.ok(
            activeOccupants.length <= 1,
            `node ${node.id} has multiple non-crossing occupants`
        );

    }

    for (const connection of getAllConnections(graph)) {

        const connectionState = system.trafficState.getConnectionState(
            connection.fromId,
            connection.toId
        );

        for (const lane of connectionState.lanes) {

            // A lane is a directional stream. Multiple actors may follow one
            // another, but opposite directions may never share that stream.
            const directions = [
                ...lane.occupants,
                ...lane.reservations
            ].map(actor => lane.directions.get(actor));
            const firstDirection = directions[0];

            assert.ok(
                directions.every(direction =>
                    direction &&
                    direction.fromId === firstDirection?.fromId &&
                    direction.toId === firstDirection?.toId
                ),
                `lane ${connection.fromId}/${connection.toId}:${lane.index} ` +
                "has incompatible traffic directions"
            );

            for (const actor of lane.occupants) {

                assert.ok(
                    lane.directions.has(actor),
                    `${actor.name} occupies a lane without a direction`
                );

            }

        }

    }

    for (const [actor, context] of system.agents) {

        const traversal = actor.navigation.getTraversalState();
        const locations = [
            Boolean(traversal.currentNodeId),
            Boolean(traversal.currentConnection),
            Boolean(getInteractionLocation(context))
        ].filter(Boolean).length;

        assert.equal(
            locations,
            1,
            `${actor.name} must belong to exactly one navigation location`
        );

        if (!actor.isState(EntityState.WAITING)) continue;

        const waitingHasOwner = Boolean(
            system.traffic.waitReasons.has(actor) ||
            system.traffic.isQueued(actor) ||
            system.collisionFailsafe.isWaiting(actor) ||
            context.intent.position ||
            context.intent.interaction ||
            context.intent.deferredCommand ||
            context.interaction.active ||
            context.turnaround.active ||
            context.interaction.entering ||
            context.interaction.leaving ||
            context.interaction.exitCommitted ||
            context.wait.blockedElapsed !== null ||
            context.recovery.pending ||
            context.recovery.orphanedElapsed > 0 ||
            actor.navigation.hasPath()
        );

        assert.ok(
            waitingHasOwner,
            `${actor.name} is WAITING without a responsible subsystem`
        );

    }

    // Connector ownership must always refer to actors still registered in the
    // navigation system. This catches leaked action/approach reservations.
    for (const point of connector.points.values()) {

        for (const actor of [...point.occupants, ...point.reservations]) {

            assert.ok(
                system.agents.has(actor),
                `${actor.name} remained on InteractionPoint ${point.id}`
            );

        }

    }

}

function assertActorHasNoClaims(harness, actor) {

    const { graph, connector, system } = harness;

    for (const node of graph.nodes.values()) {

        const nodeState = system.trafficState.getNodeState(node.id);

        for (const collection of [
            nodeState.occupants,
            nodeState.reservations,
            nodeState.transitReservations,
            nodeState.crossingAgents
        ]) {

            assert.equal(collection.has(actor), false);

        }

    }

    for (const connection of getAllConnections(graph)) {

        const connectionState = system.trafficState.getConnectionState(
            connection.fromId,
            connection.toId
        );

        assert.equal(connectionState.occupants.has(actor), false);
        assert.equal(connectionState.reservations.has(actor), false);

        for (const lane of connectionState.lanes) {

            assert.equal(lane.occupants.has(actor), false);
            assert.equal(lane.reservations.has(actor), false);
            assert.equal(lane.directions.has(actor), false);

        }

    }

    for (const point of connector.points.values()) {

        assert.equal(point.occupants.has(actor), false);
        assert.equal(point.reservations.has(actor), false);

    }

    assert.equal(system.traffic.departures.has(actor), false);
    assert.equal(system.traffic.arrivals.has(actor), false);
    assert.equal(system.traffic.waitReasons.has(actor), false);

}

test("two actors travelling in opposite directions reserve different lanes", () => {

    const graph = createLineGraph();
    const trafficState = new NavigationTrafficState(graph);
    const first = new Character("First");
    const second = new Character("Second");
    const firstLane = trafficState.reserveConnectionLane("a", "b", first);
    const secondLane = trafficState.reserveConnectionLane("b", "a", second);

    assert.equal(firstLane, 0);
    assert.equal(secondLane, 1);
    assert.equal(
        trafficState.occupyConnectionLane("a", "b", first, firstLane),
        true
    );
    assert.equal(
        trafficState.occupyConnectionLane("b", "a", second, secondLane),
        true
    );
    assertNavigationInvariants({
        graph,
        connector: { points: new Map() },
        system: {
            agents: new Map(),
            trafficState,
            traffic: {},
            collisionFailsafe: {}
        }
    });

});

test("actors travelling in the same direction share one lane stream", () => {

    const graph = createLineGraph();
    const trafficState = new NavigationTrafficState(graph);
    const leader = new Character("Leader");
    const follower = new Character("Follower");
    const leaderLane = trafficState.reserveConnectionLane(
        "a",
        "b",
        leader
    );

    trafficState.occupyConnectionLane("a", "b", leader, leaderLane);
    const followerLane = trafficState.reserveConnectionLane(
        "a",
        "b",
        follower
    );

    assert.equal(followerLane, leaderLane);
    assert.deepEqual(
        trafficState.getConnectionState("a", "b")
            .lanes[leaderLane]
            .directions.get(follower),
        { fromId: "a", toId: "b" }
    );

});

test("releasing future reservations preserves an occupied lane direction", () => {

    const graph = createLineGraph();
    const trafficState = new NavigationTrafficState(graph);
    const actor = { name: "In transit" };
    const laneIndex = trafficState.reserveConnectionLane("a", "b", actor);

    assert.notEqual(laneIndex, null);
    assert.equal(
        trafficState.occupyConnectionLane("a", "b", actor, laneIndex),
        true
    );

    trafficState.releaseReservations(actor);

    const lane = trafficState
        .getConnectionState("a", "b")
        .lanes[laneIndex];

    assert.equal(lane.occupants.has(actor), true);
    assert.deepEqual(lane.directions.get(actor), { fromId: "a", toId: "b" });

});

test("simultaneous arrivals cannot both claim the same node", () => {

    const graph = createLineGraph();
    const trafficState = new NavigationTrafficState(graph);
    const first = new Character("First");
    const second = new Character("Second");

    assert.equal(trafficState.reserveNodeForTransit("b", first), true);
    assert.equal(trafficState.reserveNodeForTransit("b", second), false);
    trafficState.yieldTransitReservationsToArrival("b", first);
    assert.equal(trafficState.occupyNode("b", first), true);
    // CharacterNavigationSystem checks this guard before calling occupyNode.
    // occupyNode itself only commits an arrival that was already authorized.
    assert.equal(trafficState.isNodeAvailable("b", second), false);
    assert.deepEqual(
        [...trafficState.getNodeState("b").occupants],
        [first]
    );

});

test("actors approaching the same junction may both reach their endpoints", () => {

    const graph = createGraph({
        nodes: [
            ["west", -4, 0],
            ["junction", 0, 0],
            ["east", 4, 0]
        ],
        connections: [
            ["west", "junction"],
            ["east", "junction"]
        ]
    });
    const harness = createHarness(graph);
    const first = harness.addActor("First arrival", "west");
    const second = harness.addActor("Second arrival", "east");
    const junction = graph.requireNode("junction");

    assert.equal(harness.system.traffic.tryStartConnection(
        first,
        "west",
        "junction",
        { id: "junction", position: junction.position.clone() }
    ), true);
    assert.equal(harness.system.traffic.tryStartConnection(
        second,
        "east",
        "junction",
        { id: "junction", position: junction.position.clone() }
    ), true);

    assert.equal(
        harness.system.trafficState
            .getConnectionState("west", "junction")
            .occupants.has(first),
        true
    );
    assert.equal(
        harness.system.trafficState
            .getConnectionState("east", "junction")
            .occupants.has(second),
        true
    );
    assert.equal(
        harness.system.trafficState
            .getNodeState("junction")
            .transitReservations.has(first),
        false
    );
    assert.equal(
        harness.system.trafficState
            .getNodeState("junction")
            .transitReservations.has(second),
        false
    );
    harness.dispose();

});

test("an approaching actor may reach the endpoint before a node occupant departs", () => {

    const graph = createGraph({
        nodes: [
            ["west", -4, 0],
            ["junction", 0, 0],
            ["east", 4, 0]
        ],
        connections: [
            ["west", "junction"],
            ["junction", "east"]
        ]
    });
    const harness = createHarness(graph);
    const occupant = harness.addActor("Occupant", "junction");
    const arrival = harness.addActor("Arrival", "west");

    assert.equal(harness.system.traffic.tryStartConnection(
        arrival,
        "west",
        "junction",
        {
            id: "junction",
            position: graph.requireNode("junction").position.clone()
        }
    ), true);
    assert.equal(harness.system.traffic.tryStartConnection(
        occupant,
        "junction",
        "east",
        { id: "east", position: graph.requireNode("east").position.clone() }
    ), true);
    assert.equal(harness.system.traffic.tryStartConnection(
        arrival,
        "west",
        "junction",
        {
            id: "junction",
            position: graph.requireNode("junction").position.clone()
        }
    ), true);

    harness.dispose();

});

test("junction wait does not time out while its granted actor is moving", () => {

    const harness = createHarness();
    const granted = harness.addActor("Granted", "a");
    const waiting = harness.addActor("Waiting", "c", {
        intentPolicy: "replaceable"
    });

    harness.system.traffic.arrivals.enqueue("b", granted, {
        rank: 2,
        kind: "arrival"
    });
    harness.system.traffic.arrivals.enqueue("b", waiting, {
        rank: 2,
        kind: "arrival"
    });
    harness.system.traffic.setWaitReason(
        waiting,
        "b",
        WaitReason.ENDPOINT_WAIT
    );
    granted.locomotion.getMotionState().moving = true;

    harness.system.traffic.update(10);

    const wait = harness.system.traffic.waitReasons.get(waiting);
    assert.equal(wait.elapsed, 0);
    assert.equal(wait.timeoutCount, 0);
    harness.dispose();

});

test("character physics bodies cannot push actors away from navigation", () => {

    const harness = createHarness();
    const actor = harness.addActor("Kinematic", "a");
    const body = harness.system.physics.actorBodies.get(actor);
    const expected = actor.object3D.position.clone();

    body.position.x += 3;
    body.position.z += 2;
    harness.system.physics.solve(STEP);

    assert.equal(body.collisionResponse, false);
    assert.ok(actor.object3D.position.equals(expected));
    assert.equal(body.position.x, expected.x);
    assert.equal(body.position.z, expected.z);
    harness.dispose();

});

test("three actors leave a congested node in stable queue order", () => {

    const harness = createHarness();
    const first = harness.addActor("First", "b", { priority: 2 });
    const second = harness.addActor("Second", "a", { priority: 1 });
    const third = harness.addActor("Third", "c");
    const queue = harness.system.traffic.departures;

    // Queue ordering is independent from physical occupancy. Action points
    // also enqueue through their own origin key and never masquerade as actors
    // resting inside this node.
    assertNavigationInvariants(harness);

    queue.enqueue("b", third, { rank: 3, priority: 0 });
    queue.enqueue("b", second, { rank: 3, priority: 1 });
    queue.enqueue("b", first, { rank: 3, priority: 2 });

    assert.equal(queue.getFirst("b"), first);
    queue.complete("b", first);
    assert.equal(queue.getFirst("b"), second);
    queue.complete("b", second);
    assert.equal(queue.getFirst("b"), third);
    harness.dispose();

});

test("interaction exit joins actors moving in the same lane direction", () => {

    const harness = createHarness();
    const leaving = harness.addActor("Leaving", "a", {
        intentPolicy: "replaceable"
    });
    const blocker = harness.addActor("Blocker", "b");
    const approach = new InteractionPoint("approach", {
        position: new THREE.Vector3(2, 0, 0),
        connectTo: ["a", "b"],
        terminal: false
    });

    harness.connector.register(approach);
    approach.occupants.add(leaving);
    const context = harness.system.requireContext(leaving);
    context.traversal.interactionPoint = approach;
    context.interaction.active = { point: approach, target: null };
    leaving.navigation.setCurrentNode(null);

    const connection = harness.system.trafficState
        .getConnectionState("a", "b");
    for (const lane of connection.lanes) {

        lane.occupants.add(blocker);
        lane.directions.set(blocker, { fromId: "a", toId: "b" });

    }

    const entry = harness.connector.createExitWaypoints(approach, "b")
        .find(waypoint => waypoint.connectionEntry)
        .connectionEntry;

    assert.equal(
        harness.system.traffic.preflightInteractionExit(leaving, entry),
        true
    );
    assert.equal(approach.occupants.has(leaving), true);
    assert.equal(context.interaction.active.point, approach);
    harness.system.trafficState.releaseAgent(blocker);
    harness.dispose();

});

test("replaceable NPC abandons a blocked interaction and excludes it once", () => {

    const harness = createHarness();
    const npc = harness.addActor("NPC", "a", {
        intentPolicy: "replaceable"
    });
    const blocked = new InteractionPoint("blocked", {
        position: new THREE.Vector3(4, 0, 0),
        connectTo: "b"
    });
    const alternative = new InteractionPoint("alternative", {
        position: new THREE.Vector3(8, 0, 0),
        connectTo: "c"
    });
    const context = harness.system.requireContext(npc);

    harness.connector.register(blocked);
    harness.connector.register(alternative);
    context.intent.interaction = { point: blocked, onArrive: null };
    npc.setState(EntityState.WAITING);
    harness.system.traffic.setWaitReason(
        npc,
        "a",
        WaitReason.LANE_FULL,
        { connection: { fromId: "a", toId: "b" } }
    );

    assert.equal(harness.system.resolveTrafficWaitTimeout(npc, {
        reason: WaitReason.LANE_FULL,
        resourceId: "a",
        timeoutCount: 1
    }), true);
    assert.equal(npc.navigationAvoidInteractionPoint, blocked);

    let request = null;
    const behavior = new UseAvailableInteractionBehavior({
        interactionSystem: {
            request(candidate) {

                request = candidate;
                return candidate.excludePointIds.includes("blocked");

            }
        }
    });

    assert.equal(behavior.tryStart(npc), true);
    assert.ok(request.excludePoints.includes(blocked));
    assert.equal(npc.navigationAvoidInteractionPoint, null);
    harness.dispose();

});

test("persistent Player keeps an intent that is temporarily unreachable", () => {

    const harness = createHarness();
    const player = harness.addActor("Player", "a");
    const target = harness.graph.requireNode("c").position.clone();

    harness.graph.setNodeBlocked("c", true);
    assert.equal(harness.system.moveToClosestNode(player, target), false);

    const context = harness.system.requireContext(player);
    assert.ok(context.intent.position.equals(target));
    assert.equal(player.isState(EntityState.WAITING), true);
    assertActorHasNoClaimsExceptLocation(harness, player, "a");
    harness.dispose();

});

function assertActorHasNoClaimsExceptLocation(harness, actor, nodeId) {

    const node = harness.system.trafficState.getNodeState(nodeId);

    assert.equal(node.occupants.has(actor), true);
    assert.equal(harness.system.traffic.isQueued(actor), false);

    for (const connection of getAllConnections(harness.graph)) {

        const state = harness.system.trafficState.getConnectionState(
            connection.fromId,
            connection.toId
        );

        for (const lane of state.lanes) {

            assert.equal(lane.occupants.has(actor), false);
            assert.equal(lane.reservations.has(actor), false);

        }

    }

}

test("cancelling navigation releases every future claim", () => {

    const harness = createHarness();
    const actor = harness.addActor("Actor", "a");
    const point = new InteractionPoint("point", {
        position: new THREE.Vector3(8, 0, 0),
        connectTo: "c"
    });

    harness.connector.register(point);
    harness.system.trafficState.reserveNode("c", actor);
    harness.system.trafficState.reserveConnectionLane("a", "b", actor);
    harness.system.interactionTraffic.reservePoint(point, actor);
    harness.system.traffic.departures.enqueue("a", actor);
    harness.system.traffic.arrivals.enqueue("b", actor);
    harness.system.traffic.setWaitReason(actor, "a", WaitReason.QUEUE_HEAD);
    actor.cancel();

    // Current-node occupancy is location, not a future claim.
    harness.system.trafficState.releaseNode("a", actor);
    assertActorHasNoClaims(harness, actor);
    harness.dispose();

});

test("unregistering an actor releases node, lane, queues and InteractionPoint", () => {

    const harness = createHarness();
    const actor = harness.addActor("Removed", "a");
    const point = new InteractionPoint("point", {
        position: new THREE.Vector3(4, 0, 0),
        connectTo: "b"
    });

    harness.connector.register(point);
    harness.system.trafficState.reserveConnectionLane("a", "b", actor);
    harness.system.interactionTraffic.reservePoint(point, actor);
    harness.system.traffic.departures.enqueue("a", actor);
    harness.system.traffic.arrivals.enqueue("b", actor);
    harness.system.traffic.setWaitReason(actor, "a", WaitReason.QUEUE_HEAD);

    harness.system.unregisterActor(actor);

    assert.equal(harness.system.agents.has(actor), false);
    assertActorHasNoClaims(harness, actor);
    harness.dispose();

});

test("topology changes rebuild an active route through the remaining branch", () => {

    const graph = createGraph({
        nodes: [
            ["a", 0, 0],
            ["b", 3, -2],
            ["d", 3, 2],
            ["c", 6, 0]
        ],
        connections: [
            ["a", "b"],
            ["b", "c"],
            ["a", "d"],
            ["d", "c"]
        ]
    });
    const harness = createHarness(graph);
    const actor = harness.addActor("Player", "a");
    const destination = graph.requireNode("c").position.clone();

    assert.equal(harness.system.moveToClosestNode(actor, destination), true);
    assert.ok(actor.navigation.getRemainingWaypoints().some(
        waypoint => waypoint.id === "b"
    ));

    graph.setConnectionBlocked("b", "c", true);
    harness.system.topologyChanged();

    const ids = actor.navigation.getRemainingWaypoints()
        .map(waypoint => waypoint.id)
        .filter(Boolean);
    assert.ok(ids.includes("d"));
    assert.equal(ids.includes("b"), false);
    harness.dispose();

});

test("an off-graph actor restarts its preserved intent from nearest access", () => {

    const harness = createHarness();
    const actor = harness.addActor("Player", "a");
    const context = harness.system.requireContext(actor);
    const target = harness.graph.requireNode("c").position.clone();

    harness.system.trafficState.releaseNode("a", actor);
    actor.navigation.setCurrentNode(null);
    actor.object3D.position.copy(
        harness.graph.requireNode("b").position
    );
    context.intent.position = target.clone();

    assert.equal(
        harness.system.restartIntentFromNearestAccess(context),
        true
    );
    assert.ok(actor.navigation.hasPath());
    assert.ok(context.intent.position.equals(target));
    assert.equal(
        actor.navigation.getTraversalState().currentNodeId,
        "b"
    );
    assertNavigationInvariants(harness);
    harness.dispose();

});

test("committed interaction exit cannot be abandoned by recovery", () => {

    const harness = createHarness();
    const actor = harness.addActor("NPC", "a", {
        intentPolicy: "replaceable"
    });
    const point = new InteractionPoint("action", {
        position: new THREE.Vector3(2, 0, 0),
        connectTo: ["a", "b"]
    });
    const context = harness.system.requireContext(actor);

    harness.connector.register(point);
    harness.system.trafficState.releaseNode("a", actor);
    actor.navigation.setCurrentNode(null);
    point.occupants.add(actor);
    context.interaction.active = { point, target: null };
    context.traversal.interactionPoint = point;
    context.interaction.exitCommitted = true;
    actor.followWaypoints([{
        id: null,
        position: new THREE.Vector3(2.5, 0, 0)
    }]);

    assert.equal(harness.system.abandonReplaceableRoute(context), false);
    assert.equal(context.interaction.active.point, point);
    assert.equal(point.occupants.has(actor), true);
    assert.equal(actor.navigation.hasPath(), true);
    harness.dispose();

});

test("orphaned WAITING returns to IDLE while owned WAITING remains valid", () => {

    const harness = createHarness();
    const orphan = harness.addActor("Orphan", "a", {
        intentPolicy: "replaceable"
    });

    orphan.setState(EntityState.WAITING);
    harness.update(20, 0.03);
    assert.equal(orphan.isState(EntityState.IDLE), true);

    const owned = harness.addActor("Owned", "c");
    const context = harness.system.requireContext(owned);
    context.intent.position = harness.graph.requireNode("a").position.clone();
    owned.setState(EntityState.WAITING);
    harness.update(1, 0.03);
    assert.equal(owned.isState(EntityState.WAITING), true);
    assertNavigationInvariants(harness);
    harness.dispose();

});

test("seeded navigation soak keeps ownership valid through traffic and topology changes", () => {

    const harness = createHarness(createRingGraph());
    const actors = Array.from({ length: 6 }, (_, index) =>
        harness.addActor(`Soak ${index}`, `ring-${index * 2}`, {
            intentPolicy: index === 0 ? "persistent" : "replaceable",
            priority: index === 0 ? 10 : 0
        })
    );
    const startingPositions = actors.map(actor =>
        actor.object3D.position.clone()
    );
    const originalLog = console.log;
    const originalWarn = console.warn;

    console.log = () => { };
    console.warn = () => { };

    try {

        for (let frame = 0; frame < 900; frame++) {

            if (frame % 120 === 0) {

                const epoch = frame / 120;

                actors.forEach((actor, index) => {

                    const targetIndex = (
                        index * 2 + 5 + epoch * 3
                    ) % 16;
                    harness.system.moveTo(
                        actor,
                        harness.graph.requireNode(`ring-${targetIndex}`).position
                    );

                });

            }

            if (frame === 300 || frame === 450) {

                harness.graph.setConnectionBlocked(
                    "ring-0",
                    "ring-1",
                    frame === 300
                );
                harness.system.topologyChanged();

            }

            harness.update();

        }

    } finally {

        console.log = originalLog;
        console.warn = originalWarn;

    }

    const snapshot = harness.system.getMetricsSnapshot();
    const movedActors = actors.filter((actor, index) =>
        actor.object3D.position.distanceToSquared(startingPositions[index]) > 1
    );

    assert.ok(movedActors.length >= 3, "the soak test must exercise movement");
    assert.ok(
        snapshot.routesCalculated < 1500,
        "route recovery entered a replan storm"
    );
    assertNavigationInvariants(harness);
    harness.dispose();

});

test(
    "action exit reserves approach and graph admission atomically",
    () => {

        const harness =
            createHarness();

        const actor =
            harness.addActor(
                "Atomic exit",
                "a"
            );

        const approach =
            new InteractionPoint(
                "atomic:approach",
                {
                    position:
                        new THREE.Vector3(
                            1,
                            0,
                            1
                        ),

                    connectTo:
                        "a",

                    terminal:
                        false
                }
            );

        const action =
            new InteractionPoint(
                "atomic:action",
                {
                    position:
                        new THREE.Vector3(
                            1,
                            0,
                            2
                        ),

                    via:
                        approach
                }
            );

        harness.connector.register(
            approach
        );

        harness.connector.register(
            action
        );

        const context =
            harness.system
                .requireContext(
                    actor
                );

        harness.system
            .trafficState
            .releaseNode(
                "a",
                actor
            );

        actor.navigation
            .setCurrentNode(
                null
            );

        actor.object3D.position
            .copy(
                action
                    .getWorldPosition()
            );

        harness.system
            .interactionTraffic
            .occupyPoint(
                action,
                actor
            );

        context.traversal
            .interactionPoint =
            action;

        context.interaction.active = {
            point:
                action,

            target:
                null
        };

        /*
         * Bloqueia o nó para forçar falha
         * no preflight.
         */
        const blocker =
            harness.addActor(
                "Node blocker",
                "a"
            );

        harness.system
            .interactionTraversal
            .beginInteractionExit(
                context,
                {
                    originId:
                        "a",

                    nextNodeId:
                        null
                }
            );

        const actionState =
            harness.system
                .interactionTraffic
                .getPointState(
                    action
                );

        const approachState =
            harness.system
                .interactionTraffic
                .getPointState(
                    approach
                );

        assert.equal(
            actionState.occupants.has(
                actor
            ),
            true
        );

        assert.equal(
            approachState
                .reservations
                .has(actor),
            false
        );

        assert.equal(
            approachState
                .occupants
                .has(actor),
            false
        );

        harness.dispose();

    }
);
