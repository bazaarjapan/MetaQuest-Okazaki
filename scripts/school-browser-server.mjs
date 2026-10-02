// Local-only browser gate: the real production Worker bundle, built dist files,
// and temporary Miniflare/workerd D1 + R2 + SQLite Durable Objects. Nothing here
// is a production login bypass, Google login test, remote binding or deployment.
//
// Usage (root owns browser verification/startup):
//   npm run build
//   node scripts/school-browser-server.mjs
//   Open http://localhost:4174 (NOT 127.0.0.1; Origin is checked by the Worker).
//   Read .cache/school-browser-fixtures.json locally, never echo/share/commit it.
//   Inject teacher.browserCookie or student.browserCookie via the browser CLI.
//   Reload and operate the actual UI. Student joins with world.joinCode.
//   SIGINT/SIGTERM closes workerd, erases this run's fixture file and ephemeral DB.
// Do not click Google login: fixture sessions test downstream app authorization,
// not a real Google credential exchange. No production Worker source is changed.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Log, LogLevel, Miniflare, convertV4MiniflareOptions } from "miniflare";
import { LIMITS } from "../worker/school-common.mjs";
import { CORE_SOURCE_HASHES, loadCorePlacement } from "../worker/placement-source.mjs";
import { normalizeSTLPositions, parseSTL } from "../src/stl-model.js";
import { validatePlacement } from "../src/placement.js";
import { schoolInviteURL } from "../src/school-client.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const host = "127.0.0.1", port = 4174, origin = `http://localhost:${port}`;
const fixturePath = resolve(root, ".cache/school-browser-fixtures.json");
const require = createRequire(import.meta.url);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const randomToken = () => randomBytes(32).toString("base64url");
const mimeTypes = Object.freeze({ ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".ico": "image/x-icon", ".wasm": "application/wasm", ".woff": "font/woff", ".woff2": "font/woff2",
  ".gltf": "model/gltf+json", ".glb": "model/gltf-binary", ".stl": "model/stl", ".bin": "application/octet-stream" });

function parseAssetHeaders(text) {
  const rules = []; let current = null;
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!/^\s/u.test(line)) { current = { pattern: line.trim(), values: [] }; rules.push(current); continue; }
    const match = line.match(/^\s+([A-Za-z][A-Za-z0-9-]*):\s*(.*?)\s*$/u);
    if (match && current) current.values.push([match[1], match[2]]);
  }
  return rules;
}
function matchesAssetRule(pattern, pathname) {
  return pattern.endsWith("*") ? pathname.startsWith(pattern.slice(0, -1)) : pathname === pattern;
}

// Whitelist every real dist file at startup; reject symlinks and decoded path
// traversal/backslashes before reading any bytes. There is no SPA error fallback.
export async function createDistAssetService(directory = resolve(root, "dist")) {
  const base = await realpath(directory), files = new Map();
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const file = resolve(current, entry.name);
      if (entry.isSymbolicLink()) throw Error("Local browser gate refuses symlinked dist assets");
      if (entry.isDirectory()) { await walk(file); continue; }
      if (!entry.isFile()) continue;
      const actual = await realpath(file);
      if (!actual.startsWith(`${base}${sep}`)) throw Error("Dist asset escapes its verified root");
      const key = `/${relative(base, actual).split(sep).join("/")}`;
      const bytes = await readFile(actual);
      files.set(key, { filename: actual, bytes: bytes.byteLength, sha256: digest(bytes) });
    }
  }
  await walk(base);
  if (!files.has("/index.html")) throw Error("Built dist/index.html is missing. Run npm run build before the browser gate.");
  const rules = parseAssetHeaders(files.has("/_headers") ? await readFile(files.get("/_headers").filename, "utf8") : "");
  const manifest = [...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, file]) => ({ path, bytes: file.bytes, sha256: file.sha256 }));
  async function fetchAsset(request) {
    if (!["GET", "HEAD"].includes(request.method)) return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url).pathname); }
    catch { return new Response("Invalid path", { status: 400 }); }
    if (!pathname.startsWith("/") || /[\\\u0000]/u.test(pathname) ||
      pathname.split("/").some((segment) => segment === "." || segment === "..")) {
      return new Response("Invalid path", { status: 400 });
    }
    const path = pathname === "/" ? "/index.html" : pathname;
    const file = files.get(path);
    if (!file) return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" } });
    const bytes = await readFile(file.filename);
    if (digest(bytes) !== file.sha256) return new Response("Dist changed during the browser gate; rebuild and restart it", { status: 409 });
    const headers = new Headers({ "Content-Type": mimeTypes[extname(path).toLowerCase()] ?? "application/octet-stream",
      "X-Content-Type-Options": "nosniff" });
    for (const rule of rules) if (matchesAssetRule(rule.pattern, pathname)) {
      for (const [name, value] of rule.values) headers.set(name, value);
    }
    // Local-only, explicit same-origin WebSocket allowance. All other production
    // CSP directives stay unchanged; no fake script or auth bypass is injected.
    const csp = headers.get("Content-Security-Policy");
    if (csp) headers.set("Content-Security-Policy", csp.replace(/connect-src\s+([^;]+)/u,
      (_, sources) => `connect-src ${sources} ws://localhost:${port}`));
    headers.set("Cache-Control", "no-store"); headers.set("Content-Length", String(bytes.byteLength));
    return new Response(request.method === "HEAD" ? null : bytes, { headers });
  }
  return { fetch: fetchAsset, fileCount: files.size, manifest,
    bytes: manifest.reduce((sum, file) => sum + file.bytes, 0), manifestSha256: digest(JSON.stringify(manifest)) };
}

async function ensurePortFree() {
  await new Promise((resolveFree, reject) => {
    const probe = createServer();
    probe.once("error", (error) => reject(Error(`Cannot start local browser gate on localhost:${port}: ${error.code ?? error.message}. Do not terminate an unknown process.`, { cause: error })));
    probe.listen({ host, port, exclusive: true }, () => probe.close((error) => error ? reject(error) : resolveFree()));
  });
}

async function seedFixturePerson(db, role, number) {
  const id = randomUUID(), sessionToken = randomToken(), csrf = randomToken();
  const now = Math.floor(Date.now() / 1000), expiresAt = now + LIMITS.sessionSeconds;
  const avatar = { name: role === "teacher" ? "検証用先生" : `検証用生徒-${number}`,
    color: ["#4a90e2", "#e67e22", "#2ecc71", "#9b59b6"][number % 4] };
  await db.batch([
    db.prepare("INSERT INTO school_users(id,google_sub,role,avatar_json,created_at) VALUES(?,?,?,?,?)")
      .bind(id, `browser-fixture-not-google-${randomUUID()}`, role, JSON.stringify(avatar), now),
    db.prepare("INSERT INTO school_sessions(token_hash,user_id,csrf,expires_at,created_at) VALUES(?,?,?,?,?)")
      .bind(digest(sessionToken), id, csrf, expiresAt, now),
  ]);
  return { id, role, avatar, csrf, tokenHash: digest(sessionToken), expiresAt,
    cookie: `__Host-school-session=${sessionToken}`,
    // URL (no Domain attribute) is essential to preserve the __Host prefix.
    // localhost is Chrome's secure-context exception; production flags do not change.
    browserCookie: { name: "__Host-school-session", value: sessionToken, url: `${origin}/`,
      path: "/", secure: true, httpOnly: true, sameSite: "Lax", expires: expiresAt } };
}

function cubeStl() {
  const vertices = [[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]];
  const faces = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[3,7,6],[3,6,2],[0,4,7],[0,7,3],[1,2,6],[1,6,5]];
  return new TextEncoder().encode(`solid browser-cube\n${faces.map((face) => `facet normal 0 0 0\nouter loop\n${face.map((i) => `vertex ${vertices[i].join(" ")}`).join("\n")}\nendloop\nendfacet`).join("\n")}\nendsolid browser-cube`);
}

async function cubeGroundPositions(assets, bytes) {
  const surfaces = await loadCorePlacement({ fetch: async (request) => {
    const path = new URL(request.url).pathname;
    const filename = path.startsWith("/city/") ? path.slice(6) : "";
    if (!Object.hasOwn(CORE_SOURCE_HASHES, filename)) throw Error("Unexpected placement source asset");
    const response = await assets.fetch(request);
    if (!response.ok) throw Error(`Original PLATEAU source unavailable (${response.status})`);
    const contents = await response.arrayBuffer();
    if (digest(new Uint8Array(contents)) !== CORE_SOURCE_HASHES[filename]) throw Error(`Original PLATEAU source hash mismatch: ${filename}`);
    return new Response(contents);
  } });
  const normalized = normalizeSTLPositions(parseSTL(bytes.buffer).positions, "y");
  const values = [];
  for (let z = -350; z <= 350; z += 15) {
    for (let x = -300; x <= 300; x += 15) {
      if (values.some((entry) => Math.hypot(entry.position[0] - x, entry.position[2] - z) < 25)) continue;
      const normal = { positions: normalized.positions, position: [x,999,z], rotation: [0,0,0], scale: [1,1,1] };
      const rotated = { ...normal, rotation: [0.3,0.5,0.2], scale: [0.5,0.5,0.5] };
      const first = validatePlacement(normal, surfaces), second = validatePlacement(rotated, surfaces);
      if (!first.valid || !second.valid) continue;
      values.push({ position: first.position, rotation: normal.rotation, scale: normal.scale,
        rotated: { position: second.position, rotation: rotated.rotation, scale: rotated.scale } });
      if (values.length === 3) return values;
    }
  }
  throw Error("Three original PLATEAU empty ground locations could not be verified");
}

export async function createBrowserCubeFixture(assets) {
  const bytes = cubeStl();
  return { bytes, sha256: digest(bytes), groundPositions: await cubeGroundPositions(assets, bytes) };
}

export async function startSchoolBrowserServer() {
  await ensurePortFree();
  const assets = await createDistAssetService();
  const compilation = await build({ absWorkingDir: root, entryPoints: ["worker/index.mjs"], bundle: true,
    write: false, platform: "browser", format: "esm", target: "es2022", logLevel: "silent" });
  const script = compilation.outputFiles[0].text, runId = randomUUID();
  const cubeFile = resolve(root, `.cache/school-browser-cube-${runId}.stl`);
  let mf, outboundAttempts = 0, disposed = false;
  const temporaryFixture = `${fixturePath}.${runId}.tmp`;
  let resolveDone;
  const done = new Promise((finish) => { resolveDone = finish; });
  async function dispose() {
    if (disposed) return;
    disposed = true;
    try { if (mf) await mf.dispose(); }
    finally {
      // Only this run's generated file is eligible for cleanup, not another run.
      try {
        const saved = JSON.parse(await readFile(fixturePath, "utf8"));
        if (saved.runId === runId) await unlink(fixturePath);
      } catch (error) { if (error.code !== "ENOENT") console.warn("[school-browser] Could not clean this run's fixture metadata"); }
      try { await unlink(temporaryFixture); } catch (error) { if (error.code !== "ENOENT") console.warn("[school-browser] Could not clean this run's temporary fixture metadata"); }
      try { await unlink(cubeFile); } catch (error) { if (error.code !== "ENOENT") console.warn("[school-browser] Could not clean this run's cube fixture"); }
      console.log(`[school-browser] STOPPED (ephemeral storage; outbound attempts blocked: ${outboundAttempts})`);
      resolveDone();
    }
  }
  try {
    mf = new Miniflare(convertV4MiniflareOptions({ name: "school-browser", host, port, modules: true, script,
      compatibilityDate: "2026-09-29", log: new Log(LogLevel.WARN), cf: false, telemetry: { enabled: false },
      bindings: { APP_ORIGIN: origin, GOOGLE_CLIENT_ID: "browser-fixture-not-google.apps.googleusercontent.com",
        TEACHER_GOOGLE_SUBS: "browser-fixture-not-google-teacher" },
      d1Databases: { DB: randomUUID() }, r2Buckets: { STL_BUCKET: `browser-fixture-${randomUUID()}` },
      durableObjects: { SCHOOL_ROOMS: { className: "SchoolRoom", useSQLite: true } },
      serviceBindings: { ASSETS: assets.fetch },
      outboundService: async () => { outboundAttempts++; return new Response("External requests disabled by local browser gate", { status: 503 }); },
    }));
    const runtimeUrl = String(await mf.ready);
    const db = await mf.getD1Database("DB");
    const migration = await readFile(resolve(root, "migrations/0001_school_worlds.sql"), "utf8");
    for (const sql of migration.split(";").map((part) => part.trim()).filter(Boolean)) await db.prepare(sql).run();
    const teacher = await seedFixturePerson(db, "teacher", 0), students = [];
    for (let i = 0; i < LIMITS.students; i++) students.push(await seedFixturePerson(db, "student", i + 1));
    // A second temporary session for the same identity exercises logout/relogin
    // without pretending to verify the external Google credential exchange.
    const reloginToken = randomToken(), reloginCsrf = randomToken();
    await db.prepare("INSERT INTO school_sessions(token_hash,user_id,csrf,expires_at,created_at) VALUES(?,?,?,?,?)")
      .bind(digest(reloginToken), students[0].id, reloginCsrf, students[0].expiresAt, Math.floor(Date.now() / 1000)).run();
    const studentRelogin = { ...students[0], csrf: reloginCsrf, tokenHash: digest(reloginToken),
      cookie: `__Host-school-session=${reloginToken}`,
      browserCookie: { ...students[0].browserCookie, value: reloginToken } };
    // Actual production API creates the room with its normal authorization/CSRF
    // rules. Students remain unjoined to test the real invite + join UI.
    const response = await mf.dispatchFetch(`${origin}/api/worlds`, { method: "POST", headers: {
      Origin: origin, Cookie: teacher.cookie, "X-CSRF-Token": teacher.csrf, "Content-Type": "application/json",
    }, body: JSON.stringify({ name: "ローカル検証用 岡崎教室" }) });
    const result = await response.json();
    if (response.status !== 201 || !result.world?.id || !result.world.joinCode) throw Error(`Fixture room creation failed (${response.status})`);
    const cubeFixture = await createBrowserCubeFixture(assets), cube = cubeFixture.bytes;
    const fixtures = { runId, origin, runtimeUrl, createdAt: new Date().toISOString(),
      ephemeralAuthenticationFixtures: true, realGoogleLoginVerified: false, externalWorkerNetworkDisabled: true,
      teacher, student: students[0], studentRelogin, otherStudent: students[1], students,
      world: result.world, inviteURL: schoolInviteURL(origin, result.world.joinCode),
      cubeFile, cube: { sha256: cubeFixture.sha256, triangles: 12, upAxis: "y", units: "m", groundPositions: cubeFixture.groundPositions },
      workerBundleSha256: digest(script), distManifestSha256: assets.manifestSha256,
      distFileCount: assets.fileCount, distBytes: assets.bytes,
      notVerified: ["real Google OAuth exchange", "Cloudflare production bindings", "physical Quest", "classroom devices and network"] };
    await mkdir(dirname(fixturePath), { recursive: true });
    await writeFile(cubeFile, cube, { mode: 0o600 });
    await writeFile(temporaryFixture, `${JSON.stringify(fixtures, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryFixture, fixturePath);
    console.log(JSON.stringify({ ready: true, origin, runtime: "real Miniflare/workerd",
      miniflareVersion: require("miniflare/package.json").version, workerdVersion: require("workerd/package.json").version,
      workerBundleSha256: fixtures.workerBundleSha256, distManifestSha256: assets.manifestSha256,
      distFileCount: assets.fileCount, fixtureFile: relative(root, fixturePath),
      temporaryUsers: students.length + 1, studentsInitiallyJoined: 0, outboundNetworkDisabled: true }, null, 2));
    return { origin, done, dispose };
  } catch (error) { await dispose(); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let server;
  try {
    server = await startSchoolBrowserServer();
    const stop = () => { server.dispose().catch(() => { console.error("[school-browser] Runtime cleanup failed"); process.exitCode = 1; }); };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    await server.done;
  } catch (error) {
    console.error(`[school-browser] Failed: ${error.message}`); process.exitCode = 1;
  }
}
