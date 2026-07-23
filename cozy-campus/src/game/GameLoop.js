import * as THREE from "three";

export class GameLoop {
    constructor(game) {
        this.game = game; this.running = false;
        this.frustum = new THREE.Frustum(); this.projection = new THREE.Matrix4();
        // Debug and AI share the same visibility result for this frame.
        this.actorVisibility = new WeakMap();
        this.phaseTimings = {};
    }
    update(delta) {
        const g = this.game, s = g.services, world = g.world;
        if (!world || !s.characterNavigation) return;
        this.phaseTimings = {};
        if (g.hasContinuousVisualActivity()) g.requestRender();
        this.measure("input", () => {
            s.selection.update();
            if (g.renderPipeline.controls.update()) g.requestRender();
        });
        const characters = world.characters.filter(actor => actor.isActive());
        const characterSet = new Set(characters);
        this.measure("entities", () => {
            for (const entity of world.entities) {
                if (entity.isActive() && !characterSet.has(entity)) {
                    entity.update(delta);
                }
            }
        });

        const camera = g.renderPipeline.camera;
        this.measure("ai", () => {
            if (camera) {
                camera.updateMatrixWorld();
                this.projection.multiplyMatrices(
                    camera.projectionMatrix,
                    camera.matrixWorldInverse
                );
                this.frustum.setFromProjectionMatrix(this.projection);
            }
            for (const actor of characters) {
                const position = actor.object3D?.position;
                this.actorVisibility.set(actor, {
                    visible: camera && position
                        ? this.frustum.containsPoint(position)
                        : true,
                    distance: camera && position
                        ? camera.position.distanceTo(position)
                        : 0
                });
            }
            for (const controller of world.controllers) {
                if (!camera || !controller.npc) {
                    controller.update(delta);
                    continue;
                }
                controller.update(
                    delta,
                    this.getActorVisibility(controller.npc)
                );
            }
        });
        const navigation = s.characterNavigation;
        this.measure("planning", () => navigation.updatePlanning(delta));
        this.measure("traffic", () => navigation.updateTraffic(delta));
        this.measure("movement", () => {
            for (const actor of characters) actor.authorizeMovementTraffic();
            for (const actor of characters) actor.prepareMovement();
        });
        this.measure("collision", () => {
            navigation.prepareCollisionFrame(characters);
            navigation.resolveCharacterOverlaps(characters, delta);
            for (const actor of characters) actor.evaluateMovementGuard(delta);
        });
        this.measure("locomotion", () => {
            for (const actor of characters) actor.updateMovement(delta);
        });
        this.measure("collision", () => {
            navigation.resolveResidualCharacterOverlaps(characters, delta);
        });
        this.measure("physics", () => navigation.solvePhysics(delta));
        this.measure("grounding", () => {
            for (const actor of characters) actor.updateGrounding();
        });
        this.measure("animation", () => {
            for (const actor of characters) actor.updateAnimation(delta);
        });
    }
    measure(name, callback) {
        const started = performance.now();
        const result = callback();
        this.phaseTimings[name] = (this.phaseTimings[name] ?? 0) +
            performance.now() - started;
        return result;
    }
    getActorVisibility(actor) {
        return this.actorVisibility.get(actor) ?? { visible: true, distance: 0 };
    }
    start() {
        let previous = performance.now(); this.running = true;
        const frame = now => {
            if (!this.running) return;
            const delta = Math.min((now - previous) / 1000, 1 / 15); previous = now;
            const updateStart = performance.now(); this.update(delta); const updateEnd = performance.now();
            const render = this.game.renderRequested || this.game.hasContinuousVisualActivity();
            if (render) { this.game.renderPipeline.render(delta); this.game.renderRequested = false; }
            const end = performance.now();
            const performancePanel = this.game.performanceDebugPanel;
            const detailedPerformance =
                performancePanel?.requiresDetailedMetrics ?? false;
            performancePanel?.record({
                now: end,
                frame: end - now,
                update: updateEnd - updateStart,
                render: render ? end - updateEnd : 0,
                rendered: render,
                phases: detailedPerformance ? this.phaseTimings : null,
                collision: detailedPerformance
                    ? this.game.services.characterNavigation
                        .collisionFailsafe.metrics
                    : null,
                navigation: detailedPerformance
                    ? this.game.services.characterNavigation
                        .getMetricsSnapshot()
                    : null,
                renderer: this.game.renderer.renderer
            });
            this.animationFrameId = requestAnimationFrame(frame);
        };
        this.animationFrameId = requestAnimationFrame(frame);
    }
    stop() { this.running = false; if (this.animationFrameId !== undefined) cancelAnimationFrame(this.animationFrameId); }
}
