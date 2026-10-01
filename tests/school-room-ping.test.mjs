import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { SchoolRoom } from "../worker/school-room.mjs";
import { createUser, createSession, createWorld } from "../worker/school-store.mjs";

const migration = await readFile(new URL("../migrations/0001_school_worlds.sql", import.meta.url), "utf8");
async function fixture(t) {
  const sqlite = new DatabaseSync(":memory:"); sqlite.exec(migration); t.after(() => sqlite.close());
  const db = { prepare(sql) { return { bind(...args) {
    const statement = sqlite.prepare(sql);
    const runSync = () => ({ success: true, meta: { changes: Number(statement.run(...args).changes) } });
    return {
      async first() { return statement.get(...args) ?? null; },
      async all() { return { results: statement.all(...args) }; },
      async run() { return runSync(); }, runSync,
    };
  } }; }, async batch(statements) {
    sqlite.exec("BEGIN");
    try { const result = statements.map((statement) => statement.runSync()); sqlite.exec("COMMIT"); return result; }
    catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  } };
  let clock = 1801332000000;
  const now = () => Math.floor(clock / 1000);
  const user = await createUser(db, { sub: "ping-fixture" }, "teacher", now());
  const session = await createSession(db, user.id, now());
  const world = await createWorld(db, user, {}, now());
  const stored = new Map([["world-state", { worldId: world.id, revision: 0, objects: [], recent: [] }]]);
  const socket = {
    readyState: 1, messages: [],
    attachment: { userId: user.id, sessionHash: session.hash, expiresAt: session.expiresAt,
      avatar: { id: user.id, role: "teacher", name: "先生", color: "#4a90e2" },
      pose: { position: [0,40,0], yaw: 0 }, lastSeq: -1,
      lastPoseAt: -1e15, lastEditAt: -1e15, lastSeenAt: clock,
      rateWindowAt: clock, rateCount: 0 },
    send(value) { this.messages.push(JSON.parse(value)); },
    close() { this.readyState = 3; },
    serializeAttachment(value) { this.attachment = structuredClone(value); },
    deserializeAttachment() { return structuredClone(this.attachment); },
  };
  const ctx = { getWebSockets: () => socket.readyState === 1 ? [socket] : [], blockConcurrencyWhile: (fn) => fn(),
    storage: { get: async (key) => structuredClone(stored.get(key)), put: async (key, value) => stored.set(key, structuredClone(value)), setAlarm: async () => {} } };
  const env = { DB: db }, dependencies = { now: () => clock };
  let room = new SchoolRoom(ctx, env, dependencies); await room.ready;
  return { socket, nowMs: () => clock, advance: (ms) => { clock += ms; },
    ping: () => room.webSocketMessage(socket, JSON.stringify({ type: "ping" })),
    pose: (seq = 0) => room.webSocketMessage(socket, JSON.stringify({ type: "pose", position: [seq,40,0], yaw: 0, seq, restoreCommit: null })),
    attachment: () => room.sessions.get(socket),
    async reload() { room = new SchoolRoom(ctx, env, dependencies); await room.ready; return room; },
  };
}

test("normal heartbeat succeeds a few milliseconds after pose; rapid pings use their own budget", async (t) => {
  const f = await fixture(t);
  await f.pose(); assert.equal(f.socket.messages.at(-1).type, "pose");
  f.advance(5); await f.ping(); assert.equal(f.socket.messages.at(-1).type, "pong");
  assert.equal(f.attachment().lastSeenAt, f.nowMs()); assert.equal(f.attachment().lastPingAt, f.nowMs());
  f.advance(99); await f.ping(); assert.equal(f.socket.messages.at(-1).error, "ping_rate_limit");
  f.advance(1); await f.ping(); assert.equal(f.socket.messages.at(-1).type, "pong");
  f.advance(1); await f.pose(1); assert.equal(f.socket.messages.at(-1).type, "pose");
  assert.equal(f.attachment().lastSeenAt, f.nowMs()); assert.equal(f.attachment().lastPingAt, f.nowMs() - 1);
});

test("new ping timestamp survives DO hibernation and an old attachment gets a compatible initial ping", async (t) => {
  const f = await fixture(t);
  assert.equal(f.attachment().lastPingAt, undefined);
  await f.ping(); assert.equal(f.socket.messages.at(-1).type, "pong");
  const pingAt = f.nowMs(); await f.reload(); assert.equal(f.attachment().lastPingAt, pingAt);
  f.advance(50); await f.ping(); assert.equal(f.socket.messages.at(-1).error, "ping_rate_limit");
  f.advance(50); await f.ping(); assert.equal(f.socket.messages.at(-1).type, "pong");
  // Emulate a still-attached socket created by the previous Worker version.
  delete f.socket.attachment.lastPingAt; await f.reload();
  f.advance(1); await f.pose(0); assert.equal(f.socket.messages.at(-1).type, "pose");
  await f.ping(); assert.equal(f.socket.messages.at(-1).type, "pong");
});

test("nonfinite and future attached ping timestamps clamp, reject immediately, and recover after100ms", async (t) => {
  const f = await fixture(t);
  for (const invalid of [NaN, Infinity, -Infinity, "0", null, f.nowMs() + 1000000]) {
    f.socket.attachment.lastPingAt = invalid; await f.reload();
    const beforeSeen = f.attachment().lastSeenAt;
    await f.ping(); assert.equal(f.socket.messages.at(-1).error, "ping_rate_limit");
    assert.equal(f.socket.attachment.lastPingAt, f.nowMs()); assert.ok(Number.isFinite(f.socket.attachment.lastPingAt));
    assert.equal(f.attachment().lastSeenAt, beforeSeen);
    f.advance(100); await f.ping(); assert.equal(f.socket.messages.at(-1).type, "pong");
    f.advance(1000); // Keep the independent20-packets/second cap out of this fixture.
  }
});
