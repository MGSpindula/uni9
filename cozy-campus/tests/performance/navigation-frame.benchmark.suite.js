import { performance } from "node:perf_hooks";
import * as THREE from "three";

import { Character } from "../../src/characters/Character";
import { CharacterNavigationSystem } from "../../src/navigation/CharacterNavigationSystem";
import { NavigationConnector } from "../../src/navigation/NavigationConnector";
import { NavigationGraph } from "../../src/navigation/NavigationGraph";

const STEP = 1 / 30;
const output = console.log.bind(console);
const outputWarning = console.warn.bind(console);

function createGrid(side, spacing = 3) {

    const graph = new NavigationGraph({ selectionRadius: 2 });

    for (let z = 0; z < side; z++) {
        for (let x = 0; x < side; x++) {
            graph.addNode(
                `${x}:${z}`,
                new THREE.Vector3(x * spacing, 0, z * spacing)
            );
        }
    }

    for (let z = 0; z < side; z++) {
        for (let x = 0; x < side; x++) {
            if (x + 1 < side) graph.connect(`${x}:${z}`, `${x + 1}:${z}`);
            if (z + 1 < side) graph.connect(`${x}:${z}`, `${x}:${z + 1}`);
        }
    }

    return graph;

}

function runFrame(system, actors) {

    system.updatePlanning(STEP);
    system.updateTraffic(STEP);
    for (const actor of actors) actor.authorizeMovementTraffic();
    for (const actor of actors) actor.prepareMovement();
    system.prepareCollisionFrame(actors);
    system.resolveCharacterOverlaps(actors, STEP);
    for (const actor of actors) actor.evaluateMovementGuard(STEP);
    for (const actor of actors) actor.updateMovement(STEP);
    system.resolveResidualCharacterOverlaps(actors, STEP);
    system.solvePhysics(STEP);
    for (const actor of actors) actor.updateGrounding();
    for (const actor of actors) actor.updateAnimation(STEP);

}

for (const actorCount of [4, 25, 50, 100]) {

    const side = Math.max(8, Math.ceil(Math.sqrt(actorCount * 4)));
    const graph = createGrid(side);
    const connector = new NavigationConnector(graph);
    const system = new CharacterNavigationSystem({
        graph,
        connector,
        helper: null
    });
    const actors = [];

    for (let index = 0; index < actorCount; index++) {

        const actor = new Character(`Benchmark ${index}`);
        const x = (index * 2) % side;
        const z = Math.floor(index * 2 / side) % side;
        system.registerActor(actor, { spawnId: `${x}:${z}` });
        actors.push(actor);

    }

    const issueRoutes = epoch => {
        actors.forEach((actor, index) => {
            const x = (index * 2 + side / 2 + epoch) % side | 0;
            const z = (Math.floor(index * 2 / side) + side / 2 + epoch) % side | 0;
            system.moveTo(actor, graph.requireNode(`${x}:${z}`).position);
        });
    };

    console.log = () => {};
    console.warn = () => {};
    issueRoutes(0);
    for (let frame = 0; frame < 30; frame++) runFrame(system, actors);

    const frames = 180;
    const started = performance.now();

    for (let frame = 0; frame < frames; frame++) {
        if (frame % 60 === 0) issueRoutes(frame / 60 + 1);
        runFrame(system, actors);
    }

    const milliseconds = performance.now() - started;
    const metrics = system.getMetricsSnapshot();

    const result = {
        actors: actorCount,
        frames,
        milliseconds: Number(milliseconds.toFixed(2)),
        millisecondsPerFrame: Number((milliseconds / frames).toFixed(4)),
        routesCalculated: metrics.routesCalculated,
        routeRecoveries: metrics.routeRecoveries,
        routeGeometryBuilds: metrics.routeGeometryBuilds,
        routeGeometryMilliseconds: Number(
            metrics.routeGeometryMilliseconds.toFixed(2)
        ),
        routeSegmentsCreated: metrics.routeSegmentsCreated,
        trafficTimeouts: metrics.trafficTimeouts,
        waitingActors: metrics.waitingActors,
        physicsCorrections: metrics.physicsCorrections,
        physicsMaximumCorrection: Number(
            metrics.physicsMaximumCorrection.toFixed(4)
        )
    };

    for (const actor of actors) system.unregisterActor(actor);
    system.dispose();
    console.log = output;
    console.warn = outputWarning;
    output(JSON.stringify(result));

}
