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
import { NavigationGraph } from "./navigation/NavigationGraph";
import { NavigationGraphHelper } from "./navigation/NavigationGraphHelper";
import { NavigationConnector } from "./navigation/NavigationConnector";
import { CharacterNavigationSystem } from "./navigation/CharacterNavigationSystem";
import { NavigationDebugPanel } from "./debug/NavigationDebugPanel";

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

        this.createNavigation();

        this.createObjects();

        if (import.meta.env.DEV) {

            this.createNavigationDebugPanel();

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

        sun.shadow.mapSize.set(2048, 2048);
        sun.shadow.bias = -0.0001;

        this.scene.add(sun);

        /* const helper = new THREE.CameraHelper(sun.shadow.camera);
        this.scene.add(helper); */
    }

    createObjects() {

        this.floor = new Floor();
        this.player = new Player();

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

        this.npc = new NPC("Orange NPC");
        this.add(this.npc);
        this.registerCharacter(this.npc, {
            spawnId: "east-exit"
        });

        this.npcController = new NPCController({
            npc: this.npc,
            chair: this.chair,
            graph: this.navigationGraph,
            navigationSystem: this.characterNavigation,
            interactionSystem: this.interactionSystem
        });
        this.controllers.push(this.npcController);

    }

    createNavigation() {

        this.navigationGraph = new NavigationGraph({
            // A floor click selects a node only inside this visible radius.
            selectionRadius: 1.25
        });

        // Edit these positions to reshape the manual path. Circulation nodes
        // are passable while occupied. Use { exclusive: true } only for a node
        // that physically cannot be crossed by two actors.
        // Example: ["narrow-door", position, { exclusive: true }]
        const nodes = [
            ["spawn", new THREE.Vector3(0, 0, -5)],
            ["north-1", new THREE.Vector3(-2, 0, -2)],
            ["north-2", new THREE.Vector3(2, 0, -2)],
            ["junction", new THREE.Vector3(0, 0, 0)],
            ["west-exit", new THREE.Vector3(-7, 0, 6)],
            ["west-1", new THREE.Vector3(-1, 0, 5)],
            ["west-2", new THREE.Vector3(-4, 0, 8)],
            ["west-3", new THREE.Vector3(-7, 0, 1)],
            ["east-exit", new THREE.Vector3(5, 0, 4)]
        ];

        for (const [id, position, metadata = {}] of nodes) {

            this.navigationGraph.addNode(id, position, metadata);

        }

        // Circulation edges default to two lanes. Character roots remain on the
        // graph centerline; their visuals receive the reserved lane offset.
        const connect = (fromId, toId, options = {}) =>
            this.navigationGraph.connect(fromId, toId, {
                lanes: 2,
                // Current characters have radius 0.45 plus personal space.
                laneWidth: 1,
                capacityPerLane: 1,
                passingAllowed: true,
                ...options
            });

        connect("spawn", "north-1");
        connect("spawn", "north-2");

        // A narrow/indivisible connection: actors cannot pass side by side.
        connect("spawn", "junction", {
            lanes: 1,
            laneWidth: 0,
            passingAllowed: false
        });

        connect("north-1", "junction");
        connect("north-1", "west-exit");
        connect("north-1", "west-3");
        connect("north-2", "junction");
        connect("junction", "west-1");
        connect("west-1", "west-exit");
        connect("west-1", "west-2");
        connect("west-1", "west-3");
        connect("west-2", "west-exit");
        connect("west-3", "west-exit");
        connect("junction", "west-exit");
        connect("junction", "east-exit");

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
            connector: this.navigationConnector
        });
        this.characterNavigation = new CharacterNavigationSystem({
            graph: this.navigationGraph,
            connector: this.navigationConnector,
            helper: this.navigationHelper,
            onChanged: () => this.refreshNavigationDebugPanel()
        });
        this.scene.add(this.navigationHelper);
        this.navigationHelper.highlightNode("spawn");

        this.setNavigationConnectionBlocked(
            "spawn",
            "junction",
            true
        );

    }

    // -----------------------------
    // Navigation
    // -----------------------------

    registerCharacter(character, { spawnId = null } = {}) {

        // Player and NPCs use this same registration. Example:
        // this.registerCharacter(librarian, { spawnId: "library-entry" });
        // Their controllers differ, but navigation and interaction do not.
        this.characterNavigation.registerActor(character, { spawnId });
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

        this.navigationHelper.refresh();

    }

    createNavigationDebugPanel() {

        this.navigationDebugPanel = new NavigationDebugPanel({
            graph: this.navigationGraph,
            connector: this.navigationConnector,
            setNodeBlocked: (id, blocked) =>
                this.setNavigationNodeBlocked(id, blocked),
            setConnectionBlocked: (fromId, toId, blocked) =>
                this.setNavigationConnectionBlocked(fromId, toId, blocked),
            occupyNode: (id, occupant) =>
                this.occupyNavigationNode(id, occupant),
            releaseNode: (id, occupant) =>
                this.releaseNavigationNode(id, occupant),
            occupyConnection: (fromId, toId, occupant) =>
                this.occupyNavigationConnection(fromId, toId, occupant),
            releaseConnection: (fromId, toId, occupant) =>
                this.releaseNavigationConnection(fromId, toId, occupant),
            occupyInteractionPoint: (id, occupant) =>
                this.occupyNavigationInteractionPoint(id, occupant),
            releaseInteractionPoint: (id, occupant) =>
                this.releaseNavigationInteractionPoint(id, occupant)
        });

    }

    refreshNavigationDebugPanel() {

        this.navigationDebugPanel?.render();

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

        this.navigationHelper?.refresh();
        this.refreshNavigationDebugPanel();
        this.characterNavigation?.topologyChanged();

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

        this.characterNavigation.update(delta);

    }

    occupyNavigationNode(id, occupant) {

        const occupied = this.navigationGraph.occupyNode(id, occupant);

        this.navigationHelper.refresh();
        this.refreshNavigationDebugPanel();

        return occupied;

    }

    releaseNavigationNode(id, occupant) {

        this.navigationGraph.releaseNode(id, occupant);
        this.navigationHelper.refresh();
        this.refreshNavigationDebugPanel();

    }

    occupyNavigationConnection(fromId, toId, occupant) {

        const occupied = this.navigationGraph.occupyConnection(
            fromId,
            toId,
            occupant
        );

        this.navigationHelper.refresh();
        this.refreshNavigationDebugPanel();

        return occupied;

    }

    releaseNavigationConnection(fromId, toId, occupant) {

        this.navigationGraph.releaseConnection(fromId, toId, occupant);
        this.navigationHelper.refresh();
        this.refreshNavigationDebugPanel();

    }

    occupyNavigationInteractionPoint(id, occupant) {

        const point = this.navigationConnector.points.get(id);
        const occupied = point
            ? this.navigationConnector.occupyPoint(point, occupant)
            : false;

        this.navigationHelper.refresh();
        this.refreshNavigationDebugPanel();

        return occupied;

    }

    releaseNavigationInteractionPoint(id, occupant) {

        const point = this.navigationConnector.points.get(id);

        if (point) this.navigationConnector.releasePoint(point, occupant);

        this.navigationHelper.refresh();
        this.refreshNavigationDebugPanel();

    }

    start() {

        let previous = performance.now();

        const loop = (now) => {

            const delta =
                (now - previous) / 1000;

            previous = now;

            this.update(delta);

            this.renderer.render(

                this.postProcessing,

                delta

            );

            requestAnimationFrame(loop);

        };

        requestAnimationFrame(loop);

    }

}


