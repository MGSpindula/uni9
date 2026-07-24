import * as THREE from "three";
import { World } from "../game/World";
import { Floor } from "../objects/Floor";
import { Cube } from "../objects/Cube";
import { Sphere } from "../objects/Sphere";
import { Cylinder } from "../objects/Cylinder";
import { Chair } from "../objects/Chair";
import { Player } from "../characters/Player";
import { NPC } from "../characters/NPC";
import { NPCController } from "../characters/NPCController";
import { UseAvailableInteractionBehavior } from "../characters/behaviors/UseAvailableInteractionBehavior";
import { CharacterGrounding } from "../characters/CharacterGrounding";
import { CozyCampusInteractionPoints } from "./CozyCampusInteractionPoints";
import { configureCozyCampusNavigation, cozyCampusClosedLoops } from "./CozyCampusNavigation";
import { Level } from "./Level";

export class CozyCampusLevel extends Level {
    constructor() { super("cozy-campus"); }
    load(game) {
        const { services, renderPipeline } = game;
        this.world = new World({ scene: renderPipeline.scene, services });
        renderPipeline.scene.background = new THREE.Color(0x87ceeb);
        this.createLights(renderPipeline.scene);
        renderPipeline.scene.add(services.createNavigation(configureCozyCampusNavigation));

        if (!services.navigationGraph.isValid()) {
            console.log(
                "[Navigation] Invalid level graph elements were ignored.",
                services.navigationGraph.validationErrors
            );
        }
        services.navigationHelper.highlightNode("spawn");

        this.floor = this.world.add(new Floor());
        this.grounding = new CharacterGrounding(this.floor.walkableSurfaces);
        services.characterNavigation.setGrounding(this.grounding);
        this.grounding.validateGraph(services.navigationGraph);
        this.player = this.world.add(new Player());
        this.world.registerCharacter(this.player, { spawnId: "spawn", grounding: this.grounding });
        this.world.add(new Cube()); 
        this.world.add(new Sphere()); 
        this.world.add(new Cylinder());
        this.chair = this.world.add(new Chair());
        this.ambientInteractionPoints = this.world.add(new CozyCampusInteractionPoints());
        this.world.registerTarget(this.chair);
        this.world.registerTarget(this.ambientInteractionPoints);

        const configurations = [
            ["Orange NPC", 0xff8a2a, "east-exit", 0.75],
            ["Green NPC", 0x58b86b, "west-3", 0.60],
            ["Purple NPC", 0x9b6bd3, "north-1", 0.45],
            ["Yellow NPC", 0xfafa28, "slope-north-bottom", 0.45],
            ["Pink NPC", 0xfc58f0, "west-exit", 0.45],
            ["Cyan NPC", 0x00ffff, "junction", 0.45]
        ];
        this.npcs = configurations.map(([name, color, spawnId, chance]) => {
            const npc = this.world.add(new NPC(name, { color }));
            this.world.registerCharacter(npc, { spawnId, grounding: this.grounding });
            this.world.controllers.push(new NPCController({
                npc, navigationSystem: services.characterNavigation,
                interactionBehavior: new UseAvailableInteractionBehavior({
                    interactionSystem: services.interactions,
                    tags: ["npc-interaction"]
                }),
                closedLoops: cozyCampusClosedLoops, closedLoopChance: chance
            }));
            return npc;
        });
        return this.world;
    }
    createLights(scene) {
        this.ambient = new THREE.AmbientLight(0xffffff, 1);
        this.sun = new THREE.DirectionalLight(0xffffff, 2);
        this.sun.castShadow = true; this.sun.position.set(10, 20, 10);
        Object.assign(this.sun.shadow.camera, { left: -13, right: 13, top: 13, bottom: -13, near: 0.5, far: 50 });
        this.sun.shadow.camera.updateProjectionMatrix(); 
        this.sun.shadow.mapSize.set(1024, 1024); 
        this.sun.shadow.bias = -0.0001;
        scene.add(this.ambient, this.sun);
    }
    unload(game) {
        this.world?.dispose();
        game.renderPipeline.scene.remove(game.services.navigationHelper, this.ambient, this.sun);
        game.services.disposeNavigation();
    }
}
