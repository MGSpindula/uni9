import { RenderPipeline } from "./game/RenderPipeline";
import { GameServices } from "./game/GameServices";
import { GameLoop } from "./game/GameLoop";
import { PlayerController } from "./characters/PlayerController";
import { CharacterDebugPanel } from "./debug/CharacterDebugPanel";
import { PerformanceDebugPanel } from "./debug/PerformanceDebugPanel";

export class Game {
    constructor(renderer, {
        level,
        debugMode = false,
        simplePerformanceDebug = false
    } = {}) {
        if (!level) {
            throw new Error("Game requires a Level instance.");
        }

        this.renderer = renderer;
        this.renderRequested = true;
        this.debugMode = Boolean(debugMode);
        this.simplePerformanceDebug = Boolean(simplePerformanceDebug);
        this.renderPipeline = new RenderPipeline(renderer, () => this.requestRender());
        this.services = new GameServices({
            camera: this.renderPipeline.camera,
            element: renderer.renderer.domElement,
            onChanged: () => this.requestRender(),
            navigationHelperVisible: this.debugMode
        });
        this.services.selection.addEffect(this.renderPipeline.outline);
        this.loop = new GameLoop(this);
        this.loadLevel(level);
        this.applyDebugMode();
    }
    loadLevel(level) {
        if (!level || typeof level.load !== "function" || typeof level.unload !== "function") {
            throw new TypeError("A level must implement load(game) and unload(game).");
        }

        this.playerController?.dispose(); this.level?.unload(this);
        this.level = level; this.world = level.load(this);
        this.player = level.player; this.npcs = level.npcs ?? [];
        // A level registers authored interaction points during load(). The
        // final refresh guarantees that nodes, portals, labels and access
        // anchors all represent the completely loaded level.
        this.services.navigationHelper?.refresh();
        this.playerController = new PlayerController({ player: this.player, selection: this.services.selection, interactionSystem: this.services.interactions, element: this.renderer.renderer.domElement });
        if (this.debugMode) this.applyDebugCamera();
        this.requestRender(); return level;
    }
    createCharacterDebug() {
        if (this.characterDebugPanel) return;

        this.characterDebugPanel = new CharacterDebugPanel({
            getRows: () => this.world.characters.map(actor => {
                const visibility = this.loop.getActorVisibility(actor);
                const decision = actor.lastBehaviorDecision;

                return {
                    ...this.services.characterNavigation.getActorDebugState(actor),
                    behavior: this.world.controllers.find(
                        controller => controller.npc === actor
                    )?.state ?? "player input",
                    view: visibility.visible
                        ? `ONSCREEN (${visibility.distance.toFixed(1)}m)`
                        : `OFFSCREEN (${visibility.distance.toFixed(1)}m)`,
                    choice: decision
                        ? `${decision.interactionId} ` +
                            `(score ${decision.score.toFixed(2)}, ` +
                            `path ${decision.pathCost.toFixed(2)}, ` +
                            `traffic ${decision.congestion.toFixed(2)})`
                        : null,
                    offscreen: !visibility.visible
                };
            })
        });
    }
    createPerformanceDebug({ simplified = false } = {}) {
        if (this.performanceDebugPanel?.simplified === simplified) return;

        this.performanceDebugPanel?.dispose();
        this.performanceDebugPanel = new PerformanceDebugPanel({ simplified });
    }
    disposeCharacterDebug() {
        this.characterDebugPanel?.dispose();
        this.characterDebugPanel = null;
    }
    disposePerformanceDebug() {
        this.performanceDebugPanel?.dispose();
        this.performanceDebugPanel = null;
    }
    disposeDebug() {
        this.disposeCharacterDebug();
        this.disposePerformanceDebug();
    }
    applyDebugCamera() {
        const positions = [...(this.services.navigationGraph?.nodes.values() ?? [])]
            .map(node => node.position);
        this.renderPipeline.setBirdEyeView(positions);
    }
    applyDebugMode() {
        this.setNavigationHelperVisible(this.debugMode);

        if (this.debugMode) {
            this.createCharacterDebug();
            this.applyDebugCamera();
        } else {
            this.disposeCharacterDebug();
            this.renderPipeline.setDefaultCameraView();
        }

        if (this.debugMode || this.simplePerformanceDebug) {
            this.createPerformanceDebug({
                simplified: this.simplePerformanceDebug
            });
        } else {
            this.disposePerformanceDebug();
        }
    }
    setDebugMode(value) {
        this.debugMode = Boolean(value);
        // Keep future level loads consistent with the current runtime mode.
        this.services.navigationHelperVisible = this.debugMode;
        this.applyDebugMode();
        this.requestRender();
    }
    setSimplePerformanceDebug(value) {
        this.simplePerformanceDebug = Boolean(value);
        this.applyDebugMode();
        this.requestRender();
    }
    requestRender() { this.renderRequested = true; }
    hasContinuousVisualActivity() {
        return this.world?.entities.some(entity =>
            entity.isActive() && entity.requiresContinuousRender?.()
        ) ?? false;
    }
    start() { this.loop.start(); }
    update(delta) { this.loop.update(delta); }
    setQualityPreset(name) { this.renderPipeline.setQualityPreset(name); }
    setNavigationHelperVisible(value) { this.services.navigationHelper?.setVisible(value); this.requestRender(); }
    toggleNavigationHelper() { this.services.navigationHelper?.toggleVisible(); this.requestRender(); }
    setNavigationNodeBlocked(id, value = true) { this.services.navigationGraph.setNodeBlocked(id, value); this.navigationTopologyChanged(); }
    setNavigationConnectionBlocked(a, b, value = true) { this.services.navigationGraph.setConnectionBlocked(a, b, value); this.navigationTopologyChanged(); }
    disconnectNavigationNodes(a, b) { this.services.navigationGraph.disconnect(a, b); this.navigationTopologyChanged(); }
    navigationTopologyChanged() { this.services.navigationHelper?.refresh(); this.services.characterNavigation.topologyChanged(); }
    dispose() {
        this.loop.stop(); this.playerController?.dispose(); this.disposeDebug();
        this.level?.unload(this); this.services.dispose(); this.renderPipeline.dispose();
    }
    get scene() { return this.renderPipeline.scene; }
    get camera() { return this.renderPipeline.camera; }
    get characterNavigation() { return this.services.characterNavigation; }
    get navigationGraph() { return this.services.navigationGraph; }
    get navigationHelper() { return this.services.navigationHelper; }
    get interactionSystem() { return this.services.interactions; }
    get selection() { return this.services.selection; }
    get controls() { return this.renderPipeline.controls; }
    get objects() { return this.world?.entities ?? []; }
    get controllers() { return this.world?.controllers ?? []; }
}
