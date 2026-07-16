import * as THREE from "three";

import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { PostProcessing } from "./postprocessing/PostProcessing";
import { OutlineEffect } from "./postprocessing/OutlineEffect";

import { EntityRegistry } from "./core/EntityRegistry";
import { EntityState } from "./core/EntityState";
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

    movePlayerToInteractionPoint(point, onArrive) {

        if (!point.accessible || !point.connection) {

            console.log(
                `[Navigation] Interaction point "${point.id}" is inaccessible.`
            );
            return;

        }

        const origins = this.getPlayerNavigationOrigins();
        const routes = origins
            .map(origin => ({
                origin,
                route: this.navigationConnector.createRoute(
                    point,
                    origin.id,
                    this.player
                )
            }))
            .filter(candidate => candidate.route);

        if (routes.length === 0) {

            console.log(
                `[Navigation] No available route to interaction point "${point.id}".`
            );
            return;

        }

        const candidate = routes.reduce((best, current) =>
            current.origin.accessCost + current.route.cost <
            best.origin.accessCost + best.route.cost
                ? current
                : best
        );

        if (!this.navigationConnector.reserveRoutePoints(
            candidate.route,
            this.player
        )) {

            console.log(
                `[Navigation] Local access to "${point.id}" became unavailable.`
            );
            return;

        }

        this.preparePlayerNavigationOrigin(candidate.origin.id);
        this.pendingNavigationPosition = null;
        this.navigationDestinationId = null;
        this.navigationRetryEnabled = false;
        this.navigationBlockedElapsed = null;
        this.navigationRecoveryPending = false;
        this.pendingInteraction = { point, onArrive };
        this.interactionRetryElapsed = 0;

        this.navigationHelper.highlightInteractionPoint(point.id);
        this.player.followWaypoints([
            ...this.navigationConnector.createExitWaypoints(
                this.playerInteractionPoint
            ),
            ...candidate.route.waypoints
        ]);

        console.log(
            `[Navigation] Moving to interaction point: ${point.id}`
        );

    }

    movePlayerToClosestNode(position, { preserveOnFailure = true } = {}) {

        const candidate = this.findBestPlayerPlan(position);

        if (!candidate) {

            console.warn("[Navigation] Nenhum node acessível foi encontrado.");

            // An invalid new click must not interrupt a valid command in course.
            // A route invalidated by topology, however, must stop safely.
            if (!preserveOnFailure) {

                this.navigationRetryEnabled = false;
                this.player.pause();
                this.beginBlockedNavigationWait();

            }

            return;

        }

        this.pendingNavigationPosition = position.clone();
        this.pendingInteraction = null;
        this.interactionRetryElapsed = 0;
        this.navigationRetryEnabled = true;
        this.navigationRetryElapsed = 0;
        this.navigationBlockedElapsed = null;
        this.navigationRecoveryPending = false;

        this.preparePlayerNavigationOrigin(candidate.originId);

        const waypoints = [
            ...this.navigationConnector.createExitWaypoints(
                this.playerInteractionPoint
            ),
            ...this.navigationGraph.createWaypoints(candidate.plan.nodeIds)
        ];

        this.navigationDestinationId = candidate.plan.destinationId;

        const traversal = this.player.navigation.getTraversalState();
        const alreadyAtDestination =
            traversal.currentNodeId === candidate.plan.destinationId &&
            candidate.plan.nodeIds.length === 1 &&
            !this.playerInteractionPoint;

        this.navigationHelper.highlightNode(candidate.plan.destinationId);

        if (alreadyAtDestination) {

            this.pendingNavigationPosition = null;
            this.navigationDestinationId = null;
            this.player.cancel();

            console.log(
                `[Navigation] Player já está em: ${candidate.plan.destinationId}`
            );

            return;

        }

        if (candidate.plan.status === "ready") {

            console.log(
                `[Navigation] Rota pronta para: ${candidate.plan.destinationId}`
            );

        } else {

            console.log(
                "[Navigation] Aguardando recurso:",
                candidate.plan.waitingFor
            );

        }

        this.player.followWaypoints(waypoints, {
            waitAtEnd: candidate.plan.status === "waiting"
        });

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

    findBestPlayerPlan(position) {

        const origins = this.getPlayerNavigationOrigins();

        const candidates = origins
            .map(origin => ({
                originId: origin.id,
                accessCost: origin.accessCost,
                plan: this.navigationGraph.planClosestPath(
                    origin.id,
                    position,
                    this.player
                )
            }))
            .filter(candidate => candidate.plan.status !== "unreachable");

        if (candidates.length === 0) return null;

        return candidates.reduce((best, candidate) =>
            candidate.accessCost + candidate.plan.cost <
            best.accessCost + best.plan.cost
                ? candidate
                : best
        );

    }

    getPlayerNavigationOrigins() {

        if (this.playerInteractionPoint) {

            const accessPoint = this.playerInteractionPoint.via ??
                this.playerInteractionPoint;
            const connection = this.navigationConnector.connect(accessPoint);

            if (!connection) return [];

            return connection.nodeIds
                .filter(id =>
                    this.navigationGraph.isNodeAvailable(id, this.player)
                )
                .map(id => ({
                    id,
                    accessCost: Math.sqrt(
                        this.navigationGraph.getPlanarDistanceSquared(
                            connection.projectedPosition,
                            this.navigationGraph.requireNode(id).position
                        )
                    )
                }));

        }

        const traversal = this.player.navigation.getTraversalState();

        if (traversal.currentNodeId) {

            return [{ id: traversal.currentNodeId, accessCost: 0 }];

        }

        if (!traversal.currentConnection) return [];

        return [
            traversal.currentConnection.fromId,
            traversal.currentConnection.toId
        ]
            .filter(id =>
                this.navigationGraph.isNodeAvailable(id, this.player)
            )
            .map(id => ({
                id,
                accessCost: Math.sqrt(
                    this.navigationGraph.getPlanarDistanceSquared(
                        this.player.object3D.position,
                        this.navigationGraph.requireNode(id).position
                    )
                )
            }));

    }

    preparePlayerNavigationOrigin(originId) {

        if (!this.playerInteractionPoint) {

            this.retargetActivePlayerConnection(originId);
            return;

        }

        // A local access is projected onto an edge. Either endpoint can be the
        // next graph origin; the endpoint used to enter is not privileged.
        this.navigationGraph.releaseReservations(this.player);
        this.navigationGraph.reserveNode(originId, this.player);
        this.player.navigation.setCurrentNode(originId);
        this.navigationHelper.refresh();
        this.refreshNavigationDebugPanel();

    }

    tryStartPlayerConnection(fromId, toId) {

        if (!this.navigationGraph.reserveConnection(fromId, toId, this.player)) {

            return false;

        }

        if (!this.navigationGraph.reserveNode(toId, this.player)) {

            this.navigationGraph.releaseConnection(fromId, toId, this.player);
            return false;

        }

        this.navigationGraph.occupyConnection(fromId, toId, this.player);
        this.navigationGraph.releaseNode(fromId, this.player);
        this.navigationHelper.refresh();
        this.refreshNavigationDebugPanel();

        return true;

    }

    retargetActivePlayerConnection(targetId) {

        const traversal = this.player.navigation.getTraversalState();

        if (!traversal.currentConnection) return;

        this.navigationGraph.releaseReservations(this.player);
        this.navigationGraph.reserveNode(targetId, this.player);

    }

    pausePlayerNavigation() {

        this.navigationRetryEnabled = false;
        this.player.pause();

    }

    resumePlayerNavigation() {

        this.navigationRetryEnabled = true;
        this.player.resume();

    }

    cancelPlayerNavigation() {

        this.pendingNavigationPosition = null;
        this.navigationDestinationId = null;
        this.navigationRetryEnabled = false;
        this.navigationBlockedElapsed = null;
        this.navigationRecoveryPending = false;
        this.pendingInteraction = null;
        this.interactionRetryElapsed = 0;
        this.player.cancel();

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

        if (this.characterNavigation) {

            this.characterNavigation.topologyChanged();
            return;

        }

        if (!this.player) return;

        if (this.navigationRecoveryPending) {

            this.tryRecoverPlayerToNearestNode();
            return;

        }

        if (!this.pendingNavigationPosition) return;

        // Routes are snapshots. Replanning replaces an invalid future route,
        // but preserves the current traversal instead of snapping to a node.
        this.navigationRetryEnabled = true;
        this.movePlayerToClosestNode(this.pendingNavigationPosition, {
            preserveOnFailure: false
        });

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

    updateWaitingNavigation(delta) {

        if (!this.navigationRetryEnabled ||
            !this.pendingNavigationPosition ||
            !this.player.isState(EntityState.WAITING)) return;

        this.navigationRetryElapsed += delta;

        if (this.navigationRetryElapsed < 0.5) return;

        this.navigationRetryElapsed = 0;
        this.movePlayerToClosestNode(this.pendingNavigationPosition, {
            preserveOnFailure: false
        });

    }

    updateWaitingInteraction(delta) {

        const waypoint = this.player.navigation.getCurrentWaypoint();
        const isWaitingForLocalPoint = waypoint?.interactionPoint;

        if ((!this.pendingInteraction && !isWaitingForLocalPoint) ||
            !this.player.isState(EntityState.WAITING)) return;

        this.interactionRetryElapsed += delta;

        if (this.interactionRetryElapsed < 0.5) return;

        this.interactionRetryElapsed = 0;
        this.player.resume();

    }

    // -----------------------------
    // Blocked-route recovery
    // -----------------------------

    beginBlockedNavigationWait() {

        // Further topology changes must not restart the three-second deadline.
        this.navigationBlockedElapsed ??= 0;

    }

    updateBlockedNavigation(delta) {

        if (this.navigationBlockedElapsed === null) return;

        this.navigationBlockedElapsed += delta;

        if (this.navigationBlockedElapsed < this.navigationBlockedTimeout) return;

        this.navigationBlockedElapsed = null;
        this.abandonBlockedDestination();

    }

    abandonBlockedDestination() {

        console.log(
            "[Navigation] Destino bloqueado abandonado. Procurando ponto seguro."
        );

        // Once abandoned, unblocking must never revive the old command.
        this.pendingNavigationPosition = null;
        this.navigationDestinationId = null;
        this.navigationRetryEnabled = false;
        this.navigationGraph.releaseReservations(this.player);

        this.navigationRecoveryPending = true;
        this.tryRecoverPlayerToNearestNode();

    }

    tryRecoverPlayerToNearestNode() {

        const traversal = this.player.navigation.getTraversalState();

        if (traversal.currentNodeId) {

            const currentNode = this.navigationGraph.requireNode(
                traversal.currentNodeId
            );

            if (!currentNode.blocked) {

                // The Player is already safely positioned on the nearest node.
                this.navigationRecoveryPending = false;
                this.player.cancel();
                this.navigationHelper.highlightNode(currentNode.id);
                return true;

            }

            const recoveryPath = this.navigationGraph.findNearestAvailablePath(
                currentNode.id,
                this.player
            );

            if (!recoveryPath) return false;

            const destinationId = recoveryPath.nodeIds.at(-1);

            this.navigationRecoveryPending = false;
            this.navigationDestinationId = destinationId;
            this.navigationHelper.highlightNode(destinationId);
            this.player.followWaypoints(
                this.navigationGraph.createWaypoints(recoveryPath.nodeIds)
            );

            return true;

        }

        if (!traversal.currentConnection) return false;

        const endpoint = [
            traversal.currentConnection.fromId,
            traversal.currentConnection.toId
        ]
            .map(id => this.navigationGraph.requireNode(id))
            .filter(node =>
                !node.blocked &&
                this.navigationGraph.isNodeAvailable(node.id, this.player)
            )
            .sort((first, second) =>
                this.navigationGraph.getPlanarDistanceSquared(
                    this.player.object3D.position,
                    first.position
                ) -
                this.navigationGraph.getPlanarDistanceSquared(
                    this.player.object3D.position,
                    second.position
                )
            )[0];

        // If both endpoints are blocked, remain waiting. A later unblock calls
        // this method again, but the abandoned destination stays forgotten.
        if (!endpoint) return false;

        this.navigationRecoveryPending = false;
        this.navigationDestinationId = endpoint.id;
        this.navigationGraph.reserveNode(endpoint.id, this.player);
        this.navigationHelper.highlightNode(endpoint.id);
        this.player.followWaypoints(this.navigationGraph.createWaypoints([
            endpoint.id
        ]));

        return true;

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
