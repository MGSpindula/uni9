import { createServer } from "vite";

const vite = await createServer({
    server: { middlewareMode: true },
    appType: "custom",
    optimizeDeps: { noDiscovery: true },
    logLevel: "error"
});

try {
    await vite.ssrLoadModule(
        "/tests/performance/navigation-frame.benchmark.suite.js"
    );
} finally {
    await vite.close();
}
