import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import worker, { handleSchoolRequest, roomRequest, SchoolRoom } from "../worker/index.mjs";
import { CORE_SOURCE_HASHES, loadCorePlacement } from "../worker/placement-source.mjs";
import { LIMITS, base64url, sha256 } from "../worker/school-common.mjs";
import { roleFromClaims, verifyGoogleToken } from "../worker/google-auth.mjs";
import { all, createSession, createUser, createWorld, first, joinWorld, requestSession, run, updateAvatar } from "../worker/school-store.mjs";
import { parseSTL, normalizeSTLPositions, STL_LIMITS } from "../src/stl-model.js";
import { validatePlacement, createSurfaceIndex } from "../src/placement.js";

const origin = "https://metaquest001.gigach.net", clientId = "test.apps.googleusercontent.com";
const migration = await readFile(new URL("../migrations/0001_school_worlds.sql", import.meta.url), "utf8");
const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const jwk = { ...await crypto.subtle.exportKey("jwk", keys.publicKey), kid: "fixture-key", alg: "RS256" };
async function signedToken(claims, header = { alg: "RS256", kid: jwk.kid }) {
  const prefix = `${base64url(new TextEncoder().encode(JSON.stringify(header)))}.${base64url(new TextEncoder().encode(JSON.stringify(claims)))}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(prefix));
  return `${prefix}.${base64url(signature)}`;
}
function sqliteD1() {
  const sqlite = new DatabaseSync(":memory:"); sqlite.exec(migration);
  const db = {
    prepare(sql) {
      return { bind(...args) {
        const statement = sqlite.prepare(sql);
        const runSync = () => { const meta = statement.run(...args); return { success: true, meta: { changes: Number(meta.changes) } }; };
        return {
          async first() { const value = statement.get(...args); return value ? { ...value } : null; },
          async run() { return runSync(); }, runSync,
          async all() { return { results: statement.all(...args).map((row) => ({ ...row })), success: true }; },
        };
      } };
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try { const values = statements.map((statement) => statement.runSync()); sqlite.exec("COMMIT"); return values; }
      catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
  };
  return { db, sqlite };
}
class Socket {
  constructor() { this.readyState = 1; this.messages = []; this.attachment = null; }
  send(value) { if (this.readyState !== 1) throw Error("socket closed"); this.messages.push(JSON.parse(value)); }
  close(code, reason) { this.readyState = 3; this.closeCode = code; this.closeReason = reason; }
  serializeAttachment(value) { this.attachment = structuredClone(value); }
  deserializeAttachment() { return structuredClone(this.attachment); }
}
function context() {
  const sockets = [], stored = new Map();
  return { sockets, stored, acceptWebSocket(socket) { sockets.push(socket); },
    getWebSockets() { return sockets.filter((socket) => socket.readyState === 1); },
    blockConcurrencyWhile(fn) { return fn(); },
    storage: { async get(key) { return structuredClone(stored.get(key)); }, async put(key, value) { stored.set(key, structuredClone(value)); }, async setAlarm(value) { this.alarmAt = value; } } };
}
const sourceAssets = { async fetch(request) {
  const filename = new URL(request.url).pathname.split("/").at(-1);
  if (!Object.hasOwn(CORE_SOURCE_HASHES, filename)) return new Response(null, { status: 404 });
  return new Response(await readFile(new URL(`../public/city/${filename}`, import.meta.url)));
} };
function bucket() {
  const objects = new Map();
  return { objects, async put(key, value) { objects.set(key, new Uint8Array(value).slice()); },
    async delete(key) { objects.delete(key); }, async get(key) {
      const value = objects.get(key);
      return value ? { size: value.byteLength, arrayBuffer: async () => value.slice().buffer } : null;
    } };
}
async function setup() {
  const { db, sqlite } = sqliteD1(), rooms = new Map();
  let clock = 1801332000000;
  const env = { DB: db, STL_BUCKET: bucket(), ASSETS: sourceAssets,
    GOOGLE_CLIENT_ID: clientId, TEACHER_GOOGLE_EMAILS: "teacher@gmail.com", APP_ORIGIN: origin,
    SCHOOL_ROOMS: { getByName(id) {
      if (!rooms.has(id)) {
        const ctx = context();
        const room = new SchoolRoom(ctx, env, { now: () => clock,
          makePair: () => ({ client: new Socket(), server: new Socket() }),
          upgradeResponse: () => new Response(null, { status: 200 }) });
        rooms.set(id, { ctx, room });
      }
      return { fetch: (request) => rooms.get(id).room.fetch(request) };
    } },
  };
  const dependencies = { now: () => clock, googleVerification: { jwks: [jwk] } };
  const now = () => Math.floor(clock / 1000);
  async function user(sub, role = "student") {
    let record = await createUser(db, { sub }, role, now());
    await updateAvatar(db,record,{name:sub.slice(0,20)});
    record=await first(db,"SELECT * FROM school_users WHERE id=?",record.id);
    const issued = await createSession(db, record.id, now());
    return { ...record, token_hash: issued.hash, csrf: issued.csrf, expires_at: issued.expiresAt, cookie: `__Host-school-session=${issued.token}` };
  }
  function request(path, user = null, data = null, options = {}) {
    return new Request(`${origin}${path}`, { method: options.method ?? (data === null ? "GET" : "POST"),
      headers: { Origin: origin, ...(user ? { Cookie: user.cookie, "X-CSRF-Token": user.csrf } : {}),
        ...(data !== null ? { "Content-Type": "application/json" } : {}), ...options.headers },
      ...(data !== null ? { body: JSON.stringify(data) } : {}) });
  }
  async function connect(worldId, person) {
    const response = await roomRequest(env, worldId, person, "/socket", "GET", null, true);
    return { response, socket: rooms.get(worldId).ctx.sockets.at(-1), room: rooms.get(worldId).room };
  }
  return { env, db, sqlite, rooms, dependencies, user, request, connect, now, advance(ms = 1000) { clock += ms; } };
}
function cubeStl() {
  // Twelve real triangles forming a unit cube, preserved in Y-up STL coordinates.
  const vertices = [[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]];
  const faces = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[3,7,6],[3,6,2],[0,4,7],[0,7,3],[1,2,6],[1,6,5]];
  return new TextEncoder().encode(`solid cube\n${faces.map((face) => `facet normal 0 0 0\nouter loop\n${face.map((i) => `vertex ${vertices[i].join(" ")}`).join("\n")}\nendloop\nendfacet`).join("\n")}\nendsolid cube`);
}
async function upload(s, world, person, bytes = cubeStl(), options = {}) {
  const request = new Request(`${origin}/api/worlds/${world.id}/assets`, { method: "POST", headers: {
    Origin: origin, Cookie: person.cookie, "X-CSRF-Token": person.csrf, "Content-Type": "model/stl", "X-Up-Axis": "y", "X-Units": "m", "X-Filename": "cube.stl", ...options.headers,
  }, body: bytes });
  return handleSchoolRequest(request, s.env, s.dependencies);
}
async function unusedCoreLocation() {
  const surfaces = await loadCorePlacement(sourceAssets), model = normalizeSTLPositions(parseSTL(cubeStl().buffer).positions, "y");
  for (let z = -350; z <= 350; z += 15) for (let x = -300; x <= 300; x += 15) {
    const result = validatePlacement({ positions: model.positions, position: [x, 999, z], rotation: [0,0,0], scale: [1,1,1] }, surfaces);
    if (result.valid) return result.position;
  }
  throw Error("No actual verified core empty-space fixture found");
}

test("school backend caps agree with shared strict STL parser", () => {
  assert.equal(LIMITS.stlBytes, STL_LIMITS.maxBytes); assert.equal(LIMITS.assetTriangles, STL_LIMITS.maxTriangles);
});
test("Google JWT verifies real RS256 signature, issuer, audience, expiry, nonce and stable subject", async () => {
  const now = 1801332000, claims = { iss: "https://accounts.google.com", aud: clientId, sub: "google-fixture", exp: now + 3600, iat: now, nonce: "expected", email: "fixture@gmail.com", email_verified: true };
  const token = await signedToken(claims);
  assert.equal((await verifyGoogleToken(token, { jwks: [jwk], audience: clientId, nonce: "expected", now })).sub, claims.sub);
  for (const changed of [{ aud: "other" }, { iss: "https://evil.example" }, { exp: now }, { iat: now + 70 }, { nonce: "wrong" }, { email_verified: false }, { sub: {} }]) {
    await assert.rejects(verifyGoogleToken(await signedToken({ ...claims, ...changed }), { jwks: [jwk], audience: clientId, nonce: "expected", now }), (error) => error.code === "invalid_token");
  }
  const [head, body, signature] = token.split(".");
  await assert.rejects(verifyGoogleToken(`${head}.${body}.${signature.slice(0, -3)}abc`, { jwks: [jwk], audience: clientId, nonce: "expected", now }));
  await assert.rejects(verifyGoogleToken(await signedToken(claims, { alg: "none", kid: jwk.kid }), { jwks: [jwk], audience: clientId, nonce: "expected", now }));
});
test("teacher bootstrap does not trust arbitrary third-party verified email or browser role", () => {
  const env = { TEACHER_GOOGLE_EMAILS: "teacher@third.example,teacher@gmail.com", TEACHER_GOOGLE_SUBS: "fixed-google-sub" };
  assert.equal(roleFromClaims({ sub: "other", email: "teacher@third.example", email_verified: true }, env), "student");
  assert.equal(roleFromClaims({ sub: "other", email: "teacher@gmail.com", email_verified: true }, env), "teacher");
  assert.equal(roleFromClaims({ sub: "other", email: "teacher@third.example", hd: "third.example", email_verified: true }, env), "teacher");
  assert.equal(roleFromClaims({ sub: "fixed-google-sub", email: "unrelated@example.com" }, env), "teacher");
});
test("not-configured API fails closed and does not accept fake identity headers", async () => {
  const config = await worker.fetch(new Request(`${origin}/api/config`), {});
  assert.equal((await config.json()).configured, false);
  const login = await worker.fetch(new Request(`${origin}/api/auth/google`, { method: "POST", headers: { "X-Role": "teacher" } }), {});
  assert.equal(login.status, 503);
});
test("anonymous preauth reuses unused cookie and bounds NAT-friendly login issuance", async () => {
  const s = await setup(), response = await handleSchoolRequest(s.request("/api/session"), s.env, s.dependencies);
  const firstChallenge = await response.json(), cookie = response.headers.get("Set-Cookie").split(";")[0];
  const reused = await handleSchoolRequest(s.request("/api/session", null, null, { headers: { Cookie: cookie } }), s.env, s.dependencies);
  assert.deepEqual(await reused.json(), firstChallenge); assert.equal(reused.headers.has("Set-Cookie"), false);
  assert.equal((await first(s.db, "SELECT COUNT(*) AS n FROM school_auth_challenges")).n, 1);
  for (let i = 1; i < 120; i++) await handleSchoolRequest(s.request("/api/session"), s.env, s.dependencies);
  await assert.rejects(handleSchoolRequest(s.request("/api/session"), s.env, s.dependencies), (error) => error.code === "login_rate_limit");
  s.advance(61000); assert.equal((await handleSchoolRequest(s.request("/api/session"), s.env, s.dependencies)).status, 200);
  s.sqlite.close();
});
test("real JWT exchange consumes HttpOnly preauth nonce, opaque D1 session and stable avatar identity", async () => {
  const s = await setup();
  async function login() {
    const response = await handleSchoolRequest(s.request("/api/session"), s.env, s.dependencies);
    const challenge = await response.json(), cookie = response.headers.get("Set-Cookie").split(";")[0];
    assert.match(response.headers.get("Set-Cookie"), /HttpOnly; Secure; SameSite=Lax/);
    const claims = { iss: "https://accounts.google.com", aud: clientId, sub: "teacher-sub", exp: s.now() + 3600, iat: s.now(), nonce: challenge.nonce, email: "teacher@gmail.com", email_verified: true };
    const body = { credential: await signedToken(claims), csrf: challenge.csrf, role: "student" };
    const request = s.request("/api/auth/google", null, body, { headers: { Cookie: cookie } });
    const auth = await handleSchoolRequest(request, s.env, s.dependencies), user = await auth.json();
    assert.equal(auth.status, 200); assert.equal(user.user.role, "teacher");
    const sessionCookie = auth.headers.getSetCookie().find((value) => value.startsWith("__Host-school-session="));
    assert.match(sessionCookie, /HttpOnly; Secure; SameSite=Lax/);
    await assert.rejects(handleSchoolRequest(s.request("/api/auth/google", null, body, { headers: { Cookie: cookie } }), s.env, s.dependencies), (error) => error.code === "login_challenge_expired");
    const rows = await all(s.db, "SELECT * FROM school_sessions");
    assert.ok(rows.every((row) => /^[a-f0-9]{64}$/.test(row.token_hash)));
    assert.equal(rows.some((row) => sessionCookie.includes(row.token_hash)), false);
    return user.user;
  }
  const initial = await login(), again = await login();
  assert.deepEqual(initial, again); assert.equal((await first(s.db, "SELECT COUNT(*) AS n FROM school_users")).n, 1);
  s.sqlite.close();
});
test("authenticated APIs enforce Origin, CSRF, teacher role and world membership", async () => {
  const s = await setup(), teacher = await s.user("teacher", "teacher"), student = await s.user("student");
  await assert.rejects(handleSchoolRequest(s.request("/api/worlds", student, {}), s.env, s.dependencies), (error) => error.code === "teacher_required");
  await assert.rejects(handleSchoolRequest(s.request("/api/worlds", teacher, {}, { headers: { Origin: "https://evil.example" } }), s.env, s.dependencies), (error) => error.code === "invalid_origin");
  await assert.rejects(handleSchoolRequest(s.request("/api/worlds", teacher, {}, { headers: { "X-CSRF-Token": "wrong" } }), s.env, s.dependencies), (error) => error.code === "invalid_csrf");
  const world = await createWorld(s.db, teacher, {}, s.now());
  await assert.rejects(handleSchoolRequest(s.request(`/api/worlds/${world.id}/state`, student), s.env, s.dependencies), (error) => error.code === "world_membership_required");
  await joinWorld(s.db, student, world.join_code, s.now());
  const forged = await handleSchoolRequest(s.request(`/api/worlds/${world.id}/state`, student, null, { headers: {
    "X-School-Context": JSON.stringify({ worldId: world.id, sessionHash: teacher.token_hash }), "X-Role": "teacher", "X-User-Id": teacher.id,
  } }), s.env, s.dependencies);
  const read = await forged.json();
  assert.equal(read.world.joinCode, undefined); assert.deepEqual(read.snapshots, []);
  await assert.rejects(handleSchoolRequest(s.request(`/api/worlds/${world.id}/save`, student, {}), s.env, s.dependencies), (error) => error.code === "teacher_required");
  await assert.rejects(handleSchoolRequest(s.request(`/api/worlds/${world.id}/socket`, student, null, { headers: { Upgrade: "websocket", Origin: "https://evil.example" } }), s.env, s.dependencies), (error) => error.code === "invalid_origin");
  s.sqlite.close();
});
test("31 logical authenticated connections, 32nd identity refusal, room isolation and duplicate identity race", async () => {
  const s = await setup(), teacher = await s.user("teacher", "teacher"), world = await createWorld(s.db, teacher, {}, s.now());
  await s.connect(world.id, teacher);
  const students = [];
  for (let i = 0; i < 30; i++) { const person = await s.user(`student${i}`); students.push(person); await joinWorld(s.db, person, world.join_code, s.now()); await s.connect(world.id, person); }
  const room = s.rooms.get(world.id).room;
  assert.equal(room.sessions.size, 31);
  const extra = await s.user("student31");
  await assert.rejects(joinWorld(s.db, extra, world.join_code, s.now()), (error) => error.code === "class_full");
  // Inject an admin/database-created extra membership to exercise the separate
  // live-room cap too; public join cannot create this out-of-quota membership.
  await run(s.db, "INSERT INTO school_members(world_id,user_id,joined_at) VALUES(?,?,?)", world.id, extra.id, s.now());
  const refused = await roomRequest(s.env, world.id, extra, "/socket", "GET", null, true);
  assert.equal(refused.status, 409); assert.equal((await refused.json()).error, "room_full");
  const before = [...room.sessions.keys()].filter((socket) => room.sessions.get(socket).userId === students[0].id);
  await Promise.all([s.connect(world.id, students[0]), s.connect(world.id, students[0])]);
  assert.equal(room.sessions.size, 31); assert.equal(before[0].readyState, 3);
  assert.equal(room.participants().filter((person) => person.id === students[0].id).length, 1);
  const second = await createWorld(s.db, teacher, { name: "別クラス" }, s.now());
  const other = await s.connect(second.id, teacher);
  assert.equal(other.room.sessions.size, 1); assert.equal(room.sessions.size, 31);
  s.sqlite.close();
});
test("concurrent teacher world creation and pending asset reservations cannot overrun SQL quotas", async () => {
  const s = await setup(), teacher = await s.user("teacher", "teacher"), student = await s.user("student");
  const attempts = await Promise.allSettled(Array.from({ length: 12 }, () => createWorld(s.db, teacher, {}, s.now())));
  assert.equal(attempts.filter((entry) => entry.status === "fulfilled").length, 10);
  assert.equal(attempts.filter((entry) => entry.status === "rejected" && entry.reason.code === "world_quota_exceeded").length, 2);
  assert.equal((await first(s.db, "SELECT COUNT(*) AS n FROM school_worlds")).n, 10);
  const world = attempts.find((entry) => entry.status === "fulfilled").value;
  await joinWorld(s.db, student, world.join_code, s.now());
  const uploads = await Promise.allSettled(Array.from({ length: 12 }, () => upload(s, world, student)));
  assert.equal(uploads.filter((entry) => entry.status === "fulfilled").length, 10);
  assert.equal(uploads.filter((entry) => entry.status === "rejected" && entry.reason.code === "asset_quota_exceeded").length, 2);
  assert.equal((await first(s.db, "SELECT COUNT(*) AS n FROM school_assets WHERE status='ready'")).n, 10);
  s.sqlite.close();
});
test("STL private upload rejects malformed/type/size/axis, obeys quota and retains verified original bytes", async () => {
  const s = await setup(), teacher = await s.user("teacher", "teacher"), person = await s.user("student"), world = await createWorld(s.db, teacher, {}, s.now());
  await joinWorld(s.db, person, world.join_code, s.now());
  await assert.rejects(upload(s, world, person, new TextEncoder().encode("not stl")), (error) => error.code === "invalid_stl");
  await assert.rejects(upload(s, world, person, cubeStl(), { headers: { "Content-Type": "text/html" } }), (error) => error.code === "stl_required");
  await assert.rejects(upload(s, world, person, cubeStl(), { headers: { "X-Up-Axis": "bad" } }), (error) => error.code === "invalid_stl_units");
  await assert.rejects(upload(s, world, person, cubeStl(), { headers: { "Content-Length": String(LIMITS.stlBytes + 1) } }), (error) => error.code === "body_too_large");
  const bytes = cubeStl(), response = await upload(s, world, person, bytes), asset = (await response.json()).asset;
  assert.equal(asset.ownerId, person.id); assert.equal(asset.upAxis, "y"); assert.equal(asset.sha256, await sha256(bytes));
  const file = await handleSchoolRequest(s.request(`/api/worlds/${world.id}/assets/${asset.id}`, person), s.env, s.dependencies);
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytes); assert.equal(file.headers.get("Cache-Control"), "private, no-store");
  for (let i = 1; i < LIMITS.userAssets; i++) await upload(s, world, person);
  await assert.rejects(upload(s, world, person), (error) => error.code === "asset_quota_exceeded");
  s.sqlite.close();
});
test("actual core mesh SHA validation refuses substituted ground bytes", async () => {
  const surface = await loadCorePlacement(sourceAssets);
  assert.equal(surface.obstacles.length, 4); assert.ok(surface.terrain.triangles > 30000);
  const substituted = { async fetch() { return new Response("{}") } };
  await assert.rejects(loadCorePlacement(substituted), (error) => error.code === "placement_source_hash_mismatch");
});

test('slow terrain fetch leaves poses/pings/restore live and rejects stale or logged-out placement',async()=>{
  for(const interrupt of ['restore','logout','none']){
    const s=await setup(),teacher=await s.user('queue-teacher','teacher'),student=await s.user('queue-student');
    try{
      const world=await createWorld(s.db,teacher,{},s.now());await joinWorld(s.db,student,world.join_code,s.now());
      const asset=(await(await upload(s,world,student)).json()).asset;
      const a=await s.connect(world.id,student),b=await s.connect(world.id,teacher),room=a.room;
      const surfaces=await loadCorePlacement(sourceAssets),position=await unusedCoreLocation();
      let release,started;const entered=new Promise(r=>started=r),blocked=new Promise(r=>release=r);
      room.loadPlacement=async()=>{started();await blocked;return surfaces;};
      const command={type:'object.create',requestId:crypto.randomUUID(),revision:0,assetId:asset.id,position,rotation:[0,0,0],scale:[.5,.5,.5]};
      const placing=room.webSocketMessage(a.socket,JSON.stringify(command));await entered;
      // These would deadlock if the deferred loader still occupied serial().
      await Promise.race([room.webSocketMessage(b.socket,JSON.stringify({type:'ping'})),new Promise((_,r)=>setTimeout(()=>r(Error('queue blocked')),1000))]);
      assert.equal(b.socket.messages.at(-1).type,'pong');
      await room.webSocketMessage(b.socket,JSON.stringify({type:'pose',position:[1,40,1],yaw:0,seq:0,restoreCommit:null}));
      assert.equal(b.socket.messages.at(-1).type,'pose');assert.equal(room.state.objects.length,0);
      s.advance();await room.webSocketMessage(a.socket,JSON.stringify({...command,requestId:crypto.randomUUID()}));
      assert.equal(a.socket.messages.at(-1).error,'edit_rate_limit');
      if(interrupt==='restore'){
        const snapshot=await(await roomRequest(s.env,world.id,teacher,'/save','POST')).json();
        assert.equal((await roomRequest(s.env,world.id,teacher,'/restore','POST',{snapshotId:snapshot.id,revision:0})).status,200);
      }else if(interrupt==='logout')await s.db.prepare('DELETE FROM school_sessions WHERE token_hash=?').bind(student.token_hash).run();
      release();await placing;
      assert.equal(room.pendingPlacements.size,0);
      if(interrupt==='none'){assert.equal(a.socket.messages.at(-1).type,'ack');assert.equal(room.state.objects.length,1);}
      else {assert.equal(a.socket.messages.at(-1).type,'error');assert.equal(room.state.objects.length,0);if(interrupt==='restore')assert.equal(a.socket.messages.at(-1).error,'stale_revision');}
    }finally{s.sqlite.close();}
  }
});
test("server sync validates actual core empty ground, ignores ownership lies, saves/restores and rejects stale clients", async () => {
  const s = await setup(), teacher = await s.user("teacher", "teacher"), student = await s.user("student"), stranger = await s.user("other"), world = await createWorld(s.db, teacher, {}, s.now());
  await joinWorld(s.db, student, world.join_code, s.now()); await joinWorld(s.db, stranger, world.join_code, s.now());
  const asset = (await (await upload(s, world, student)).json()).asset;
  const a = await s.connect(world.id, student), b = await s.connect(world.id, stranger), t = await s.connect(world.id, teacher);
  const position = await unusedCoreLocation(), id = crypto.randomUUID(), requestId = crypto.randomUUID();
  const create = { type: "object.create", requestId, revision: 0, id, assetId: asset.id, ownerId: teacher.id, valid: true, position: [position[0], 999, position[2]], rotation: [0.3,0.5,0.2], scale: [0.5,0.5,0.5] };
  await a.room.webSocketMessage(a.socket, JSON.stringify(create));
  assert.equal(a.room.state.objects.length, 1); assert.equal(a.room.state.objects[0].ownerId, student.id);
  assert.notEqual(a.room.state.objects[0].position[1], 999); assert.ok(b.socket.messages.some((message) => message.type === "objects" && message.objects[0]?.id === id));
  const recorded = structuredClone(a.room.state.objects[0]);
  await a.room.webSocketMessage(a.socket, JSON.stringify(create));
  assert.equal(a.room.state.revision, 1); assert.equal(a.room.state.objects.length, 1);
  await b.room.webSocketMessage(b.socket, JSON.stringify({ type: "object.delete", requestId: crypto.randomUUID(), revision: 1, id }));
  assert.equal(b.socket.messages.at(-1).error, "object_owner_required");
  const save = await roomRequest(s.env, world.id, teacher, "/save", "POST"), checkpoint = await save.json();
  s.advance();
  await a.room.webSocketMessage(a.socket, JSON.stringify({ type: "object.delete", requestId: crypto.randomUUID(), revision: 1, id }));
  assert.equal(a.room.state.objects.length, 0);
  const restored = await roomRequest(s.env, world.id, teacher, "/restore", "POST", { snapshotId: checkpoint.id, revision: 2 });
  assert.equal(restored.status, 200); assert.equal(a.room.state.revision, 3); assert.deepEqual(a.room.state.objects[0], recorded);
  s.advance();
  await a.room.webSocketMessage(a.socket, JSON.stringify({ type: "object.delete", requestId: crypto.randomUUID(), revision: 1, id }));
  assert.equal(a.socket.messages.at(-1).error, "stale_revision");
  s.advance();
  await a.room.webSocketMessage(a.socket, JSON.stringify({ ...create, id: crypto.randomUUID(), requestId: crypto.randomUUID(), revision: 3, position: [20000, 0, 20000] }));
  assert.equal(a.socket.messages.at(-1).error, "invalid_placement"); assert.equal(a.room.state.objects.length, 1);
  // Simulate Worker eviction: only durable state and attached sockets remain, no in-memory draft.
  const ctx = s.rooms.get(world.id).ctx, woken = new SchoolRoom(ctx, s.env, { now: () => s.now() * 1000 });
  await woken.ready; assert.deepEqual(woken.state.objects[0], recorded); assert.equal(woken.sessions.size, 3);
  // A newly issued browser session uses the original Google user's stable ID.
  const resumedUser = await createUser(s.db, { sub: "student" }, "student", s.now()), issued = await createSession(s.db, resumedUser.id, s.now());
  assert.equal(resumedUser.id, student.id); assert.deepEqual(JSON.parse(resumedUser.avatar_json), JSON.parse(student.avatar_json));
  const renewed = { ...resumedUser, token_hash: issued.hash, csrf: issued.csrf, cookie: `__Host-school-session=${issued.token}` };
  const reconnect = await s.connect(world.id, renewed);
  assert.deepEqual(reconnect.socket.messages.find((message) => message.type === "state").objects[0], recorded);
  s.sqlite.close();
});
test("object colors persist across server eviction/restore; only owner can paint without terrain or transform changes", async () => {
  const s = await setup();
  try {
    const teacher = await s.user("paint-teacher", "teacher"), student = await s.user("paint-student"), world = await createWorld(s.db, teacher, {}, s.now());
    await joinWorld(s.db, student, world.join_code, s.now());
    const asset = (await (await upload(s, world, student)).json()).asset;
    const a = await s.connect(world.id, student), t = await s.connect(world.id, teacher);
    const position = await unusedCoreLocation(), id = crypto.randomUUID();
    const send = async (peer, value) => { s.advance(); await peer.room.webSocketMessage(peer.socket, JSON.stringify({ requestId: crypto.randomUUID(), revision: a.room.state.revision, ...value })); return peer.socket.messages.at(-1); };
    assert.equal((await send(a, { type: "object.create", id, assetId: asset.id, position, rotation: [0,0,0], scale: [.5,.5,.5], color: "#FF8800" })).type, "ack");
    assert.equal(a.room.state.objects[0].color, "#ff8800");
    const before = structuredClone(a.room.state.objects[0]);
    a.room.loadPlacement = async () => { throw new Error("painting must not fetch terrain"); };
    assert.equal((await send(t, { type: "object.paint", id, color: "#ffffff" })).error, "object_owner_required");
    assert.equal((await send(a, { type: "object.paint", id, color: "red" })).error, "invalid_object_color");
    assert.deepEqual(a.room.state.objects[0], before);
    assert.equal((await send(a, { type: "object.paint", id, color: "#22AA77", position: [999,999,999], ownerId: teacher.id })).type, "ack");
    const painted = { ...before, color: "#22aa77" };
    assert.deepEqual(a.room.state.objects[0], painted);
    assert.equal(t.socket.messages.findLast(message => message.type === "objects").objects[0].color, painted.color);
    const checkpoint = await (await roomRequest(s.env, world.id, teacher, "/save", "POST")).json();
    await send(a, { type: "object.paint", id, color: "#112233" });
    const restored = await roomRequest(s.env, world.id, teacher, "/restore", "POST", { snapshotId: checkpoint.id, revision: a.room.state.revision });
    assert.equal(restored.status, 200); assert.deepEqual(a.room.state.objects[0], painted);
    const woken = new SchoolRoom(s.rooms.get(world.id).ctx, s.env, { now: () => s.now() * 1000 });
    await woken.ready; assert.deepEqual(woken.state.objects[0], painted);
  } finally { s.sqlite.close(); }
});

test("pose finite/sequence/rate/size checks and session expiry remove ghosts", async () => {
  const s = await setup(), teacher = await s.user("teacher", "teacher"), world = await createWorld(s.db, teacher, {}, s.now()), a = await s.connect(world.id, teacher);
  await a.room.webSocketMessage(a.socket, JSON.stringify({ type: "pose", position: [0,40,0], yaw: 0, seq: 1, restoreCommit: null }));
  assert.equal(a.socket.messages.at(-1).type, "pose"); assert.deepEqual(a.socket.messages.at(-1).participant.position, [0,40,0]);
  assert.equal("participants" in a.socket.messages.at(-1), false);
  await a.room.webSocketMessage(a.socket, JSON.stringify({ type: "pose", position: [1,40,0], yaw: 0, seq: 2, restoreCommit: null }));
  assert.equal(a.socket.messages.at(-1).error, "pose_rate_limit");
  s.advance(); await a.room.webSocketMessage(a.socket, JSON.stringify({ type: "pose", position: [null,40,0], yaw: 0, seq: 3, restoreCommit: null }));
  assert.equal(a.socket.messages.at(-1).error, "invalid_pose");
  await a.room.webSocketMessage(a.socket, "a".repeat(LIMITS.messageBytes + 1)); assert.equal(a.socket.messages.at(-1).error, "message_too_large");
  await run(s.db, "DELETE FROM school_sessions WHERE token_hash=?", teacher.token_hash);
  await a.room.webSocketMessage(a.socket, JSON.stringify({ type: "pose", position: [1,40,0], yaw: 0, seq: 3, restoreCommit: null }));
  assert.equal(a.room.sessions.size, 0); assert.equal(a.socket.closeCode, 1008);
  s.sqlite.close();
});
test("unedited room survives hibernation, heartbeat preserves liveness and alarm closes silent ghosts", async () => {
  const s = await setup(), teacher = await s.user("teacher", "teacher"), world = await createWorld(s.db, teacher, {}, s.now()), a = await s.connect(world.id, teacher);
  const ctx = s.rooms.get(world.id).ctx, room = new SchoolRoom(ctx, s.env, { now: () => s.now() * 1000 });
  await room.ready;
  assert.equal(room.state.worldId, world.id); assert.equal(room.state.revision, 0);
  s.advance(1000); await room.webSocketMessage(a.socket, JSON.stringify({ type: "pose", position: [10,40,20], yaw: 0.4, seq: 1, restoreCommit: null }));
  assert.deepEqual(room.participants()[0].position, [10,40,20]);
  s.advance(20000); await room.webSocketMessage(a.socket, JSON.stringify({ type: "ping" }));
  assert.equal(a.socket.messages.at(-1).type, "pong");
  s.advance(45000); await room.alarm(); assert.equal(room.sessions.size, 1);
  s.advance(20000); await room.alarm(); assert.equal(room.sessions.size, 0); assert.equal(a.socket.closeCode, 1008);
  s.sqlite.close();
});
test("socket packet flood closes connection before repeated authentication/storage work", async () => {
  const s = await setup(), teacher = await s.user("teacher", "teacher"), world = await createWorld(s.db, teacher, {}, s.now()), a = await s.connect(world.id, teacher);
  for (let i = 0; i < 21; i++) await a.room.webSocketMessage(a.socket, "bad");
  assert.equal(a.socket.readyState, 3); assert.equal(a.room.sessions.size, 0); assert.equal(a.socket.closeReason, "message rate limit");
  s.sqlite.close();
});
test("explicit logout closes only its browser session, not a second device's account", async () => {
  const s = await setup(), teacher = await s.user("teacher", "teacher"), world = await createWorld(s.db, teacher, {}, s.now());
  const a = await s.connect(world.id, teacher), second = await createSession(s.db, teacher.id, s.now());
  const response = await handleSchoolRequest(s.request("/api/auth/logout", teacher, {}), s.env, s.dependencies);
  assert.equal(response.status, 200); assert.equal(a.socket.readyState, 3); assert.equal(a.room.sessions.size, 0);
  assert.equal(await first(s.db, "SELECT * FROM school_sessions WHERE token_hash=?", teacher.token_hash), null);
  assert.ok(await first(s.db, "SELECT * FROM school_sessions WHERE token_hash=?", second.hash));
  s.sqlite.close();
});
test("expired session rejects HTTP before returning private file or classroom state", async () => {
  const s = await setup(), teacher = await s.user("teacher", "teacher"), world = await createWorld(s.db, teacher, {}, s.now());
  s.advance((LIMITS.sessionSeconds + 1) * 1000);
  await assert.rejects(handleSchoolRequest(s.request(`/api/worlds/${world.id}/state`, teacher), s.env, s.dependencies), (error) => error.code === "login_required");
  s.sqlite.close();
});

test("teacher return preserves student STL; metadata persists and other owners cannot mutate it", async () => {
  const s=await setup();
  try {
    const teacher=await s.user('exhibit-teacher','teacher'),student=await s.user('exhibit-student'),other=await s.user('exhibit-other');
    const world=await createWorld(s.db,teacher,{},s.now());
    await joinWorld(s.db,student,world.join_code,s.now());await joinWorld(s.db,other,world.join_code,s.now());
    const asset=(await(await upload(s,world,student)).json()).asset;
    const a=await s.connect(world.id,student),t=await s.connect(world.id,teacher),b=await s.connect(world.id,other);
    const send=async(peer,data)=>{s.advance();await peer.room.webSocketMessage(peer.socket,JSON.stringify({requestId:crypto.randomUUID(),revision:a.room.state.revision,...data}));return peer.socket.messages.at(-1);};
    const create={type:'object.create',assetId:asset.id,position:await unusedCoreLocation(),rotation:[0,0,0],scale:[1,1,1],title:'未来の駅',description:'太陽光で動きます'};
    assert.equal((await send(a,create)).type,'ack');const object=structuredClone(a.room.state.objects[0]);
    assert.equal(object.title,create.title);assert.equal(object.authorName,'exhibit-student');
    assert.equal((await send(t,{type:'object.describe',id:object.id,title:'変更',description:''})).error,'object_owner_required');
    assert.equal((await send(a,{type:'object.describe',id:object.id,title:'x'.repeat(41),description:''})).error,'invalid_exhibit_text');
    assert.equal((await send(a,{type:'object.describe',id:object.id,title:'私の駅',description:'<b>HTMLではなく文字です</b>'})).type,'ack');
    const saved=structuredClone(a.room.state.objects[0]);assert.deepEqual(saved.position,object.position);
    const woken=new SchoolRoom(s.rooms.get(world.id).ctx,s.env,{now:()=>s.now()*1000});await woken.ready;
    assert.deepEqual(woken.state.objects[0],saved);
    assert.equal((await send(b,{type:'object.delete',id:object.id})).error,'object_owner_required');
    // Role is checked from the live database for every command.
    await run(s.db,"UPDATE school_users SET role='student' WHERE id=?",teacher.id);
    assert.equal((await send(t,{type:'object.delete',id:object.id})).error,'object_owner_required');
    await run(s.db,"UPDATE school_users SET role='teacher' WHERE id=?",teacher.id);
    const deletion={type:'object.delete',id:object.id,requestId:crypto.randomUUID(),revision:a.room.state.revision};
    assert.equal((await send(t,deletion)).type,'ack');assert.equal(a.room.state.objects.length,0);
    assert.ok(await first(s.db,"SELECT id FROM school_assets WHERE id=? AND owner_id=? AND status='ready'",asset.id,student.id));
    assert.equal((await send(t,deletion)).type,'ack');assert.equal(a.room.state.objects.length,0);
    assert.equal((await send(a,create)).type,'ack');assert.equal(a.room.state.objects[0].assetId,asset.id);
  } finally {s.sqlite.close();}
});

test("overlapping placements race through one authoritative revision, then the occupied footprint is rejected",async()=>{
  const s=await setup();
  try{
    const teacher=await s.user('race-teacher','teacher'),aUser=await s.user('race-a'),bUser=await s.user('race-b');
    const world=await createWorld(s.db,teacher,{},s.now());
    await joinWorld(s.db,aUser,world.join_code,s.now());await joinWorld(s.db,bUser,world.join_code,s.now());
    const aa=(await(await upload(s,world,aUser)).json()).asset,ba=(await(await upload(s,world,bUser)).json()).asset;
    const a=await s.connect(world.id,aUser),b=await s.connect(world.id,bUser),position=await unusedCoreLocation();
    const command=id=>({type:'object.create',requestId:crypto.randomUUID(),revision:0,assetId:id,position,rotation:[0,0,0],scale:[1,1,1]});
    await Promise.all([a.room.webSocketMessage(a.socket,JSON.stringify(command(aa.id))),b.room.webSocketMessage(b.socket,JSON.stringify(command(ba.id)))]);
    assert.equal(a.room.state.objects.length,1);
    const loser=a.room.state.objects[0].ownerId===aUser.id?b:a,asset=loser===b?ba:aa;
    assert.equal(loser.socket.messages.at(-1).error,'stale_revision');
    s.advance();await loser.room.webSocketMessage(loser.socket,JSON.stringify({...command(asset.id),revision:1}));
    assert.equal(loser.socket.messages.at(-1).error,'object_overlap');assert.equal(a.room.state.objects.length,1);
  }finally{s.sqlite.close();}
});
