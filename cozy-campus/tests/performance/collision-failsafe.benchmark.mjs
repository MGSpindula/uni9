import { performance } from "node:perf_hooks";
import * as THREE from "three";

import { CharacterCollisionFailsafe } from "../../src/navigation/CharacterCollisionFailsafe.js";

const print = console.log.bind(console);
console.log = () => {};

function createActor(index, columns = 10) {

    const position = new THREE.Vector3(
        (index % columns) * 1.25,
        0,
        Math.floor(index / columns) * 1.25
    );

    return {
        name: `Benchmark ${index}`,
        object3D: { position },
        collisionRadius: 0.36,
        collisionHeight: 1.2,
        navigationPriority: 0,
        locomotion: { speed: 2 },
        isActive: () => true,
        navigation: {
            isPaused: () => false,
            getTraversalState: () => ({
                currentNodeId: null,
                currentConnection: null
            }),
            getCurrentWaypoint: () => ({
                position: position.clone().add(new THREE.Vector3(1, 0, 0))
            })
        }
    };

}

for (const actorCount of [4, 25, 50, 100]) {

    const actors = Array.from(
        { length: actorCount },
        (_, index) => createActor(index)
    );
    const owner = {
        agents: new Map(actors.map(actor => [actor, {}])),
        traffic: null
    };
    const failsafe = new CharacterCollisionFailsafe(owner);
    const iterations = 100;

    for (let warmup = 0; warmup < 10; warmup++) {
        failsafe.beginFrame(actors);
        for (const actor of actors) {
            failsafe.canMove(actor, actor.navigation.getCurrentWaypoint().position);
        }
    }

    const started = performance.now();

    for (let iteration = 0; iteration < iterations; iteration++) {
        failsafe.beginFrame(actors);
        for (const actor of actors) {
            failsafe.canMove(actor, actor.navigation.getCurrentWaypoint().position);
        }
    }

    const elapsed = performance.now() - started;

    print(JSON.stringify({
        actors: actorCount,
        frames: iterations,
        milliseconds: Number(elapsed.toFixed(2)),
        millisecondsPerFrame: Number((elapsed / iterations).toFixed(4)),
        candidateChecksPerFrame: failsafe.metrics.candidateChecks
    }));

}
