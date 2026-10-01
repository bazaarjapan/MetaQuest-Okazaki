// Independent integration gate: real local workerd, not the Node unit-test mocks.
// Session fixtures are seeded into an ephemeral local D1 only. This deliberately
// does NOT claim Google OAuth, Cloudflare production or physical Quest acceptance.
// No Wrangler config, credentials, persistent database or external HTTP is used.
// API references: https://developers.cloudflare.com/workers/testing/miniflare/
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import { Log, LogLevel, Miniflare, convertV4MiniflareOptions } from "miniflare";
import WebSocket from "ws";
import { CORE_SOURCE_HASHES, loadCorePlacement } from "../worker/placement-source.mjs";
import { LIMITS } from "../worker/school-common.mjs";
import { normalizeSTLPositions, parseSTL } from "../src/stl-model.js";
import { validatePlacement } from "../src/placement.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const origin = "http://school-runtime.invalid";
const require = createRequire(import.meta.url);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const checks = [];
const sockets = [];
const assetReads = new Set();
const started = performance.now();
let mf;
let outboundAttempts = 0;
let report;
let runtimeUrl;

async function check(name, task) {
  const at = performance.now();
  const detail = await task();
  checks.push({ name, passed: true, milliseconds: Math.round(performance.now() - at), ...(detail ?? {}) });
  console.log(`[school-runtime] PASS ${name}`);
}
async function sourceAsset(request) {
  const path = new URL(request.url).pathname;
  const filename = path.startsWith("/city/") ? path.slice(6) : "";
  if (!Object.hasOwn(CORE_SOURCE_HASHES, filename)) return new Response(null, { status: 404 });
  const bytes = await readFile(new URL(`../public/city/${filename}`, import.meta.url));
  assert.equal(digest(bytes), CORE_SOURCE_HASHES[filename], `Original PLATEAU hash: ${filename}`);
  assetReads.add(filename);
  return new Response(bytes);
}
function cubeStl() {
  const vertices = [[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]];
  const faces = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[3,7,6],[3,6,2],[0,4,7],[0,7,3],[1,2,6],[1,6,5]];
  return new TextEncoder().encode(`solid runtime-cube\n${faces.map((face) => `facet normal 0 0 0\nouter loop\n${face.map((i) => `vertex ${vertices[i].join(" ")}`).join("\n")}\nendloop\nendfacet`).join("\n")}\nendsolid runtime-cube`);
}
async function actualEmptyGround(bytes) {
  const surfaces = await loadCorePlacement({ fetch: sourceAsset });
  const model = normalizeSTLPositions(parseSTL(bytes.buffer).positions, "y");
  for (let z = -350; z <= 350; z += 15) for (let x = -300; x <= 300; x += 15) {
    const result = validatePlacement({ positions: model.positions, position: [x,999,z], rotation: [0.3,0.5,0.2], scale: [0.5,0.5,0.5] }, surfaces);
    if (result.valid) return result;
  }
  throw Error("No verified empty PLATEAU ground for the rotated cube fixture");
}
async function seedPerson(db, role, number) {
  const id = randomUUID(), sessionToken = token(), csrf = token();
  const now = Math.floor(Date.now() / 1000), expiresAt = now + LIMITS.sessionSeconds;
  const avatar = { name: role === "teacher" ? "Runtime fixture teacher" : `Runtime fixture ${number}`, color: "#4a90e2" };
  // Test identities are deliberately non-Google, non-personal identifiers. Only
  // the hash of a cryptographically random session token enters the temporary DB.
  await db.batch([
    db.prepare("INSERT INTO school_users(id,google_sub,role,avatar_json,created_at) VALUES(?,?,?,?,?)")
      .bind(id, `runtime-fixture-${randomUUID()}`, role, JSON.stringify(avatar), now),
    db.prepare("INSERT INTO school_sessions(token_hash,user_id,csrf,expires_at,created_at) VALUES(?,?,?,?,?)")
      .bind(digest(sessionToken), id, csrf, expiresAt, now),
  ]);
  return { id, role, avatar, csrf, tokenHash: digest(sessionToken), cookie: `__Host-school-session=${sessionToken}` };
}
function requestOptions(person = null, data = null, options = {}) {
  return {
    method: options.method ?? (data === null ? "GET" : "POST"),
    headers: { Origin: origin, ...(person ? { Cookie: person.cookie, "X-CSRF-Token": person.csrf } : {}),
      ...(data !== null ? { "Content-Type": "application/json" } : {}), ...options.headers },
    ...(data !== null ? { body: JSON.stringify(data) } : {}),
  };
}
const fetchApi = (path, person = null, data = null, options = {}) => mf.dispatchFetch(`${origin}${path}`, requestOptions(person, data, options));
async function expectJson(path, person, data, expectedStatus = 200, options = {}) {
  const response = await fetchApi(path, person, data, options);
  const result = await response.json();
  assert.equal(response.status, expectedStatus, `${path}: ${JSON.stringify(result)}`);
  return result;
}
async function expectError(path, person, data, status, error, options = {}) {
  assert.equal((await expectJson(path, person, data, status, options)).error, error);
}
class Probe {
  constructor(socket, id) {
    this.socket = socket; this.id = id; this.messages = []; this.waiters = []; this.closed = null;
    socket.on("message", (bytes) => {
      let data;
      try { data = JSON.parse(bytes.toString()); } catch (error) { this.error = error; return; }
      this.messages.push(data);
      for (const waiter of [...this.waiters]) if (waiter.predicate(data)) waiter.resolve(data);
    });
    socket.on("close", (code, reason) => {
      this.closed = { code, reason: reason.toString() };
      for (const waiter of [...this.waiters]) waiter.reject(Error(`Fixture WebSocket closed (${code}): ${reason}`));
    });
    socket.on("error", (error) => {
      this.error = error;
      for (const waiter of [...this.waiters]) waiter.reject(error);
    });
    sockets.push(this);
  }
  wait(predicate, label, from = 0, timeoutMs = 15000) {
    const existing = this.messages.slice(from).find(predicate);
    if (existing) return Promise.resolve(existing);
    if (this.error) return Promise.reject(this.error);
    if (this.closed) return Promise.reject(Error(`${label}: fixture socket closed`));
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.waiters = this.waiters.filter((entry) => entry !== waiter); };
      const waiter = { predicate, resolve(value) { cleanup(); resolve(value); }, reject(error) { cleanup(); reject(error); } };
      const timer = setTimeout(() => waiter.reject(Error(`Timed out: ${label}`)), timeoutMs);
      this.waiters.push(waiter);
    });
  }
  send(value) { this.socket.send(typeof value === "string" ? value : JSON.stringify(value)); }
  async command(value, expected = "ack") {
    const from = this.messages.length;
    this.send(value);
    const response = await this.wait((packet) => packet.requestId === value.requestId && ["ack", "error"].includes(packet.type), value.type, from);
    assert.equal(response.type, expected, JSON.stringify(response));
    return response;
  }
  clear() { this.messages = []; }
  close() { try { if (this.socket.readyState === 1) this.socket.close(1000, "runtime test finished"); } catch { /* already closed */ } }
}
async function connect(worldId, person) {
  // Use real loopback TCP WebSockets against workerd. Override Host to the local
  // fixture origin so the Worker checks its real request URL and Origin, rather
  // than weakening requireOrigin or importing a logical server socket mock.
  const url = new URL(`/api/worlds/${worldId}/socket`, runtimeUrl); url.protocol = "ws:";
  const socket = new WebSocket(url, { headers: { Origin: origin, Host: new URL(origin).host, Cookie: person.cookie } });
  const probe = new Probe(socket, person.id);
  const initial = await probe.wait((packet) => packet.type === "state", "initial state");
  assert.equal(initial.world.id, worldId);
  return { probe, initial };
}
async function rejectedSocket(worldId, person, expectedStatus, expectedError) {
  const url = new URL(`/api/worlds/${worldId}/socket`, runtimeUrl); url.protocol = "ws:";
  const socket = new WebSocket(url, { headers: { Origin: origin, Host: new URL(origin).host, Cookie: person.cookie } });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.terminate(); reject(Error("Timed out: refused socket")); }, 15000);
    socket.on("error", (error) => { if (!socket.expectedRefusal) { clearTimeout(timer); reject(error); } });
    socket.on("open", () => { clearTimeout(timer); socket.close(); reject(Error("Excess identity unexpectedly upgraded")); });
    socket.on("unexpected-response", (_request, response) => {
      socket.expectedRefusal = true;
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("error", (error) => { clearTimeout(timer); socket.terminate(); reject(error); });
      response.on("end", () => {
        clearTimeout(timer); socket.terminate();
        try {
          assert.equal(response.statusCode, expectedStatus);
          assert.equal(JSON.parse(Buffer.concat(chunks).toString()).error, expectedError);
          resolve();
        } catch (error) { reject(error); }
      });
    });
  });
}
async function waitClosed(probe, code) {
  const until = performance.now() + 15000;
  while (!probe.closed && performance.now() < until) await delay(10);
  assert.equal(probe.closed?.code, code, `Expected real WebSocket close ${code}`);
}

try {
  const compilation = await build({ absWorkingDir: root, entryPoints: ["worker/index.mjs"],
    bundle: true, write: false, platform: "browser", format: "esm", target: "es2022", logLevel: "silent" });
  const script = compilation.outputFiles[0].text;
  // Wrangler currently installs Miniflare 5: its supported V4 converter adapts
  // the documented binding API to the new manifest/env configuration. Storage
  // has no resourcePersistencePath, so Miniflare owns and cleans temporary data.
  mf = new Miniflare(convertV4MiniflareOptions({ name: "school-runtime", host: "127.0.0.1", port: 0, modules: true, script,
    compatibilityDate: "2026-09-29", log: new Log(LogLevel.WARN),
    cf: false, telemetry: { enabled: false },
    bindings: { APP_ORIGIN: origin, GOOGLE_CLIENT_ID: "runtime-fixture.apps.googleusercontent.com", TEACHER_GOOGLE_SUBS: "runtime-fixture-teacher" },
    d1Databases: { DB: randomUUID() }, r2Buckets: { STL_BUCKET: `runtime-fixture-${randomUUID()}` },
    durableObjects: { SCHOOL_ROOMS: { className: "SchoolRoom", useSQLite: true } },
    serviceBindings: { ASSETS: sourceAsset },
    outboundService: async () => { outboundAttempts++; return new Response("External network disabled by runtime gate", { status: 503 }); },
  }));
  runtimeUrl = await mf.ready;
  const db = await mf.getD1Database("DB");
  const migration = await readFile(new URL("../migrations/0001_school_worlds.sql", import.meta.url), "utf8");
  for (const sql of migration.split(";").map((part) => part.trim()).filter(Boolean)) await db.prepare(sql).run();
  const teacher = await seedPerson(db, "teacher", 0), students = [];
  for (let i = 0; i < LIMITS.students; i++) students.push(await seedPerson(db, "student", i + 1));
  const extra = await seedPerson(db, "student", 31);
  let world, classroom, owner, object, checkpoint, poseRestoreCommit = null;
  const bytes = cubeStl(), empty = await actualEmptyGround(bytes);

  await check("real D1-backed sessions and API security boundary", async () => {
    assert.equal((await expectJson("/api/config", null, null)).configured, true);
    assert.equal((await expectJson("/api/session", teacher, null)).user.id, teacher.id);
    await expectError("/api/worlds", null, null, 401, "login_required");
    await expectError("/api/worlds", students[0], {}, 403, "teacher_required");
    await expectError("/api/worlds", teacher, {}, 403, "invalid_origin", { headers: { Origin: "https://other.invalid" } });
    await expectError("/api/worlds", teacher, {}, 403, "invalid_csrf", { headers: { "X-CSRF-Token": "wrong" } });
    world = (await expectJson("/api/worlds", teacher, { name: "Ephemeral runtime fixture classroom" }, 201)).world;
    await expectError(`/api/worlds/${world.id}/state`, extra, null, 403, "world_membership_required");
  });
  await check("30 simultaneous student joins and 31 real WebSocket connections", async () => {
    const joined = await Promise.all(students.map((person) => expectJson("/api/worlds/join", person, { code: world.joinCode })));
    assert.ok(joined.every((entry) => entry.world.id === world.id));
    classroom = await Promise.all([teacher, ...students].map((person) => connect(world.id, person)));
    assert.ok(classroom.every(({ initial }) => Object.hasOwn(initial, "restoreCommit") && initial.restoreCommit === null));
    owner = classroom[1].probe;
    const state = await expectJson(`/api/worlds/${world.id}/state`, teacher, null);
    assert.equal(state.participants.length, 31); assert.equal(new Set(state.participants.map((person) => person.id)).size, 31);
    await Promise.all(classroom.map(({ probe }) => probe.wait((packet) => packet.type === "participants" && packet.participants.length === 31, "all 31 participants")));
    return { realOpenSocketsInClassroom: 31 };
  });
  await check("32nd identity rejected independently by membership and live room caps", async () => {
    await expectError("/api/worlds/join", extra, { code: world.joinCode }, 409, "class_full");
    const count = await db.prepare("SELECT COUNT(*) AS n FROM school_members WHERE world_id=?").bind(world.id).first();
    assert.equal(count.n, 31);
    // Administrative fixture only: public join cannot create this excess member.
    // This probes the second, independent live-socket cap even with DB corruption.
    await db.prepare("INSERT INTO school_members(world_id,user_id,joined_at) VALUES(?,?,?)").bind(world.id, extra.id, Math.floor(Date.now() / 1000)).run();
    await rejectedSocket(world.id, extra, 409, "room_full");
    await db.prepare("DELETE FROM school_members WHERE world_id=? AND user_id=?").bind(world.id, extra.id).run();
  });
  await check("31-client bounded pose fan-out uses compact deltas", async () => {
    for (const { probe } of classroom) probe.clear();
    let deliveries = 0, largestBytes = 0;
    for (let round = 1; round <= 5; round++) {
      const marks = classroom.map(({ probe }) => probe.messages.length);
      classroom.forEach(({ probe }, index) => probe.send({ type: "pose", position: [index * 2 + round, 40, round * 2], yaw: round / 10, seq: round, restoreCommit: poseRestoreCommit }));
      await Promise.all(classroom.map(({ probe }, index) => probe.wait((packet) => packet.type === "pose" && packet.participant.id === students.at(-1).id && packet.participant.position[2] === round * 2, "pose fan-out", marks[index])));
      // Wait for every sender at every endpoint; arrival order is not assumed.
      await Promise.all(classroom.flatMap(({ probe }, index) => [teacher, ...students].map((person) => probe.wait((packet) => packet.type === "pose" && packet.participant.id === person.id && packet.participant.position[2] === round * 2, "each pose delivery", marks[index]))));
      for (const { probe } of classroom) for (const packet of probe.messages.filter((entry) => entry.type === "pose" && entry.participant.position[2] === round * 2)) {
        assert.equal("participants" in packet, false); assert.equal("objects" in packet, false);
        largestBytes = Math.max(largestBytes, Buffer.byteLength(JSON.stringify(packet))); deliveries++;
      }
      await delay(120);
    }
    assert.equal(deliveries, 31 * 31 * 5);
    return { sentPosePackets: 155, verifiedPoseDeliveries: deliveries, largestDeltaBytes: largestBytes, scope: "bounded local fan-out, not classroom network/FPS benchmark" };
  });
  await check("real private R2 STL upload/download and server-authoritative placement", async () => {
    const response = await mf.dispatchFetch(`${origin}/api/worlds/${world.id}/assets`, { method: "POST", headers: {
      Origin: origin, Cookie: students[0].cookie, "X-CSRF-Token": students[0].csrf,
      "Content-Type": "model/stl", "X-Up-Axis": "y", "X-Units": "m", "X-Filename": "runtime-cube.stl",
    }, body: bytes });
    const uploaded = await response.json(); assert.equal(response.status, 201, JSON.stringify(uploaded));
    const asset = uploaded.asset; assert.equal(asset.ownerId, students[0].id); assert.equal(asset.sha256, digest(bytes));
    const download = await fetchApi(`/api/worlds/${world.id}/assets/${asset.id}`, students[1]);
    assert.equal(download.status, 200); assert.equal(download.headers.get("Cache-Control"), "private, no-store");
    assert.deepEqual(new Uint8Array(await download.arrayBuffer()), bytes);
    const id = randomUUID(), command = { type: "object.create", requestId: randomUUID(), revision: 0, id,
      assetId: asset.id, ownerId: teacher.id, valid: true, position: [empty.position[0],999,empty.position[2]], rotation: [0.3,0.5,0.2], scale: [0.5,0.5,0.5] };
    const ack = await owner.command(command); assert.equal(ack.revision, 1);
    await Promise.all(classroom.map(({ probe }) => probe.wait((packet) => packet.type === "objects" && packet.revision === 1 && packet.objects[0]?.id === id, "shared object")));
    object = (await expectJson(`/api/worlds/${world.id}/state`, teacher, null)).objects[0];
    assert.equal(object.ownerId, students[0].id); assert.deepEqual(object.rotation, command.rotation); assert.deepEqual(object.scale, command.scale);
    assert.notEqual(object.position[1], 999); assert.deepEqual(object.position, empty.position);
    assert.equal((await owner.command(command)).revision, 1);
    const attack = await classroom[2].probe.command({ type: "object.delete", requestId: randomUUID(), revision: 1, id }, "error");
    assert.equal(attack.error, "object_owner_required");
    const teacherAttack = await classroom[0].probe.command({ type: "object.delete", requestId: randomUUID(), revision: 1, id }, "error");
    assert.equal(teacherAttack.error, "object_owner_required");
    return { originalSTLHashVerified: true, actualPLATEAUGroundSnapped: true, simultaneousObjectRecipients: 31 };
  });
  await check("teacher-only D1 checkpoint, restore and stale revision rejection", async () => {
    await expectError(`/api/worlds/${world.id}/save`, students[0], {}, 403, "teacher_required");
    await expectError(`/api/worlds/${world.id}/restore`, students[0], { snapshotId: randomUUID(), revision: 1 }, 403, "teacher_required");
    checkpoint = await expectJson(`/api/worlds/${world.id}/save`, teacher, {});
    assert.equal(checkpoint.revision, 1);
    const row = await db.prepare("SELECT state_json FROM school_snapshots WHERE id=?").bind(checkpoint.id).first();
    assert.deepEqual(JSON.parse(row.state_json).objects[0], object);
    await delay(260);
    assert.equal((await owner.command({ type: "object.delete", requestId: randomUUID(), revision: 1, id: object.id })).revision, 2);
    const movedAfterCheckpoint = [800,50,300];
    owner.send({ type: "pose", position: movedAfterCheckpoint, yaw: .8, seq: 6, restoreCommit: poseRestoreCommit });
    await Promise.all(classroom.map(({ probe }) => probe.wait((packet) => packet.type === "pose" &&
      packet.participant.id === students[0].id && packet.participant.position[0] === movedAfterCheckpoint[0], "unsaved movement after checkpoint")));
    const restored = await expectJson(`/api/worlds/${world.id}/restore`, teacher, { snapshotId: checkpoint.id, revision: 2 });
    assert.equal(restored.revision, 3);
    const restoredPackets = await Promise.all(classroom.map(({ probe }) => probe.wait((packet) => packet.type === "state" && packet.revision === 3 && packet.objects[0]?.id === object.id, "restored shared state")));
    poseRestoreCommit = restoredPackets[0].restoreCommit;
    assert.equal(typeof poseRestoreCommit, "string");
    assert.ok(restoredPackets.every((packet) => packet.restoreCommit === poseRestoreCommit));
    const restoredState = await expectJson(`/api/worlds/${world.id}/state`, teacher, null);
    assert.deepEqual(restoredState.participants.find((person) => person.id === students[0].id).position, [7,40,10]);
    assert.deepEqual((await expectJson(`/api/worlds/${world.id}/state`, teacher, null)).objects[0], object);
    const stale = await owner.command({ type: "object.delete", requestId: randomUUID(), revision: 1, id: object.id }, "error");
    assert.equal(stale.error, "stale_revision");
  });
  await check("delayed pre-restore pose is rejected and reconnect keeps the restored generation", async () => {
    const previous = classroom[1].probe, marks = classroom.map(({ probe }) => probe.messages.length);
    // The packet was built before restore and is deliberately released afterward
    // over a real TCP socket, never stamped with the newly observed generation.
    previous.send({ type: "pose", position: [800,50,300], yaw: .8, seq: 7, restoreCommit: null });
    await previous.wait((packet) => packet.type === "error" && packet.error === "stale_pose_epoch", "old in-flight generation rejected", marks[1]);
    const state = await expectJson(`/api/worlds/${world.id}/state`, teacher, null);
    assert.equal(state.restoreCommit, poseRestoreCommit);
    assert.deepEqual(state.participants.find((person) => person.id === students[0].id).position, [7,40,10]);
    assert.ok(classroom.every(({ probe }, index) => !probe.messages.slice(marks[index]).some((packet) => packet.type === "pose")));
    const replacement = await connect(world.id, students[0]); await waitClosed(previous, 1000);
    assert.equal(replacement.initial.restoreCommit, poseRestoreCommit);
    assert.deepEqual(replacement.initial.participants.find((person) => person.id === students[0].id).position, [7,40,10]);
    classroom[1] = replacement; owner = replacement.probe;
    return { delayedOldEpochRejected: true, restoredPoseRetainedOnReconnect: true };
  });
  await check("duplicate identity reconnect preserves avatar, owned object and latest unsaved live pose", async () => {
    const previous = classroom[1].probe;
    await delay(120);
    const latestLive = [8,41,11];
    previous.send({ type: "pose", position: latestLive, yaw: .65, seq: 7, restoreCommit: poseRestoreCommit });
    await Promise.all(classroom.map(({ probe }) => probe.wait((packet) => packet.type === "pose" &&
      packet.participant.id === students[0].id && packet.participant.position[0] === latestLive[0], "current pose before reconnect")));
    const replacement = await connect(world.id, students[0]);
    await waitClosed(previous, 1000);
    assert.deepEqual(replacement.initial.objects[0], object);
    const avatar = replacement.initial.participants.find((person) => person.id === students[0].id);
    assert.equal(avatar.name, students[0].avatar.name); assert.equal(avatar.color, students[0].avatar.color);
    assert.deepEqual(avatar.position, latestLive); assert.equal(avatar.yaw, .65);
    classroom[1] = replacement; owner = replacement.probe;
    const state = await expectJson(`/api/worlds/${world.id}/state`, teacher, null);
    assert.equal(state.participants.length, 31); assert.equal(state.participants.filter((person) => person.id === students[0].id).length, 1);
  });
  await check("actual Durable Object eviction wakes durable state and 31 hibernating sockets", async () => {
    await mf.unsafeEvictDurableObject("school-runtime", "SchoolRoom", { name: world.id, webSockets: "hibernate" });
    const state = await expectJson(`/api/worlds/${world.id}/state`, teacher, null);
    assert.equal(state.revision, 3); assert.deepEqual(state.objects[0], object);
    assert.equal(state.participants.length, 31);
    const marks = classroom.map(({ probe }) => probe.messages.length);
    owner.send({ type: "pose", position: [9,42,12], yaw: 0.6, seq: 6, restoreCommit: poseRestoreCommit });
    await Promise.all(classroom.map(({ probe }, index) => probe.wait((packet) => packet.type === "pose" && packet.participant.id === students[0].id && packet.participant.position[1] === 42, "post-hibernation delivery", marks[index])));
    assert.ok(classroom.every(({ probe }) => !probe.closed && !probe.error));
    return { liveSocketRecipientsAfterActualEviction: 31 };
  });
  await check("separate Durable Object class world does not leak objects or participants", async () => {
    const other = (await expectJson("/api/worlds", teacher, { name: "Isolated runtime fixture" }, 201)).world;
    const isolated = await connect(other.id, teacher);
    assert.equal(isolated.initial.participants.length, 1); assert.equal(isolated.initial.objects.length, 0);
    await expectError(`/api/worlds/${other.id}/state`, students[0], null, 403, "world_membership_required");
    assert.equal((await expectJson(`/api/worlds/${world.id}/state`, teacher, null)).participants.length, 31);
    isolated.probe.close();
  });
  await check("expired real D1 session closes live socket and rejects private API", async () => {
    const victim = students.at(-1), probe = classroom.at(-1).probe;
    await db.prepare("UPDATE school_sessions SET expires_at=? WHERE token_hash=?").bind(Math.floor(Date.now() / 1000) - 1, victim.tokenHash).run();
    probe.send({ type: "pose", position: [0,40,0], yaw: 0, seq: 6, restoreCommit: poseRestoreCommit });
    await waitClosed(probe, 1008);
    await expectError(`/api/worlds/${world.id}/state`, victim, null, 401, "login_required");
    assert.equal((await expectJson(`/api/worlds/${world.id}/state`, teacher, null)).participants.length, 30);
  });
  assert.equal(outboundAttempts, 0, "Runtime gate must not attempt external network requests");
  report = { passed: true, runtime: "Miniflare/workerd with real loopback TCP WebSockets, SQLite D1, R2 and SQLite Durable Objects",
    miniflareVersion: require("miniflare/package.json").version, nodeVersion: process.version,
    workerdVersion: require("workerd/package.json").version, esbuildVersion: require("esbuild/package.json").version, wsVersion: require("ws/package.json").version,
    workerBundleSha256: digest(script), ephemeralAuthenticationFixtures: true, outboundNetworkDisabled: true,
    originalPLATEAUFilesVerified: [...assetReads].sort(), checks, milliseconds: Math.round(performance.now() - started),
    notVerified: ["real Google OAuth exchange", "production Cloudflare bindings", "classroom Wi-Fi/Internet capacity", "30 physical devices/Quest FPS", "physical Quest comfort"] };
} catch (error) {
  console.error(`[school-runtime] FAIL ${error.stack ?? error}`);
  process.exitCode = 1;
} finally {
  for (const probe of sockets) probe.close();
  // Finish real close handshakes before terminating workerd. Killing a runtime
  // while its accepted WebSocketPair endpoints are closing can reset its local
  // transport on Windows; that is an error, not a successful verification.
  const closeDeadline = performance.now() + 5000;
  while (sockets.some((probe) => !probe.closed) && performance.now() < closeDeadline) await delay(20);
  if (sockets.some((probe) => !probe.closed)) {
    console.error("[school-runtime] FAIL WebSocket teardown did not finish");
    process.exitCode = 1;
  }
  await delay(100);
  if (sockets.some((probe) => probe.error)) {
    console.error("[school-runtime] FAIL A real WebSocket reported an error");
    process.exitCode = 1;
  }
  if (mf) await mf.dispose();
}
if (!process.exitCode && report) console.log(JSON.stringify({ ...report, teardownCompleted: true }, null, 2));
