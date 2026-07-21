export class PerformanceDebugPanel {

    constructor({ refreshInterval = 500 } = {}) {

        this.refreshInterval = refreshInterval;
        this.lastRefresh = performance.now();
        this.frames = 0;
        this.frameTime = 0;
        this.updateTime = 0;
        this.renderTime = 0;
        this.maximumFrameTime = 0;
        this.renderedFrames = 0;

        this.element = document.createElement("aside");
        this.element.className = "performance-debug";
        this.element.innerHTML = `
            <strong>Performance</strong>
            <span data-value="fps">-- FPS</span>
            <dl>
                <dt>Frame</dt><dd data-value="frame">--</dd>
                <dt>Update</dt><dd data-value="update">--</dd>
                <dt>Render</dt><dd data-value="render">--</dd>
                <dt>Rendered</dt><dd data-value="rendered">--</dd>
                <dt>Collision</dt><dd data-value="collision">--</dd>
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
        collision = null
    }) {

        this.frames++;
        this.frameTime += frame;
        this.updateTime += update;
        this.renderTime += render;
        this.maximumFrameTime = Math.max(this.maximumFrameTime, frame);
        if (rendered) this.renderedFrames++;

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
                    `${collision.queries} queries`
                : "--"
        );
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

    }

    set(name, value) {

        const element = this.values.get(name);
        if (element) element.textContent = value;

    }

    dispose() {

        this.element.remove();

    }

}
