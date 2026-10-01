import test from "node:test";
import assert from "node:assert/strict";
import { createSchoolClient, parseSchoolInvite, schoolInviteURL } from "../src/school-client.js";

const WORLD = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ASSET = "33333333-3333-4333-8333-333333333333";
const USER = { id: "44444444-4444-4444-8444-444444444444", role: "teacher", name: "先生", color: "#4a90e2" };
const world = (id = WORLD) => ({ id, name: "授業", joinCode: "ABCDEFGHIJKL" });
const snapshot = (id = WORLD, revision = 0) => ({ world: world(id), revision, assets: [], objects: [], participants: [], snapshots: [] });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const tick = async () => { await new Promise((resolve) => setImmediate(resolve)); };
function harness() {
  const calls = [], timers = new Map(), intervals = new Map(), sockets = [];
  let clock = 1000, serial = 0, signedIn = false;
  const routes = new Map();
  class FakeSocket {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(data) { if (this.readyState !== 1) throw new Error("closed"); this.sent.push(JSON.parse(data)); }
    close(code = 1000, reason = "") { this.readyState = 3; this.onclose?.({ code, reason }); }
    open(id = WORLD) { this.readyState = 1; this.onopen?.(); this.message({ type: "state", ...snapshot(id) }); }
    message(data) { this.onmessage?.({ data: JSON.stringify(data) }); }
  }
  const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname, key = `${options.method} ${path}`;
    calls.push({ path, ...options });
    if (routes.has(key)) { const route = routes.get(key); return typeof route === "function" ? route(options) : route; }
    if (path === "/api/config") return response({ configured: true, googleClientId: "123-example.apps.googleusercontent.com" });
    if (path === "/api/session") return response(signedIn ? { user: USER, csrf: "private-user-csrf" } : { user: null, csrf: "private-csrf", nonce: "private-nonce" });
    if (path === "/api/auth/google") { signedIn = true; return response({ user: USER, csrf: "private-user-csrf" }); }
    if (path === "/api/auth/logout") { signedIn = false; return response({ ok: true }); }
    if (path === "/api/worlds" && options.method === "GET") return response({ worlds: [world()] });
    if (path.endsWith("/state")) return response(snapshot(path.split("/")[3]));
    if (path.endsWith("/assets") && options.method === "POST") return response({ asset: { id: ASSET, ownerId: USER.id, name: "作品.stl", sha256: "abc", bytes: 3, upAxis: "z", units: "mm" } }, 201);
    if (path.endsWith(`/assets/${ASSET}`)) return new Response(new Uint8Array([1, 2, 3]));
    return response({ error: "not_found" }, 404);
  };
  const client = createSchoolClient({ origin: "https://metaquest001.gigach.net", fetchImpl, WebSocketImpl: FakeSocket, now: () => clock,
    setTimeoutImpl: (fn, delay) => { const id = ++serial; timers.set(id, { fn, delay }); return id; }, clearTimeoutImpl: (id) => timers.delete(id),
    setIntervalImpl: (fn, delay) => { const id = ++serial; intervals.set(id, { fn, delay }); return id; }, clearIntervalImpl: (id) => intervals.delete(id) });
  const authenticate = async () => { await client.init(); await client.login("credential-not-stored"); };
  const join = async () => { await authenticate(); await client.openWorld(WORLD); sockets.at(-1).open(); };
  return { client, calls, routes, response, timers, intervals, sockets, authenticate, join, advance: (value) => { clock += value; }, setSignedIn: (value) => { signedIn = value; } };
}

test("invite URLs use a fragment, not query/referrer, and never trigger autojoin", async () => {
  assert.equal(parseSchoolInvite("https://example.test/?join=ABCDEFGHIJKL"), null);
  assert.equal(parseSchoolInvite("https://example.test/#join=abcdefghijkl"), "ABCDEFGHIJKL");
  assert.equal(parseSchoolInvite("https://example.test/#join=<script>"), null);
  assert.equal(schoolInviteURL("https://metaquest001.gigach.net/?tracking=x", "abcdefghijkl"), "https://metaquest001.gigach.net/#join=ABCDEFGHIJKL");
  assert.throws(() => schoolInviteURL("https://example.test", "bad"), /invalid_join_code/);
  const h = harness(); await h.client.init(); assert.equal(h.calls.some((call) => call.path.endsWith("/join")), false); h.client.destroy();
});
test("guest initialization keeps VR usable and hides nonce, CSRF and credential from state", async () => {
  const h = harness(); const state = await h.client.init();
  assert.equal(state.connection, "guest"); assert.equal(state.user, null);
  assert.equal(JSON.stringify(state).includes("private-"), false);
  const setup = await h.client.prepareGoogleLogin(); assert.equal(setup.nonce, "private-nonce");
  assert.match(setup.clientId, /apps.googleusercontent.com$/);
  assert.equal(h.calls.every((call) => call.credentials === "same-origin"), true);
  assert.equal(h.calls.every((call) => call.cache === "no-store"), true);
  await assert.rejects(h.client.openWorld(WORLD), /login_required/);
  assert.throws(() => h.client.editObject("object.create", {}), /login_required/);
  h.client.destroy();
});
test("an unavailable or unconfigured service is a safe guest state, not a base-view failure", async () => {
  const h = harness(); h.routes.set("GET /api/config", h.response({ configured: false }));
  assert.equal((await h.client.init()).error, "school_not_configured");
  assert.equal(h.calls.length, 1);
  await assert.rejects(h.client.prepareGoogleLogin(), /school_not_configured/); h.client.destroy();
  const other = harness(); other.routes.set("GET /api/config", () => { throw new Error("network"); });
  assert.equal((await other.client.init()).connection, "guest"); other.client.destroy();
});
test("login uses server challenge and opaque cookie; avatar/previous worlds remain same-user", async () => {
  const h = harness(); await h.authenticate();
  const login = h.calls.find((call) => call.path === "/api/auth/google");
  assert.deepEqual(JSON.parse(login.body), { credential: "credential-not-stored", csrf: "private-csrf" });
  assert.equal(h.client.getState().user.id, USER.id); assert.equal(h.client.getState().worlds[0].id, WORLD);
  const copy = h.client.getState(); copy.user.name = "changed outside"; copy.worlds.length = 0;
  assert.equal(h.client.getState().user.name, "先生"); assert.equal(h.client.getState().worlds.length, 1);
  assert.equal(JSON.stringify(h.client.getState()).includes("credential-not-stored"), false);
  h.client.destroy();
});
test("participant single pose deltas merge into full roster and only full WS state increments snapshotSeq", async () => {
  const h = harness(), events = []; h.client.subscribe((_, event) => events.push(event)); await h.join();
  const ws = h.sockets[0];
  ws.message({ type: "participants", participants: [{ id: "one", name: "一", position: [1, 2, 3] }, { id: "two", name: "二", position: [4, 5, 6] }] });
  const sequence = h.client.getState().snapshotSeq;
  ws.message({ type: "pose", participant: { id: "one", name: "一", position: [7, 8, 9] } });
  assert.equal(h.client.getState().participants.length, 2);
  assert.deepEqual(h.client.getState().participants[0].position, [7, 8, 9]);
  assert.equal(h.client.getState().participants[1].id, "two"); assert.equal(h.client.getState().snapshotSeq, sequence);
  assert.equal(events.at(-1), "pose");
  ws.message({ type: "state", ...snapshot(WORLD, 2) }); assert.equal(h.client.getState().snapshotSeq, sequence + 1);
  ws.message({ type: "state", ...snapshot(WORLD, 1) }); assert.equal(h.client.getState().snapshotSeq, sequence + 1);
  h.client.destroy();
});
test("pose sends are finite, bounded <=8Hz; heartbeat is exactly20s and clears on leaving", async () => {
  const h = harness(); await h.join();
  assert.equal([...h.intervals.values()][0].delay, 20000);
  assert.equal(h.client.sendPose({ position: [1, 2, 3], yaw: 0 }), true);
  assert.equal(h.client.sendPose({ position: [1, 2, 3], yaw: 0 }), false);
  h.advance(124); assert.equal(h.client.sendPose({ position: [1, 2, 3], yaw: 0 }), false);
  h.advance(1); assert.equal(h.client.sendPose({ position: [1, 2, 3], yaw: 0 }), true);
  h.advance(125); assert.equal(h.client.sendPose({ position: [Infinity, 2, 3], yaw: 0 }), false);
  const packets = h.sockets[0].sent; assert.deepEqual(packets.map((value) => value.seq), [0, 1]);
  h.client.leaveWorld(); assert.equal(h.intervals.size, 0); assert.equal(h.client.sendPose({ position: [1, 2, 3], yaw: 0 }), false); h.client.destroy();
});
test("server-revision-owned editing resolves ack, while caller cannot override authority fields", async () => {
  const h = harness(); await h.join(); const ws = h.sockets[0];
  const edit = h.client.editObject("object.create", { assetId: ASSET, position: [1, 2, 3], revision: 999, requestId: "evil", type: "object.delete" });
  await tick(); const packet = ws.sent.at(-1);
  assert.equal(packet.type, "object.create"); assert.equal(packet.revision, 0); assert.notEqual(packet.requestId, "evil");
  ws.message({ type: "objects", revision: 1, objects: [{ id: OTHER }] });
  ws.message({ type: "ack", requestId: packet.requestId, revision: 1, id: OTHER });
  assert.equal((await edit).id, OTHER); assert.equal(h.client.getState().revision, 1); h.client.destroy();
});
test("edit conflicts reject visibly and refresh authoritative state without automatic overwrite", async () => {
  const h = harness(); await h.join(); const ws = h.sockets[0];
  h.routes.set(`GET /api/worlds/${WORLD}/state`, h.response(snapshot(WORLD, 5)));
  const edit = h.client.editObject("object.update", { id: OTHER }); await tick();
  const packet = ws.sent.at(-1); ws.message({ type: "error", error: "stale_revision", requestId: packet.requestId, revision: 5 });
  await assert.rejects(edit, /stale_revision/); await tick();
  assert.equal(h.client.getState().revision, 5); assert.equal(h.client.getState().error, "stale_revision");
  assert.equal(ws.sent.filter((value) => value.type.startsWith("object.")).length, 1); h.client.destroy();
});
test("room changes reject pending commands and ignore stale socket state/errors", async () => {
  const h = harness(); await h.join(); const ws = h.sockets[0];
  const edit = h.client.editObject("object.create", { assetId: ASSET }); await tick();
  const rejection = assert.rejects(edit, /room_changed/);
  await h.client.openWorld(OTHER); await rejection; h.sockets.at(-1).open(OTHER);
  ws.message({ type: "state", ...snapshot(WORLD, 90) });
  ws.message({ type: "error", error: "login_required" });
  assert.equal(h.client.getState().world.id, OTHER); assert.equal(h.client.getState().user.id, USER.id); h.client.destroy();
});
test("HTTP401 clears identity, membership and editing; signout does not revoke Google's shared app", async () => {
  const h = harness(); await h.join();
  h.routes.set(`GET /api/worlds/${WORLD}/assets/${ASSET}`, h.response({ error: "login_required" }, 401));
  await assert.rejects(h.client.downloadAsset(ASSET), /login_required/);
  assert.equal(h.client.getState().user, null); assert.equal(h.client.getState().world, null); assert.equal(h.intervals.size, 0);
  h.routes.delete(`GET /api/worlds/${WORLD}/assets/${ASSET}`); await h.client.refreshSession(); await h.client.logout();
  assert.equal(h.client.getState().connection, "guest"); assert.equal(h.calls.some((call) => /revoke/.test(call.path)), false); h.client.destroy();
});
test("uploaded assets appear immediately; UTF8 filename is encoded and raw bytes are not JSON", async () => {
  const h = harness(); await h.join(); const bytes = new Uint8Array([1, 2, 3]).buffer;
  const asset = await h.client.uploadAsset({ buffer: bytes, name: "作品.stl", upAxis: "z", units: "mm" });
  assert.equal(asset.id, ASSET); assert.equal(h.client.getState().assets[0].id, ASSET);
  const upload = h.calls.find((call) => call.path.endsWith("/assets"));
  assert.equal(upload.headers["Content-Type"], "model/stl"); assert.equal(upload.headers["X-Filename"], encodeURIComponent("作品.stl"));
  assert.equal(upload.headers["X-CSRF-Token"], "private-user-csrf"); assert.equal(upload.body, bytes);
  assert.deepEqual(new Uint8Array(await h.client.downloadAsset(ASSET)), new Uint8Array([1, 2, 3])); h.client.destroy();
});
test("a delayed upload cannot contaminate the next room's assets", async () => {
  const h = harness(); await h.join(); const slow = deferred();
  h.routes.set(`POST /api/worlds/${WORLD}/assets`, () => slow.promise);
  const upload = h.client.uploadAsset({ buffer: new ArrayBuffer(1), name: "a.stl", upAxis: "z", units: "mm" });
  const rejected = assert.rejects(upload, /room_changed/); await h.client.openWorld(OTHER); h.sockets.at(-1).open(OTHER);
  slow.resolve(h.response({ asset: { id: ASSET } })); await rejected;
  assert.equal(h.client.getState().assets.length, 0); h.client.destroy();
});
test("1000 duplicate-device close never reconnects indefinitely; unexpected close is bounded backoff", async () => {
  const h = harness(); await h.join(); h.sockets[0].close(1000, "connected in another tab");
  assert.equal(h.client.getState().error, "connected_elsewhere"); assert.equal(h.timers.size, 0); h.client.destroy();
  const other = harness(); await other.join(); other.sockets[0].close(1006);
  assert.equal(other.client.getState().connection, "reconnecting"); assert.equal([...other.timers.values()][0].delay, 1000);
  other.client.leaveWorld(); assert.equal(other.timers.size, 0); other.client.destroy();
});
test("logout rejects pending edit and clears all local identity/object state", async () => {
  const h = harness(); await h.join(); const pending = h.client.editObject("object.create", { assetId: ASSET }); await tick();
  const rejected = assert.rejects(pending, /signed_out/); await h.client.logout(); await rejected;
  assert.equal(h.client.getState().user, null); assert.equal(h.client.getState().objects.length, 0); assert.equal(h.client.getState().worlds.length, 0); h.client.destroy();
});
test("another tab's changed cookie identity cannot inherit the old room connection", async () => {
  const h = harness(); await h.join();
  h.routes.set("GET /api/session", h.response({ user: { ...USER, id: OTHER, role: "student" }, csrf: "new-private-csrf" }));
  await h.client.refreshSession();
  assert.equal(h.client.getState().user.id, OTHER); assert.equal(h.client.getState().world, null);
  assert.equal(h.sockets[0].readyState, 3); assert.equal(h.client.getState().connection, "idle"); h.client.destroy();
});
test("ack timeout rejects and rereads state, never resubmits an ambiguous mutation", async () => {
  const h = harness(); await h.join(); const ws = h.sockets[0];
  const pending = h.client.editObject("object.create", { assetId: ASSET }); await tick();
  const rejected = assert.rejects(pending, /edit_timeout/);
  const timeout = [...h.timers.values()].find((item) => item.delay === 12000); assert.ok(timeout); timeout.fn();
  await rejected; await tick();
  assert.equal(ws.sent.filter((item) => item.type === "object.create").length, 1); h.client.destroy();
});
test("reconnect generation prevents a delayed old-room read from reopening after leave", async () => {
  const h = harness(); await h.join(); const slow = deferred();
  h.routes.set(`GET /api/worlds/${WORLD}/state`, () => slow.promise);
  h.sockets[0].close(1006); const retry = [...h.timers.values()].find((item) => item.delay === 1000); assert.ok(retry);
  const reopening = retry.fn(); h.client.leaveWorld(); slow.resolve(h.response(snapshot(WORLD)));
  await reopening; assert.equal(h.sockets.length, 1); assert.equal(h.client.getState().world, null); h.client.destroy();
});
test("a peer's new shared STL fetches missing metadata with coalescing and keeps newer revision", async () => {
  const h = harness(); await h.join(); const slow = deferred(), before = h.calls.length;
  h.routes.set(`GET /api/worlds/${WORLD}/state`, () => slow.promise);
  const ws = h.sockets[0]; ws.message({ type: "objects", revision: 1, objects: [{ id: OTHER, assetId: ASSET }] });
  ws.message({ type: "objects", revision: 2, objects: [{ id: OTHER, assetId: ASSET, position: [1, 2, 3] }] });
  assert.equal(h.calls.length, before + 1);
  slow.resolve(h.response({ ...snapshot(WORLD, 1), assets: [{ id: ASSET, sha256: "authoritative-hash" }], objects: [{ id: OTHER, assetId: ASSET }] }));
  await tick(); assert.equal(h.client.getState().assets[0].sha256, "authoritative-hash");
  assert.equal(h.client.getState().revision, 2); assert.deepEqual(h.client.getState().objects[0].position, [1, 2, 3]); h.client.destroy();
});
test("pose subscribers share one readonly snapshot without recopying immutable world objects", async () => {
  const h = harness(), first = [], second = [];
  h.client.subscribe((state, event) => { if (event === "pose") first.push(state); });
  h.client.subscribe((state, event) => { if (event === "pose") second.push(state); });
  await h.join(); const ws = h.sockets[0];
  ws.message({ type: "objects", revision: 1, objects: [{ id: OTHER, name: "shared" }] });
  ws.message({ type: "pose", participant: { id: USER.id, position: [1, 2, 3], yaw: 0 } });
  ws.message({ type: "pose", participant: { id: USER.id, position: [4, 5, 6], yaw: 0 } });
  assert.equal(first[0], second[0]); assert.equal(first[0].objects, first[1].objects);
  assert.equal(Object.isFrozen(first[0]), true); assert.equal(Object.isFrozen(first[0].participants), true);
  assert.throws(() => { first[0].objects[0].name = "tampered"; }, TypeError);
  assert.deepEqual(first[0].participants[0].position, [1, 2, 3]);
  assert.deepEqual(first[1].participants[0].position, [4, 5, 6]); h.client.destroy();
});
