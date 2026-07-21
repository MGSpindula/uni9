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
import { UseAvailableInteractionBehavior } from "./characters/behaviors/UseAvailableInteractionBehavior";
import { CharacterGrounding } from "./characters/CharacterGrounding";
import { NavigationGraph } from "./navigation/NavigationGraph";
import { NavigationGraphHelper } from "./navigation/NavigationGraphHelper";
import { NavigationConnector } from "./navigation/NavigationConnector";
import { CharacterNavigationSystem } from "./navigation/CharacterNavigationSystem";
import { CharacterDebugPanel } from "./debug/CharacterDebugPanel";
import { PerformanceDebugPanel } from "./debug/PerformanceDebugPanel";
import {
    configureCozyCampusNavigation,
    cozyCampusClosedLoops
} from "./levels/CozyCampusNavigation";
import {
    CozyCampusInteractionPoints
} from "./levels/CozyCampusInteractionPoints";

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
            this.registry,
            this.renderer.renderer.domElement
        );

        // Scene content must exist before input can raycast it.
        this.createLights();

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

        this.handleResize = () => {

            this.camera.aspect =
                window.innerWidth /
                window.innerHeight;

            this.camera.updateProjectionMatrix();

            this.postProcessing.resize(
                window.innerWidth,
                window.innerHeight
            );

        };

        window.addEventListener(
            "resize",
            this.handleResize
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

    }

    createObjects() {

        this.floor = new Floor();
        this.characterGrounding = new CharacterGrounding(
            this.floor.walkableSurfaces
        );
        this.characterNavigation.setGrounding(this.characterGrounding);
        this.characterGrounding.validateGraph(this.navigationGraph);
        this.player = new Player();

        this.registerCharacter(this.player, {
            spawnId: "spawn"
        });

        this.add(this.floor);

        this.add(this.player);

        this.add(new Cube());

        this.add(new Sphere());

        this.add(new Cylinder());

        this.chair = new Chair();

        this.add(this.chair);

        this.ambientInteractionPoints =
            new CozyCampusInteractionPoints();

        this.add(
            this.ambientInteractionPoints
        );

        this.registerNavigationInteractions(
            this.ambientInteractionPoints
        );

        this.interactionSystem.registerTarget(
            this.ambientInteractionPoints
        );

        this.registerNavigationInteractions(
            this.chair
        );

        this.interactionSystem.registerTarget(
            this.chair
        );

        // Crowd test: every NPC uses the same CharacterNavigationSystem and
        // NPCController. Names/colors exist only to make collision and queue
        // logs easy to follow while all three compete for lanes and the chair.
        const npcConfigurations = [
            {
                name: "Orange NPC",
                color: 0xff8a2a,
                spawnId: "east-exit",
                // Force the first available decision to demonstrate one
                // closed walk. NPCController chooses another activity after
                // completing it, so this cannot repeat forever.
                closedLoopChance: 0.75
            }, {
                name: "Green NPC",
                color: 0x58b86b,
                spawnId: "west-2",
                closedLoopChance: 0.60
            }, {
                name: "Purple NPC",
                color: 0x9b6bd3,
                spawnId: "north-1",
                closedLoopChance: 0.45
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

            const interactionBehavior =
                new UseAvailableInteractionBehavior({
                    interactionSystem:
                        this.interactionSystem,

                    tags: [
                        "npc-interaction"
                    ]
                });

            const controller =
                new NPCController({
                    npc,
                    navigationSystem:
                        this.characterNavigation,
                    interactionBehavior,
                    closedLoops:
                        cozyCampusClosedLoops,
                    closedLoopChance:
                        configuration.closedLoopChance
                });

            this.controllers.push(controller);
            return npc;

        });

    }

    createNavigation() {

        this.navigationGraph = new NavigationGraph({
            // A floor click selects a node only inside this visible radius.
            selectionRadius: 1.25
        });
        configureCozyCampusNavigation(this.navigationGraph);

        if (!this.navigationGraph.isValid()) {

            console.log(
                "[Navigation] Invalid graph elements were ignored. Continuing with the valid subset.",
                this.navigationGraph.validationErrors
            );

        }

        this.navigationConnector = new NavigationConnector(
            this.navigationGraph
        );
        this.characterNavigation =
            new CharacterNavigationSystem({
                graph:
                    this.navigationGraph,

                connector:
                    this.navigationConnector,

                helper: null
            });
        this.navigationHelper =
            new NavigationGraphHelper(
                this.navigationGraph,
                {
                    connector: this.navigationConnector,
                    trafficState:
                        this.characterNavigation.trafficState,
                    routeGeometry:
                        this.characterNavigation.routeGeometry
                }
            );
        this.characterNavigation.helper = this.navigationHelper;
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
        character.setGrounding(this.characterGrounding);
        this.characterNavigation.registerActor(character, { spawnId });
        this.interactionSystem.registerActor(character, {
            navigate: request =>
                this.characterNavigation.moveToInteraction(
                    character,
                    request.point,
                    request.onArrive
                ),
            evaluate: candidate =>
                this.characterNavigation.evaluateInteraction(
                    character,
                    candidate.point
                )
        });

    }

    registerNavigationInteractions(entity) {

        if (
            entity.interactionPoints.length === 0
        ) {

            return;

        }

        for (
            const point of
            entity.interactionPoints
        ) {

            this.navigationConnector.register(
                point
            );

        }

        if (
            this.navigationHelper?.isVisible
        ) {

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
                const decision = actor.lastBehaviorDecision;

                return {
                    ...navigation,
                    behavior: controller?.state ?? "player input",
                    choice: decision
                        ? `${decision.interactionId} ` +
                            `(score ${decision.score.toFixed(2)}, ` +
                            `route ${decision.pathCost.toFixed(1)})`
                        : null
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

        // 1. Input and pointer-derived state.
        this.selection.update();
        this.controls.update();

        const characters = [...this.characterNavigation.agents.keys()]
            .filter(character => character.isActive());
        const characterSet = new Set(characters);

        // Non-character entities keep their ordinary lifecycle. Character
        // presentation is intentionally deferred until after physics below.
        for (const object of this.objects) {

            if (object.isActive() && !characterSet.has(object)) {

                object.update(delta);

            }

        }

        // 2. AI decisions publish intents; they never move bodies directly.
        for (const controller of this.controllers) {

            controller.update(delta);

        }

        // 3. Retry, recovery and route planning consume the newest intents.
        this.characterNavigation.updatePlanning(delta);

        // 4. Queue state is advanced, then every current waypoint requests
        // its node/lane/interaction authorization for this frame.
        this.characterNavigation.updateTraffic(delta);

        for (const character of characters) {

            character.authorizeMovementTraffic();

        }

        // 5. Locomotion publishes the movement it would apply this frame.
        for (const character of characters) {

            character.prepareMovement();

        }

        // 6. CollisionFailsafe may only brake that intended movement.
        for (const character of characters) {

            character.evaluateMovementGuard(delta);

        }

        for (const character of characters) {

            character.updateMovement(delta);

        }

        // 7. Cannon separates residual body contacts; it never chooses paths.
        this.characterNavigation.solvePhysics(delta);

        // 8. The walkable surface owns the final vertical position.
        for (const character of characters) {

            character.updateGrounding();

        }

        // 9. Animation consumes the final motion produced by this frame.
        for (const character of characters) {

            character.updateAnimation(delta);

        }


    }

    start() {

        let previous = performance.now();

        this.running = true;

        const loop = (now) => {

            if (!this.running) return;

            const rawDelta =
                (now - previous) / 1000;

            const delta = Math.min(
                rawDelta,
                1 / 15
            );

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

            this.animationFrameId =
                requestAnimationFrame(loop);

        };

        this.animationFrameId =
            requestAnimationFrame(loop);

    }

    dispose() {

        this.running = false;

        if (this.animationFrameId !== undefined) {

            cancelAnimationFrame(
                this.animationFrameId
            );

        }

        window.removeEventListener(
            "resize",
            this.handleResize
        );

        this.playerController?.dispose();
        this.selection?.dispose();

        this.characterDebugPanel?.dispose();
        this.performanceDebugPanel?.dispose();

        this.controls?.dispose();

        for (const actor of [
            this.player,
            ...(this.npcs ?? [])
        ]) {

            if (!actor) continue;

            this.interactionSystem.unregisterActor(actor);
            this.characterNavigation.unregisterActor(actor);

        }

        this.characterNavigation.dispose();
        this.navigationHelper.dispose();

        for (const object of this.objects) {

            this.interactionSystem
                .unregisterTarget(object);

            object.unregister?.(
                this.registry
            );

            object.dispose?.();

        }

        this.interactionSystem.dispose();

        this.postProcessing?.dispose();

        this.scene.traverse(object => {

            if (object.geometry) {

                object.geometry.dispose?.();

            }

            const materials =
                Array.isArray(object.material)
                    ? object.material
                    : object.material
                        ? [object.material]
                        : [];

            for (const material of materials) {

                for (const value of Object.values(material)) {

                    if (value?.isTexture) {

                        value.dispose();

                    }

                }

                material.dispose?.();

            }

        });

        this.registry?.clear();

        this.objects.length = 0;
        this.controllers.length = 0;
        this.npcs = [];

    }

}
