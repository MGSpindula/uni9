import * as THREE from "three";

import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { PostProcessing } from "./postprocessing/PostProcessing";
import { OutlineEffect } from "./postprocessing/OutlineEffect";

import { EntityRegistry } from "./core/EntityRegistry";
import { SelectionManager } from "./core/SelectionManager";
import { InteractionSystem } from "./core/InteractionSystem";

import { Floor } from "./objects/Floor";
import { Cube } from "./objects/Cube";
import { Sphere } from "./objects/Sphere";
import { Cylinder } from "./objects/Cylinder";
import { Chair } from "./objects/Chair";
import { Player } from "./characters/Player";
import { PlayerController } from "./characters/PlayerController";
import { NPC } from "./characters/NPC";
import { NPCController } from "./characters/NPCController";
import { CharacterGrounding } from "./characters/CharacterGrounding";
import { NavigationGraph } from "./navigation/NavigationGraph";
import { NavigationGraphHelper } from "./navigation/NavigationGraphHelper";
import { NavigationConnector } from "./navigation/NavigationConnector";
import { CharacterNavigationSystem } from "./navigation/CharacterNavigationSystem";
<<<<<<< HEAD
import { DwellSpotRegistry } from "./navigation/DwellSpotRegistry";
import { CharacterDebugPanel } from "./debug/CharacterDebugPanel";
import { PerformanceDebugPanel } from "./debug/PerformanceDebugPanel";
import {
    configureCozyCampusDwellSpots,
    configureCozyCampusNavigation
} from "./levels/CozyCampusNavigation";
=======
import { NavigationDebugPanel } from "./debug/NavigationDebugPanel";
import { PhysicsWorld } from "./physics/PhysicsWorld";
import { SlopeDetector } from "./navigation/SlopeDetector";
>>>>>>> b09e5f4 (Save uncommitted changes)

export class Scene {

    constructor(renderer) {

        // Renderer wrapper and Three.js scene graph.
        this.renderer = renderer;

        this.scene = new THREE.Scene();

        this.scene.background = new THREE.Color(0x87ceeb);

        this.camera = new THREE.PerspectiveCamera(
            60,
            window.innerWidth / window.innerHeight,
            0.1,
            100
        );

        this.camera.position.set(0, 6, 12);

        this.controls = new OrbitControls(
            this.camera,
            this.renderer.renderer.domElement
        );

        this.controls.enableDamping = true;

        this.controls.target.set(0, 0, 0);

        // Entities updated by this scene every frame.
        this.objects = [];
        this.controllers = [];

        this.registry = new EntityRegistry();
        this.interactionSystem = new InteractionSystem();

        this.selection = new SelectionManager(
            this.camera,
            this.scene,
            this.registry,
            this.renderer.renderer.domElement
        );

        // Scene content must exist before input can raycast it.
        this.createLights();

        this.physicsWorld = new PhysicsWorld();
        this.slopeDetector = new SlopeDetector();

        this.createNavigation();

        this.createObjects();

        if (import.meta.env.DEV) {

            this.createCharacterDebugPanel();
            this.performanceDebugPanel = new PerformanceDebugPanel();
            // EffectComposer renders several passes. Disabling the automatic
            // reset lets the performance panel report their combined cost.
            this.renderer.renderer.info.autoReset = false;

        }

        this.playerController = new PlayerController({
            player: this.player,
            selection: this.selection,
            interactionSystem: this.interactionSystem,
            element: this.renderer.renderer.domElement
        });

        // Render systems are created after the scene and camera are ready.
        this.postProcessing =
            new PostProcessing(

                this.renderer.renderer,
                this.scene,
                this.camera

            );

        this.outlineEffect =
            new OutlineEffect(

                this.scene,
                this.camera

            );

        this.postProcessing.addEffect(
            this.outlineEffect
        );

        this.selection.addEffect(
            this.outlineEffect
        );

        window.addEventListener(
            "resize",
            () => {

                this.camera.aspect =
                    window.innerWidth /
                    window.innerHeight;

                this.camera.updateProjectionMatrix();

                this.postProcessing.resize(

                    window.innerWidth,
                    window.innerHeight

                );

            }
        );

    }

    // -----------------------------
    // Scene setup
    // -----------------------------

    createLights() {

        const ambient = new THREE.AmbientLight(
            0xffffff,
            1
        );

        this.scene.add(ambient);

        const sun = new THREE.DirectionalLight(
            0xffffff,
            2
        );

        sun.castShadow = true;

        sun.position.set(10, 20, 10);

        sun.shadow.camera.left = -13;
        sun.shadow.camera.right = 13;
        sun.shadow.camera.top = 13;
        sun.shadow.camera.bottom = -13;

        sun.shadow.camera.near = 0.5;
        sun.shadow.camera.far = 50;

        sun.shadow.camera.updateProjectionMatrix();

        sun.shadow.mapSize.set(1024, 1024);
        sun.shadow.bias = -0.0001;

        this.scene.add(sun);

        /* const helper = new THREE.CameraHelper(sun.shadow.camera);
        this.scene.add(helper); */
    }

    createObjects() {

        this.floor = new Floor();
        this.characterGrounding = new CharacterGrounding(
            this.floor.walkableSurfaces
        );
        this.characterNavigation.setGrounding(this.characterGrounding);
        this.characterGrounding.validateGraph(this.navigationGraph);
        this.player = new Player();
        
        this.registerNavigationTerrain(this.floor.object3D);

        this.registerCharacter(this.player, {
            spawnId: "spawn"
        });

        // Scene connects the floor interaction to the player command.
        this.floor.setDestinationHandler(position => {

            this.characterNavigation.moveToClosestNode(
                this.player,
                position
            );

        });

        this.add(this.floor);

        this.add(this.player);

        this.add(new Cube());

        this.add(new Sphere());

        this.add(new Cylinder());

        this.chair = new Chair();
        this.add(this.chair);
        this.registerNavigationInteractions(this.chair);

        // Crowd test: every NPC uses the same CharacterNavigationSystem and
        // NPCController. Names/colors exist only to make collision and queue
        // logs easy to follow while all three compete for lanes and the chair.
        const npcConfigurations = [
            {
                name: "Orange NPC",
                color: 0xff8a2a,
                spawnId: "east-exit"
            }, {
                name: "Green NPC",
                color: 0x58b86b,
                spawnId: "west-2"
            }, {
                name: "Purple NPC",
                color: 0x9b6bd3,
                spawnId: "north-1"
            }
        ];

        this.npcs = npcConfigurations.map(configuration => {

            const npc = new NPC(configuration.name, {
                color: configuration.color
            });

            this.add(npc);
            this.registerCharacter(npc, {
                spawnId: configuration.spawnId
            });

            const controller = new NPCController({
                npc,
                chair: this.chair,
                graph: this.navigationGraph,
                navigationSystem: this.characterNavigation,
                interactionSystem: this.interactionSystem
            });

            this.controllers.push(controller);
            return npc;

        });

        // Temporary compatibility aliases for console experiments made while
        // the prototype had a single NPC.
        this.npc = this.npcs[0];
        this.npcController = this.controllers.find(controller =>
            controller.npc === this.npc
        );

    }

    registerNavigationTerrain(root) {

        root.traverse(object => {

            if (!object.isMesh) return;

            this.slopeDetector.addTerrainMesh(object);
            this.physicsWorld.createTerrainBodyFromMesh(object);

        });

    }

    createNavigation() {

        this.navigationGraph = new NavigationGraph({
            // A floor click selects a node only inside this visible radius.
            selectionRadius: 1.25
        });
        configureCozyCampusNavigation(this.navigationGraph);
        this.dwellSpots = new DwellSpotRegistry(this.navigationGraph);
        configureCozyCampusDwellSpots(
            this.dwellSpots,
            this.navigationGraph
        );

        if (!this.navigationGraph.isValid()) {

            console.log(
                "[Navigation] Invalid graph elements were ignored. Continuing with the valid subset.",
                this.navigationGraph.validationErrors
            );

        }

        this.navigationConnector = new NavigationConnector(
            this.navigationGraph
        );
        this.navigationHelper = new NavigationGraphHelper(this.navigationGraph, {
            connector: this.navigationConnector,
            dwellSpots: this.dwellSpots
        });
        this.characterNavigation = new CharacterNavigationSystem({
            graph: this.navigationGraph,
            connector: this.navigationConnector,
<<<<<<< HEAD
            dwellSpots: this.dwellSpots
=======
            helper: this.navigationHelper,
            slopeDetector: this.slopeDetector,
            physicsWorld: this.physicsWorld,
            onChanged: () => this.refreshNavigationDebugPanel()
>>>>>>> b09e5f4 (Save uncommitted changes)
        });
        this.scene.add(this.navigationHelper);
        this.navigationHelper.highlightNode("spawn");

    }

    // -----------------------------
    // Navigation
    // -----------------------------

    registerCharacter(character, { spawnId = null } = {}) {

        // Player and NPCs use this same registration. Example:
        // this.registerCharacter(librarian, { spawnId: "library-entry" });
        // Their controllers differ, but navigation and interaction do not.
<<<<<<< HEAD
        character.setGrounding(this.characterGrounding);
        this.characterNavigation.registerActor(character, { spawnId });
=======
        
        // Create physics body for character
        const context = this.characterNavigation.registerActor(character, { spawnId });
        context.physicsBody = this.physicsWorld.createActorBody(character);
        character.locomotion.setPhysicsBody(context.physicsBody, {
            walkingHeight: context.physicsBody.characterRadius ?? 0
        });
        character.locomotion.setSlopeDetector(this.slopeDetector);
        
>>>>>>> b09e5f4 (Save uncommitted changes)
        this.interactionSystem.registerActor(character, request =>
            this.characterNavigation.moveToInteractionPoint(
                character,
                request.point,
                request.onArrive
            )
        );

    }

    registerNavigationInteractions(entity) {

        if (entity.interactionPoints.length === 0) return;

        for (const point of entity.interactionPoints) {

            this.navigationConnector.register(point);

        }

        if (this.navigationHelper?.isVisible) {

            this.navigationHelper.refresh();

        }

    }

    createCharacterDebugPanel() {

        this.characterDebugPanel = new CharacterDebugPanel({
            getRows: () => [this.player, ...(this.npcs ?? [])].map(actor => {

                const navigation = this.characterNavigation
                    .getActorDebugState(actor);
                const controller = this.controllers.find(candidate =>
                    candidate.npc === actor
                );

                return {
                    ...navigation,
                    behavior: controller?.state ?? "player input"
                };

            })
        });

    }

    setNavigationNodeBlocked(id, blocked = true) {

        this.navigationGraph.setNodeBlocked(id, blocked);
        this.onNavigationTopologyChanged();

    }

    setNavigationConnectionBlocked(fromId, toId, blocked = true) {

        this.navigationGraph.setConnectionBlocked(fromId, toId, blocked);
        this.onNavigationTopologyChanged();

    }

    disconnectNavigationNodes(fromId, toId) {

        this.navigationGraph.disconnect(fromId, toId);
        this.onNavigationTopologyChanged();

    }

    onNavigationTopologyChanged() {

        if (this.navigationHelper?.isVisible) {

            this.navigationHelper.refresh();

        }
<<<<<<< HEAD

=======
        this.refreshNavigationDebugPanel();
>>>>>>> b09e5f4 (Save uncommitted changes)
        this.characterNavigation?.topologyChanged();

    }

    setNavigationHelperVisible(visible) {

        this.navigationHelper?.setVisible(visible);

    }

    toggleNavigationHelper() {

        this.navigationHelper?.toggleVisible();

    }

    // -----------------------------
    // Entity management
    // -----------------------------

    add(object) {

        this.objects.push(object);

        this.scene.add(object.object3D);

        object.register(this.registry);

    }

    // -----------------------------
    // Lifecycle
    // -----------------------------

    update(delta) {

        for (const object of this.objects) {

            if (object.isActive()) {

                object.update(delta);

            }

        }

        for (const controller of this.controllers) {

            controller.update(delta);

        }

        this.controls.update();

        // Step physics engine (must happen before character navigation)
        this.physicsWorld.step(delta);
        this.physicsWorld.syncActorPositions();

        this.characterNavigation.update(delta);

    }

    occupyNavigationNode(id, occupant) {

        const occupied = this.navigationGraph.occupyNode(id, occupant);

<<<<<<< HEAD
=======
        if (this.navigationHelper?.isVisible) {

            this.navigationHelper.refresh();

        }
        this.refreshNavigationDebugPanel();

>>>>>>> b09e5f4 (Save uncommitted changes)
        return occupied;

    }

    releaseNavigationNode(id, occupant) {

        this.navigationGraph.releaseNode(id, occupant);
<<<<<<< HEAD
=======
        if (this.navigationHelper?.isVisible) {

            this.navigationHelper.refresh();

        }
        this.refreshNavigationDebugPanel();
>>>>>>> b09e5f4 (Save uncommitted changes)

    }

    occupyNavigationConnection(fromId, toId, occupant) {

        const occupied = this.navigationGraph.occupyConnection(
            fromId,
            toId,
            occupant
        );

<<<<<<< HEAD
=======
        if (this.navigationHelper?.isVisible) {

            this.navigationHelper.refresh();

        }
        this.refreshNavigationDebugPanel();

>>>>>>> b09e5f4 (Save uncommitted changes)
        return occupied;

    }

    releaseNavigationConnection(fromId, toId, occupant) {

        this.navigationGraph.releaseConnection(fromId, toId, occupant);
<<<<<<< HEAD
=======
        if (this.navigationHelper?.isVisible) {

            this.navigationHelper.refresh();

        }
        this.refreshNavigationDebugPanel();
>>>>>>> b09e5f4 (Save uncommitted changes)

    }

    occupyNavigationInteractionPoint(id, occupant) {

        const point = this.navigationConnector.points.get(id);
        const occupied = point
            ? this.navigationConnector.occupyPoint(point, occupant)
            : false;

<<<<<<< HEAD
=======
        if (this.navigationHelper?.isVisible) {

            this.navigationHelper.refresh();

        }
        this.refreshNavigationDebugPanel();

>>>>>>> b09e5f4 (Save uncommitted changes)
        return occupied;

    }

    releaseNavigationInteractionPoint(id, occupant) {

        const point = this.navigationConnector.points.get(id);

        if (point) this.navigationConnector.releasePoint(point, occupant);

<<<<<<< HEAD
=======
        if (this.navigationHelper?.isVisible) {

            this.navigationHelper.refresh();

        }
        this.refreshNavigationDebugPanel();
>>>>>>> b09e5f4 (Save uncommitted changes)

    }

    start() {

        let previous = performance.now();

        const loop = (now) => {

            const delta =
                (now - previous) / 1000;

            previous = now;

            const updateStarted = performance.now();
            this.update(delta);
            const updateFinished = performance.now();

            if (this.performanceDebugPanel) {

                this.renderer.renderer.info.reset();

            }

            this.renderer.render(

                this.postProcessing,

                delta

            );

            const renderFinished = performance.now();

            this.performanceDebugPanel?.record({
                now: renderFinished,
                frame: renderFinished - now,
                update: updateFinished - updateStarted,
                render: renderFinished - updateFinished,
                renderer: this.renderer.renderer
            });

            requestAnimationFrame(loop);

        };

        requestAnimationFrame(loop);

    }

}
