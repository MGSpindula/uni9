import { after } from "node:test";
import { createServer } from "vite";

// Source files intentionally use Vite-style extensionless imports. Loading
// the suite through Vite exercises the same module graph as the game without
// creating a WebGL renderer or adding a second test-only bundler.
const vite = await createServer({
    server: { middlewareMode: true },
    appType: "custom",
    optimizeDeps: { noDiscovery: true },
    logLevel: "error"
});

after(async () => {

    await vite.close();

});

await vite.ssrLoadModule(
    "/tests/navigation/navigation-regression.suite.js"
);
