import assert from "node:assert/strict";
import { test } from "node:test";
import * as THREE from "three";

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
            update() {},
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
            update() {},
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
            prepareCollisionFrame: () => {},
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
        requestRender() {}
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

test("PhysicsWorld keeps manual character separation disabled", () => {

    const harness = createHarness();

    assert.equal(
        harness.system.physics.manualContactSeparation,
        false
    );
    harness.dispose();

});

test("registered actors own structured NavigationAgent state", () => {

    const harness = createHarness();
    const actor = harness.addActor("Agent", "a");
    const agent = harness.system.requireContext(actor);
    const target = new THREE.Vector3(8, 0, 0);

    assert.ok(agent instanceof NavigationAgent);

    // Legacy aliases and the structured domains reference one value, never
    // two competing context states.
    agent.pendingPosition = target;
    assert.equal(agent.intent.position, target);
    agent.interactionExitCommitted = true;
    assert.equal(agent.interaction.exitCommitted, true);
    assert.equal(agent.syncPhase(), NavigationPhase.LEAVING_INTERACTION);

    agent.interactionExitCommitted = false;
    agent.pendingPosition = null;
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
    assert.equal(waypoint.authorizedLaneIndex, 1);
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
    agent.interactionPoint = approach;
    agent.activeInteraction = { point: approach, target: null };

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

test("NavigationGraphHelper removes current and legacy route lines", () => {

    const names = [
        "Actor:NavigationSegments",
        "Actor:NavigationSegmentsDirection",
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
        addActiveLaneCurves() {}
    };

    NavigationGraphHelper.prototype.refreshActiveLaneCurves.call(helper);

    assert.deepEqual(removed, names.slice(0, 4));
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

    return context.activeInteraction?.point ??
        context.interactionPoint ??
        null;

}

function assertNavigationInvariants({ graph, connector, system }) {

    for (const node of graph.nodes.values()) {

        const nodeState = system.trafficState.getNodeState(node.id);
        const activeOccupants = [...nodeState.occupants].filter(actor =>
            !nodeState.restingAgents.has(actor)
        );

        assert.ok(
            activeOccupants.length <= 1,
            `node ${node.id} has multiple non-resting occupants`
        );

    }

    for (const connection of getAllConnections(graph)) {

        const connectionState = system.trafficState.getConnectionState(
            connection.fromId,
            connection.toId
        );

        for (const lane of connectionState.lanes) {

            // A lane is a capacity-one physical resource. Reservations may
            // wait elsewhere, but two bodies must never occupy it together.
            assert.ok(
                lane.occupants.size <= 1,
                `lane ${connection.fromId}/${connection.toId}:${lane.index} ` +
                "has incompatible occupants"
            );

            for (const actor of lane.occupants) {

                assert.ok(
                    lane.directions.has(actor),
                    `${actor.name} occupies a lane without a direction`
                );

            }

        }

    }

    for (const [actor, context] of system.contexts) {

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
            context.pendingPosition ||
            context.pendingInteraction ||
            context.deferredCommand ||
            context.activeInteraction ||
            context.turningAround ||
            context.preparingInteraction ||
            context.preparingInteractionExit ||
            context.interactionExitCommitted ||
            context.blockedElapsed !== null ||
            context.recoveryPending ||
            context.orphanedElapsed > 0 ||
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
                system.contexts.has(actor),
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
            nodeState.restingAgents
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
            contexts: new Map(),
            trafficState,
            traffic: {},
            collisionFailsafe: {}
        }
    });

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

test("three actors leave a congested node in stable queue order", () => {

    const harness = createHarness();
    const first = harness.addActor("First", "b", { priority: 2 });
    const second = harness.addActor("Second", "b", { priority: 1 });
    const third = harness.addActor("Third", "b");
    const queue = harness.system.traffic.departures;

    // Only one actor occupies the active center. The others represent actors
    // waiting in authored resting spots of that same logical node.
    harness.system.trafficState.setNodeAgentResting("b", second, true);
    harness.system.trafficState.setNodeAgentResting("b", third, true);
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

test("interaction exit waits while another actor owns its access lane", () => {

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
    context.interactionPoint = approach;
    context.activeInteraction = { point: approach, target: null };
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
        false
    );
    assert.equal(approach.occupants.has(leaving), true);
    assert.equal(context.activeInteraction.point, approach);
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
    context.pendingInteraction = { point: blocked, onArrive: null };
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
        timeoutCount: 2
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
    assert.ok(context.pendingPosition.equals(target));
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
    harness.connector.reservePoint(point, actor);
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
    harness.connector.reservePoint(point, actor);
    harness.system.traffic.departures.enqueue("a", actor);
    harness.system.traffic.arrivals.enqueue("b", actor);
    harness.system.traffic.setWaitReason(actor, "a", WaitReason.QUEUE_HEAD);

    harness.system.unregisterActor(actor);

    assert.equal(harness.system.contexts.has(actor), false);
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
    context.pendingPosition = target.clone();

    assert.equal(
        harness.system.restartIntentFromNearestAccess(context),
        true
    );
    assert.ok(actor.navigation.hasPath());
    assert.ok(context.pendingPosition.equals(target));
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
    context.activeInteraction = { point, target: null };
    context.interactionPoint = point;
    context.interactionExitCommitted = true;
    actor.followWaypoints([{
        id: null,
        position: new THREE.Vector3(2.5, 0, 0)
    }]);

    assert.equal(harness.system.abandonReplaceableRoute(context), false);
    assert.equal(context.activeInteraction.point, point);
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
    context.pendingPosition = harness.graph.requireNode("a").position.clone();
    owned.setState(EntityState.WAITING);
    harness.update(1, 0.03);
    assert.equal(owned.isState(EntityState.WAITING), true);
    assertNavigationInvariants(harness);
    harness.dispose();

});
