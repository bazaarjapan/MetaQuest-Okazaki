import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { SchoolRoom } from "../worker/school-room.mjs";
import { createUser, createSession, createWorld, joinWorld } from "../worker/school-store.mjs";
import { LIMITS } from "../worker/school-common.mjs";

// Explicit in-memory unit fixtures exercise the real DO handlers, fresh D1
// authorization and durable storage. They are not Google/browser/device evidence.
const migration = await readFile(new URL("../migrations/0001_school_worlds.sql", import.meta.url), "utf8");
const checkpointPose = { position: [10,40,20], yaw: .1 };
const currentPose = { position: [110,60,120], yaw: .6 };
const laterPose = { position: [210,70,220], yaw: -.7 };
const poseOf = (socket) => socket.messages.findLast((packet) => packet.type === "state")?.participants
  .find((participant) => participant.id === socket.attachment.userId);

class Socket {
  constructor() { this.readyState = 1; this.messages = []; }
  send(value) { if (this.readyState !== 1) throw Error("closed fixture socket"); this.messages.push(JSON.parse(value)); }
  close(code, reason) { this.readyState = 3; this.closeCode = code; this.closeReason = reason; }
  serializeAttachment(value) { this.attachment = structuredClone(value); }
  deserializeAttachment() { return structuredClone(this.attachment); }
}
async function fixture(t) {
  const sqlite = new DatabaseSync(":memory:"); sqlite.exec(migration); t.after(() => sqlite.close());
  const control = { failLiveWrites: 0, failWorldWrites: 0, uncertainWorldWrite: false, puts: [] };
  const db = { prepare(sql) { return { bind(...args) {
    const statement = sqlite.prepare(sql);
    const runSync = () => ({ success: true, meta: { changes: Number(statement.run(...args).changes) } });
    return { async first() { return statement.get(...args) ?? null; },
      async all() { return { results: statement.all(...args) }; }, async run() { return runSync(); }, runSync };
  } }; }, async batch(statements) {
    sqlite.exec("BEGIN");
    try { const result = statements.map((statement) => statement.runSync()); sqlite.exec("COMMIT"); return result; }
    catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  } };
  let clock = 1801332000000, room;
  const now = () => Math.floor(clock / 1000), stored = new Map(), sockets = [];
  const ctx = { getWebSockets: () => sockets.filter((socket) => socket.readyState === 1),
    acceptWebSocket(socket) { sockets.push(socket); }, blockConcurrencyWhile: (task) => task(),
    storage: { async get(key) { return structuredClone(stored.get(key)); },
      async put(key, value) {
        control.puts.push(key);
        if (key.startsWith("live-pose:") && control.failLiveWrites > 0) {
          control.failLiveWrites--; throw Error("injected live-pose storage failure");
        }
        if (key === "world-state" && control.failWorldWrites > 0) {
          control.failWorldWrites--;
          if (control.uncertainWorldWrite) stored.set(key, structuredClone(value));
          throw Error("injected world commit failure");
        }
        stored.set(key, structuredClone(value));
      }, async setAlarm() {} } };
  const dependencies = { now: () => clock, makePair: () => ({ client: new Socket(), server: new Socket() }),
    upgradeResponse: () => new Response(null, { status: 200 }) }, env = { DB: db };
  async function user(number, role = "student") {
    const sub = `live-pose-fixture-${role}-${number}`;
    const record = await createUser(db, { sub }, role, now());
    const session = await createSession(db, record.id, now());
    return { ...record, sub, hash: session.hash };
  }
  const teacher = await user(0, "teacher"), student = await user(1);
  const world = await createWorld(db, teacher, { name: "Live pose fixture" }, now());
  await joinWorld(db, student, world.join_code, now());
  sqlite.prepare("UPDATE school_members SET pose_json=? WHERE world_id=? AND user_id=?")
    .run(JSON.stringify(checkpointPose), world.id, student.id);
  async function reload() { room = new SchoolRoom(ctx, env, dependencies); await room.ready; }
  await reload();
  function request(person, path, body) {
    return new Request(`https://room.internal${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { "X-School-Context": JSON.stringify({ worldId: world.id, sessionHash: person.hash }),
        ...(path === "/socket" ? { Upgrade: "websocket" } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async function connect(person = student) {
    const response = await room.fetch(request(person, "/socket"));
    return { response, socket: sockets.at(-1) };
  }
  async function save() {
    const response = await room.fetch(request(teacher, "/save", {}));
    assert.equal(response.status, 200); return response.json();
  }
  return { db, sqlite, stored, control, student, teacher, world, sockets, reload,
    room: () => room, advance(ms = 125) { clock += ms; }, connect,
    async addStudent(number) { const person = await user(number); await joinWorld(db, person, world.join_code, now()); return person; },
    async nextSession(person) {
      sqlite.prepare("DELETE FROM school_sessions WHERE token_hash=?").run(person.hash);
      return user(person.sub.split("-").at(-1), person.role);
    },
    pose: (socket, pose, seq = 0, restoreCommit = room.poseRestoreCommit()) =>
      room.webSocketMessage(socket, JSON.stringify({ type: "pose", ...pose, seq, restoreCommit })),
    packet: (socket, value) => room.webSocketMessage(socket, JSON.stringify(value)),
    async disconnect(socket) { socket.readyState = 3; await room.webSocketClose(socket); }, save,
    async restore(id) {
      return room.fetch(request(teacher, "/restore", { snapshotId: id, revision: room.state.revision }));
    },
    snapshot: (id) => JSON.parse(sqlite.prepare("SELECT state_json FROM school_snapshots WHERE id=?").get(id).state_json),
    live: (person = student) => stored.get(`live-pose:${person.id}`),
  };
}
function assertPose(actual, expected) {
  assert.deepEqual(actual.position, expected.position); assert.equal(actual.yaw, expected.yaw);
}

test("unsaved live pose survives duplicate identity replacement and transient socket loss", async (t) => {
  const f = await fixture(t), first = (await f.connect()).socket;
  await f.pose(first, currentPose);
  const replacement = (await f.connect()).socket;
  assert.equal(first.closeCode, 1000); assertPose(poseOf(replacement), currentPose);
  assert.equal(f.room().sessions.size, 1); assert.equal(replacement.attachment.lastSeq, -1);
  f.advance(); await f.pose(replacement, laterPose); await f.disconnect(replacement);
  const third = (await f.connect()).socket;
  assertPose(poseOf(third), laterPose); assertPose(f.live().pose, laterPose);
});

test("same Google subject with a new session resumes durable live pose after empty DO eviction", async (t) => {
  const f = await fixture(t), first = (await f.connect()).socket;
  await f.pose(first, currentPose); await f.disconnect(first);
  const signedInAgain = await f.nextSession(f.student); assert.equal(signedInAgain.id, f.student.id);
  assert.notEqual(signedInAgain.hash, f.student.hash);
  await f.reload(); assert.equal(f.room().sessions.size, 0);
  const resumed = (await f.connect(signedInAgain)).socket; assertPose(poseOf(resumed), currentPose);
});

test("durable live pose wins over stale hibernating attachment during reconnect", async (t) => {
  const f = await fixture(t), first = (await f.connect()).socket;
  await f.pose(first, currentPose);
  first.attachment.pose = structuredClone(checkpointPose);
  await f.reload(); assert.equal(f.room().sessions.size, 1);
  const replacement = (await f.connect()).socket; assertPose(poseOf(replacement), currentPose);
  assert.equal(first.closeCode, 1000); assert.equal(f.room().sessions.size, 1);
});

test("teacher checkpoint includes offline member's latest accepted live pose", async (t) => {
  const f = await fixture(t), first = (await f.connect()).socket;
  await f.pose(first, currentPose); await f.disconnect(first);
  const saved = await f.save(); assertPose(f.snapshot(saved.id).poses[f.student.id], currentPose);
  const mirror = JSON.parse(f.sqlite.prepare("SELECT pose_json FROM school_members WHERE world_id=? AND user_id=?")
    .get(f.world.id, f.student.id).pose_json);
  assertPose(mirror, currentPose);
});

test("teacher restore defeats old live cache but preserves members missing from the checkpoint", async (t) => {
  const f = await fixture(t), first = (await f.connect()).socket, saved = await f.save();
  await f.pose(first, currentPose); await f.disconnect(first);
  const newcomer = await f.addStudent(2), newcomerSocket = (await f.connect(newcomer)).socket;
  await f.pose(newcomerSocket, laterPose); await f.disconnect(newcomerSocket);
  assert.equal(Object.hasOwn(f.snapshot(saved.id).poses, newcomer.id), false);
  assert.equal((await f.restore(saved.id)).status, 200);
  assert.equal(f.live().restoreCommit, null, "old live record is not rewritten during restore");
  assert.notEqual(f.room().state.restoreCommit, null);
  assertPose(f.room().state.livePoseFallbacks[f.student.id], checkpointPose);
  assertPose(f.room().state.livePoseFallbacks[newcomer.id], laterPose);
  await f.reload();
  const resumed = (await f.connect()).socket, joinedLater = (await f.connect(newcomer)).socket;
  assertPose(poseOf(resumed), checkpointPose); assertPose(poseOf(joinedLater), laterPose);
  f.advance(); const newest = { position: [300,80,310], yaw: .9 };
  await f.pose(joinedLater, newest); await f.disconnect(joinedLater);
  assert.equal((await f.restore(saved.id)).status, 200);
  assertPose(poseOf((await f.connect(newcomer)).socket), newest, "a second epoch must not resurrect an older live record");
});

test("initial pose epoch must be explicit null; missing and malformed epochs never publish or persist", async (t) => {
  const f = await fixture(t), first = (await f.connect()).socket, peer = (await f.connect(f.teacher)).socket;
  assert.equal(first.messages.find((packet) => packet.type === "state").restoreCommit, null);
  const beforeWrites = f.control.puts.length; peer.messages = [];
  for (const epoch of [undefined, "not-a-restore", 0, {}, []]) {
    await f.packet(first, { type: "pose", ...currentPose, seq: 0,
      ...(epoch === undefined ? {} : { restoreCommit: epoch }) });
    assert.equal(first.messages.at(-1).error, "stale_pose_epoch");
    assert.equal(first.attachment.lastSeq, -1); assertPose(first.attachment.pose, checkpointPose);
  }
  assert.equal(f.control.puts.length, beforeWrites);
  assert.equal(peer.messages.some((packet) => packet.type === "pose"), false);
  await f.pose(first, currentPose, 0, null); assertPose(f.live().pose, currentPose);
});

test("delayed pre-restore poses cannot enter a new epoch or teleport reconnects after repeated restores", async (t) => {
  const f = await fixture(t), first = (await f.connect()).socket, peer = (await f.connect(f.teacher)).socket;
  const saved = await f.save(); await f.pose(first, currentPose);
  assert.equal((await f.restore(saved.id)).status, 200);
  const restoredEpoch = f.room().poseRestoreCommit();
  assert.equal(typeof restoredEpoch, "string");
  assert.equal(first.messages.findLast((packet) => packet.type === "state").restoreCommit, restoredEpoch);
  assertPose(first.attachment.pose, checkpointPose);
  const beforeWrites = f.control.puts.length; peer.messages = [];
  await f.pose(first, currentPose, 1, null); // Already in flight from the old world.
  assert.equal(first.messages.at(-1).error, "stale_pose_epoch");
  assert.equal(first.attachment.lastSeq, 0); assertPose(first.attachment.pose, checkpointPose);
  assert.equal(f.control.puts.length, beforeWrites);
  assert.equal(peer.messages.some((packet) => packet.type === "pose"), false);
  await f.disconnect(first);
  const resumed = (await f.connect()).socket; assertPose(poseOf(resumed), checkpointPose);
  assert.equal(f.live().restoreCommit, restoredEpoch);
  f.advance(); await f.pose(resumed, laterPose); assertPose(f.live().pose, laterPose);
  assert.equal((await f.restore(saved.id)).status, 200);
  assert.notEqual(f.room().poseRestoreCommit(), restoredEpoch);
  await f.pose(resumed, laterPose, 1, restoredEpoch);
  assert.equal(resumed.messages.at(-1).error, "stale_pose_epoch");
  await f.disconnect(resumed); await f.reload();
  assertPose(poseOf((await f.connect()).socket), checkpointPose);
  const resaved = await f.save(); assertPose(f.snapshot(resaved.id).poses[f.student.id], checkpointPose);
});

test("rejected pose persistence does not publish fake success or change attachment/current pose", async (t) => {
  const f = await fixture(t), first = (await f.connect()).socket, peer = (await f.connect(f.teacher)).socket;
  first.messages = []; peer.messages = []; f.control.failLiveWrites = 1;
  await f.pose(first, currentPose);
  assert.equal(first.messages.at(-1).error, "internal_error");
  assert.equal(peer.messages.some((packet) => packet.type === "pose"), false);
  assertPose(first.attachment.pose, checkpointPose); assertPose(f.live().pose, checkpointPose);
  assert.equal(first.attachment.lastSeq, -1);
  f.advance(); await f.pose(first, currentPose);
  assertPose(peer.messages.at(-1).participant, currentPose);
});

test("failed restore world commit rolls back checkpoint mirror without discarding latest live pose", async (t) => {
  const f = await fixture(t), first = (await f.connect()).socket, saved = await f.save();
  await f.pose(first, currentPose); await f.disconnect(first);
  f.control.failWorldWrites = 1;
  assert.equal((await f.restore(saved.id)).status, 500);
  assert.equal(f.stored.get("restore-recovery"), null); assert.equal(f.room().state.restoreCommit, undefined);
  await f.reload(); assertPose(poseOf((await f.connect()).socket), currentPose);
});

test("uncertain committed restore recovers its epoch and carry-over poses after DO reconstruction", async (t) => {
  const f = await fixture(t), first = (await f.connect()).socket, saved = await f.save();
  await f.pose(first, currentPose); await f.disconnect(first);
  const newcomer = await f.addStudent(2), second = (await f.connect(newcomer)).socket;
  await f.pose(second, laterPose); await f.disconnect(second);
  f.control.failWorldWrites = 1; f.control.uncertainWorldWrite = true;
  assert.equal((await f.restore(saved.id)).status, 200);
  assert.equal(f.stored.get("restore-recovery"), null);
  await f.reload();
  assertPose(poseOf((await f.connect()).socket), checkpointPose);
  assertPose(poseOf((await f.connect(newcomer)).socket), laterPose);
});

test("31 members retain one compact live record each; 8Hz poses never rewrite world objects or history", async (t) => {
  const f = await fixture(t), people = [f.teacher, f.student];
  for (let i = 2; i <= LIMITS.students; i++) people.push(await f.addStudent(i));
  const connections = [];
  for (const person of people) connections.push((await f.connect(person)).socket);
  assert.equal(f.room().sessions.size, LIMITS.participants);
  for (let seq = 0; seq < 8; seq++) {
    for (let index = 0; index < connections.length; index++) await f.pose(connections[index], { position: [index,40,seq], yaw: .1 }, seq);
    f.advance();
  }
  assert.equal([...f.stored.keys()].filter((key) => key.startsWith("live-pose:")).length, LIMITS.participants);
  assert.equal(f.control.puts.filter((key) => key === "world-state").length, 1);
  assert.ok(people.every((person) => JSON.stringify(f.live(person)).length < 187));
  const packet = connections[0].messages.findLast((entry) => entry.type === "pose");
  assert.equal("objects" in packet, false); assert.equal("participants" in packet, false);
});

test("invalid, stale and over-rate poses cannot overwrite durable live state", async (t) => {
  const f = await fixture(t), first = (await f.connect()).socket;
  await f.pose(first, currentPose); const beforeWrites = f.control.puts.length;
  await f.pose(first, laterPose, 1); assert.equal(first.messages.at(-1).error, "pose_rate_limit");
  f.advance(); await f.pose(first, laterPose, 0); assert.equal(first.messages.at(-1).error, "stale_pose");
  await f.pose(first, { position: [0,2000,0], yaw: 0 }, 1); assert.equal(first.messages.at(-1).error, "invalid_pose");
  assert.equal(f.control.puts.length, beforeWrites); assertPose(f.live().pose, currentPose);
});
