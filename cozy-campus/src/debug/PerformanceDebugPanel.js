export class PerformanceDebugPanel {

    constructor({ refreshInterval = 500, simplified = false } = {}) {

        this.refreshInterval = refreshInterval;
        this.simplified = simplified;
        this.requiresDetailedMetrics = !simplified;
        this.lastRefresh = performance.now();
        this.frames = 0;
        this.frameTime = 0;
        this.updateTime = 0;
        this.renderTime = 0;
        this.maximumFrameTime = 0;
        this.renderedFrames = 0;
        this.phaseTotals = {};
        this.previousNavigationCounters = null;

        this.element = document.createElement("aside");
        this.element.className = "performance-debug";
        this.element.classList.toggle("simplified", simplified);
        this.element.innerHTML = simplified ? `
            <strong>Performance</strong>
            <span data-value="fps">-- FPS</span>
            <dl>
                <dt>Frame</dt><dd data-value="frame">--</dd>
                <dt>Update</dt><dd data-value="update">--</dd>
                <dt>Render</dt><dd data-value="render">--</dd>
                <dt>Calls</dt><dd data-value="calls">--</dd>
                <dt>Triangles</dt><dd data-value="triangles">--</dd>
            </dl>
        ` : `
            <strong>Performance</strong>
            <span data-value="fps">-- FPS</span>
            <dl>
                <dt>Frame</dt><dd data-value="frame">--</dd>
                <dt>Update</dt><dd data-value="update">--</dd>
                <dt>Render</dt><dd data-value="render">--</dd>
                <dt>Rendered</dt><dd data-value="rendered">--</dd>
                <dt>Collision</dt><dd data-value="collision">--</dd>
                <dt>AI</dt><dd data-value="phase-ai">--</dd>
                <dt>Planning</dt><dd data-value="phase-planning">--</dd>
                <dt>Traffic</dt><dd data-value="phase-traffic">--</dd>
                <dt>Movement</dt><dd data-value="phase-movement">--</dd>
                <dt>Locomotion</dt><dd data-value="phase-locomotion">--</dd>
                <dt>Failsafe</dt><dd data-value="phase-collision">--</dd>
                <dt>Physics</dt><dd data-value="phase-physics">--</dd>
                <dt>Grounding</dt><dd data-value="phase-grounding">--</dd>
                <dt>Animation</dt><dd data-value="phase-animation">--</dd>
                <dt>Routes/s</dt><dd data-value="routes-rate">--</dd>
                <dt>Recovery/s</dt><dd data-value="recovery-rate">--</dd>
                <dt>Geometry/s</dt><dd data-value="geometry-rate">--</dd>
                <dt>Geometry CPU</dt><dd data-value="geometry-cpu">--</dd>
                <dt>Segments/s</dt><dd data-value="segments-rate">--</dd>
                <dt>Timeouts/s</dt><dd data-value="timeouts-rate">--</dd>
                <dt>Waiting</dt><dd data-value="waiting">--</dd>
                <dt>Reservations</dt><dd data-value="reservations">--</dd>
                <dt>Phys. adjust</dt><dd data-value="physics-adjust">--</dd>
                <dt>Worst</dt><dd data-value="worst">--</dd>
                <dt>Calls</dt><dd data-value="calls">--</dd>
                <dt>Triangles</dt><dd data-value="triangles">--</dd>
                <dt>GPU mem.</dt><dd data-value="gpu-memory">--</dd>
                <dt>JS heap</dt><dd data-value="js-memory">n/a</dd>
                <dt>Viewport</dt><dd data-value="viewport">--</dd>
            </dl>
        `;

        this.values = new Map(
            [...this.element.querySelectorAll("[data-value]")].map(element => [
                element.dataset.value,
                element
            ])
        );

        document.body.appendChild(this.element);

    }

    // Called once per animation frame. Measurements are accumulated and the
    // HTML is updated only twice per second, keeping the profiler inexpensive.
    record({
        now,
        frame,
        update,
        render,
        rendered = true,
        renderer,
        collision = null,
        phases = null,
        navigation = null
    }) {

        this.frames++;
        this.frameTime += frame;
        this.updateTime += update;
        this.renderTime += render;
        this.maximumFrameTime = Math.max(this.maximumFrameTime, frame);
        if (rendered) this.renderedFrames++;
        for (const [name, duration] of Object.entries(phases ?? {})) {
            this.phaseTotals[name] = (this.phaseTotals[name] ?? 0) + duration;
        }

        const elapsed = now - this.lastRefresh;
        if (elapsed < this.refreshInterval) return;

        const divisor = Math.max(1, this.frames);
        const info = renderer.info;
        const heap = performance.memory?.usedJSHeapSize;

        this.set("fps", `${Math.round(this.frames * 1000 / elapsed)} FPS`);
        this.set("frame", `${(this.frameTime / divisor).toFixed(2)} ms`);
        this.set("update", `${(this.updateTime / divisor).toFixed(2)} ms`);
        this.set("render", `${(this.renderTime / divisor).toFixed(2)} ms`);
        this.set("rendered", `${this.renderedFrames}/${this.frames} frames`);
        this.set(
            "collision",
            collision
                ? `${collision.candidateChecks} checks / ` +
                    `${collision.queries} queries / ` +
                    `${collision.residualCorrections ?? 0} corrections`
                : "--"
        );
        for (const name of [
            "ai",
            "planning",
            "traffic",
            "movement",
            "locomotion",
            "collision",
            "physics",
            "grounding",
            "animation"
        ]) {
            this.set(
                `phase-${name}`,
                `${((this.phaseTotals[name] ?? 0) / divisor).toFixed(3)} ms`
            );
        }
        if (navigation) {
            const seconds = Math.max(elapsed / 1000, 0.001);
            const previous = this.previousNavigationCounters ?? navigation;
            const rate = name => Math.max(
                0,
                (navigation[name] - (previous[name] ?? 0)) / seconds
            ).toFixed(1);

            this.set("routes-rate", rate("routesCalculated"));
            this.set("recovery-rate", rate("routeRecoveries"));
            this.set("geometry-rate", rate("routeGeometryBuilds"));
            this.set(
                "geometry-cpu",
                `${rate("routeGeometryMilliseconds")} ms/s`
            );
            this.set("segments-rate", rate("routeSegmentsCreated"));
            this.set("timeouts-rate", rate("trafficTimeouts"));
            this.set("waiting", navigation.waitingActors);
            this.set("reservations", navigation.activeReservations);
            this.set(
                "physics-adjust",
                `${navigation.physicsCorrections} / ` +
                    `${navigation.physicsMaximumCorrection.toFixed(3)}m`
            );
            this.previousNavigationCounters = { ...navigation };
        }
        this.set("worst", `${this.maximumFrameTime.toFixed(2)} ms`);
        this.set("calls", info.render.calls.toLocaleString());
        this.set("triangles", info.render.triangles.toLocaleString());
        this.set(
            "gpu-memory",
            `${info.memory.geometries} geo / ${info.memory.textures} tex`
        );
        this.set(
            "js-memory",
            heap ? `${(heap / 1048576).toFixed(1)} MB` : "n/a"
        );
        this.set(
            "viewport",
            `${renderer.domElement.width}×${renderer.domElement.height} ` +
                `@${renderer.getPixelRatio().toFixed(2)}`
        );

        this.element.dataset.level = this.frameTime / divisor > 25
            ? "slow"
            : this.frameTime / divisor > 17
                ? "warning"
                : "good";

        this.lastRefresh = now;
        this.frames = 0;
        this.frameTime = 0;
        this.updateTime = 0;
        this.renderTime = 0;
        this.maximumFrameTime = 0;
        this.renderedFrames = 0;
        this.phaseTotals = {};

    }

    set(name, value) {

        const element = this.values.get(name);
        if (element) element.textContent = value;

    }

    dispose() {

        this.element.remove();

    }

}
