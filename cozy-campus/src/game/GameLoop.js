import * as THREE from "three";

export class GameLoop {
    constructor(game) {
        this.game = game; this.running = false;
        this.frustum = new THREE.Frustum(); this.projection = new THREE.Matrix4();
        // Debug and AI share the same visibility result for this frame.
        this.actorVisibility = new WeakMap();
    }
    update(delta) {
        const g = this.game, s = g.services, world = g.world;
        if (!world || !s.characterNavigation) return;
        if (g.hasContinuousVisualActivity()) g.requestRender();
        s.selection.update();
        if (g.renderPipeline.controls.update()) g.requestRender();
        const characters = world.characters.filter(actor => actor.isActive());
        const characterSet = new Set(characters);
        for (const entity of world.entities) if (entity.isActive() && !characterSet.has(entity)) entity.update(delta);

        const camera = g.renderPipeline.camera;
        if (camera) {
            camera.updateMatrixWorld();
            this.projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
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
            if (!camera || !controller.npc) { controller.update(delta); continue; }
            controller.update(delta, this.getActorVisibility(controller.npc));
        }
        const navigation = s.characterNavigation;
        navigation.updatePlanning(delta); navigation.updateTraffic(delta);
        for (const actor of characters) actor.authorizeMovementTraffic();
        for (const actor of characters) actor.prepareMovement();
        navigation.prepareCollisionFrame(characters);
        for (const actor of characters) actor.evaluateMovementGuard(delta);
        for (const actor of characters) actor.updateMovement(delta);
        navigation.solvePhysics(delta);
        for (const actor of characters) actor.updateGrounding();
        for (const actor of characters) actor.updateAnimation(delta);
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
            this.game.performanceDebugPanel?.record({ now: end, frame: end - now, update: updateEnd - updateStart, render: render ? end - updateEnd : 0, rendered: render, collision: this.game.services.characterNavigation.collisionFailsafe.metrics, renderer: this.game.renderer.renderer });
            this.animationFrameId = requestAnimationFrame(frame);
        };
        this.animationFrameId = requestAnimationFrame(frame);
    }
    stop() { this.running = false; if (this.animationFrameId !== undefined) cancelAnimationFrame(this.animationFrameId); }
}
