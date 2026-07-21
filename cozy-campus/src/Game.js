import { RenderPipeline } from "./game/RenderPipeline";
import { GameServices } from "./game/GameServices";
import { GameLoop } from "./game/GameLoop";
import { PlayerController } from "./characters/PlayerController";
import { CharacterDebugPanel } from "./debug/CharacterDebugPanel";
import { PerformanceDebugPanel } from "./debug/PerformanceDebugPanel";

export class Game {
    constructor(renderer, { level } = {}) {
        if (!level) {
            throw new Error("Game requires a Level instance.");
        }

        this.renderer = renderer; this.renderRequested = true;
        this.renderPipeline = new RenderPipeline(renderer, () => this.requestRender());
        this.services = new GameServices({ camera: this.renderPipeline.camera, element: renderer.renderer.domElement, onChanged: () => this.requestRender() });
        this.services.selection.addEffect(this.renderPipeline.outline);
        this.loop = new GameLoop(this);
        this.loadLevel(level);
        if (import.meta.env.DEV) this.createDebug();
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
        this.requestRender(); return level;
    }
    createDebug() {
        this.performanceDebugPanel = new PerformanceDebugPanel();
        this.characterDebugPanel = new CharacterDebugPanel({
            getRows: () => this.world.characters.map(actor => {
                const visibility = this.loop.getActorVisibility(actor);

                return {
                    ...this.services.characterNavigation.getActorDebugState(actor),
                    behavior: this.world.controllers.find(
                        controller => controller.npc === actor
                    )?.state ?? "player input",
                    view: visibility.visible
                        ? `ONSCREEN (${visibility.distance.toFixed(1)}m)`
                        : `OFFSCREEN (${visibility.distance.toFixed(1)}m)`,
                    offscreen: !visibility.visible
                };
            })
        });
    }
    requestRender() { this.renderRequested = true; }
    hasContinuousVisualActivity() { return this.world?.entities.some(e => e.tweens?.length) || this.world?.characters.some(c => c.locomotion.getMotionState().moving || c.tweens?.length || c.animation?.mixer); }
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
        this.loop.stop(); this.playerController?.dispose(); this.characterDebugPanel?.dispose(); this.performanceDebugPanel?.dispose();
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
