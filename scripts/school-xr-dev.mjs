// LOCAL ONLY: connect the Vite/IWER development view to the separately running
// ephemeral school-browser-server. No Google credentials or production bypass.
// Start the browser server first, then run this and open localhost:4173/?testxr.
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
const origin = "http://localhost:4173", target = "http://localhost:4174";
const rewriteLocalOrigin = (proxyRequest, request) => {
  // The two local test servers have different ports. Reject foreign Origin at
  // the real Worker as usual; only this precise local view is bridged.
  if (request.headers.origin === origin) proxyRequest.setHeader("Origin", target);
};
const server = await createServer({ root: fileURLToPath(new URL("../", import.meta.url)),
  server: { host: "127.0.0.1", port: 4173, strictPort: true,
    proxy: { "/api": { target, ws: true, changeOrigin: true, configure(proxy) {
      proxy.on("proxyReq", rewriteLocalOrigin); proxy.on("proxyReqWs", rewriteLocalOrigin);
    } } } } });
await server.listen();
console.log("[school-xr-dev] LOCAL ONLY http://localhost:4173/?testxr (ephemeral school API on 4174)");
process.once("SIGINT", () => server.close().finally(() => process.exit()));
process.once("SIGTERM", () => server.close().finally(() => process.exit()));
