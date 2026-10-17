// Loopback-only acceptance fixture: simulate one unavailable model, then recover.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
const root = resolve("dist");
const port=Number(process.argv.find(arg=>arg.startsWith('--port='))?.slice(7)??4174);
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid local test port');
const failurePath=process.argv.includes('--field-atlas')?'/field/station.webp':'/city/manifest.json';
let failing = true;
createServer(async (req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  if (path === "/__recover" && req.method === "POST") {
    failing = false;
    res.end("OK");
    return;
  }
  if (path === failurePath && failing) {
    res.writeHead(503);
    res.end("Test failure");
    return;
  }
  const file = resolve(
    root,
    "." + (path === "/" ? "/index.html" : decodeURIComponent(path)),
  );
  if (!file.startsWith(root + sep)) {
    res.writeHead(403);
    res.end();
    return;
  }
  try {
    const data = await readFile(file);
    res.setHeader(
      "Content-Type",
      {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".png": "image/png",
        ".svg": "image/svg+xml",
      }[extname(file)] ?? "application/octet-stream",
    );
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end();
  }
}).listen(port, "127.0.0.1", () =>
  console.log(`Failure fixture http://127.0.0.1:${port} (${failurePath})`),
);
