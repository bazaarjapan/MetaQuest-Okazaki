import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { SchoolRoom } from "../worker/school-room.mjs";

const migration = await readFile(new URL("../migrations/0001_school_worlds.sql", import.meta.url), "utf8");
const clock = 1801332000000, now = Math.floor(clock / 1000);

class Socket {
  constructor(attachment) { this.readyState = 1; this.attachment = structuredClone(attachment); this.messages = []; }
  deserializeAttachment() { return structuredClone(this.attachment); }
  serializeAttachment(attachment) {
    if (this.failAttachment) throw Error("injected attachment storage failure");
    this.attachment = structuredClone(attachment);
  }
  send(data) {
    if (this.failSend || this.readyState !== 1) throw Error("injected recipient send failure");
    this.messages.push(JSON.parse(data));
  }
  close(code) { this.readyState = 3; this.closeCode = code; }
}
async function setup(t) {
  const sqlite = new DatabaseSync(":memory:"); sqlite.exec(migration); t.after(() => sqlite.close());
  const control = { failBatches: 0, batches: 0, failWorldWrites: 0, committedWriteError: false, failCleanupWrites: 0, failJournalWrites: 0, committedJournalError: false };
  const db = {
    prepare(sql) { return { bind(...values) {
      const statement = sqlite.prepare(sql);
      const runSync = () => { const result = statement.run(...values); return { success: true, meta: { changes: Number(result.changes) } }; };
      return { async first() { const row = statement.get(...values); return row ? { ...row } : null; },
        async all() { return { results: statement.all(...values).map((row) => ({ ...row })), success: true }; },
        async run() { return runSync(); }, runSync };
    } }; },
    async batch(statements) {
      control.batches++; sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) {
          results.push(statement.runSync());
          // Failure after a SQL statement, not only before execution, verifies
          // that the D1 batch transaction does not expose its partial mirror.
          if (control.failBatches > 0) { control.failBatches--; throw Error("injected D1 transaction failure"); }
        }
        sqlite.exec("COMMIT"); return results;
      } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
  };
  const worldId = crypto.randomUUID(), teacherId = crypto.randomUUID(), studentIds = [crypto.randomUUID(), crypto.randomUUID()];
  const users = [teacherId, ...studentIds].map((id, index) => ({ id, role: index === 0 ? "teacher" : "student", tokenHash: String(index + 1).repeat(64), avatar: { name: `Fixture ${index}`, color: "#4a90e2" } }));
  const originalPoses = [JSON.stringify({ position: [10,40,20], yaw: 0.1 }), JSON.stringify({ position: [30,40,40], yaw: 0.2 }), null];
  for (let i = 0; i < users.length; i++) {
    const user = users[i];
    sqlite.prepare("INSERT INTO school_users VALUES(?,?,?,?,?)").run(user.id, `restore-fixture-${i}`, user.role, JSON.stringify(user.avatar), now);
    sqlite.prepare("INSERT INTO school_sessions VALUES(?,?,?,?,?)").run(user.tokenHash, user.id, `fixture-csrf-${i}`, now + 3600, now);
  }
  sqlite.prepare("INSERT INTO school_worlds VALUES(?,?,?,?,?)").run(worldId, teacherId, "Restore fixture", "FIXTUREABCDE", now);
  for (let i = 0; i < users.length; i++) sqlite.prepare("INSERT INTO school_members VALUES(?,?,?,?)").run(worldId, users[i].id, originalPoses[i], now);
  const assetId = crypto.randomUUID(), snapshotId = crypto.randomUUID();
  sqlite.prepare("INSERT INTO school_assets VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(assetId, worldId, studentIds[0], "fixture/nonpublic.stl", "fixture.stl", "y", "m", 1, 1, "a".repeat(64), "ready", now);
  const object = { id: crypto.randomUUID(), assetId, ownerId: studentIds[0], name: "fixture.stl",
    position: [0,20,0], rotation: [0.1,0.2,0.3], scale: [1,1,1], bounds: { min: [0,20,0], max: [1,21,1] }, triangles: 1 };
  const poses = { [teacherId]: { position: [-10,60,-20], yaw: 0.3 }, [studentIds[0]]: { position: [-30,60,-40], yaw: 0.4 } };
  const snapshot = { schema: 1, worldId, revision: 9, objects: [object], poses };
  sqlite.prepare("INSERT INTO school_snapshots VALUES(?,?,?,?,?,?)").run(snapshotId, worldId, teacherId, 9, JSON.stringify(snapshot), now);
  const stored = new Map([["world-state", { worldId, revision: 0, objects: [], recent: [] }]]);
  const sockets = users.map((user, i) => new Socket({ userId: user.id, sessionHash: user.tokenHash, expiresAt: now + 3600,
    avatar: { ...user.avatar, id: user.id, role: user.role }, pose: originalPoses[i] ? JSON.parse(originalPoses[i]) : { position: [50,40,60], yaw: 0.5 }, lastSeenAt: clock }));
  const ctx = { stored, getWebSockets() { return sockets.filter((socket) => socket.readyState === 1); }, blockConcurrencyWhile(fn) { return fn(); },
    storage: { async get(key) { return structuredClone(stored.get(key)); },
      async put(key, value) {
        if (key === "restore-recovery" && value && control.failJournalWrites > 0) {
          control.failJournalWrites--;
          if (control.committedJournalError) stored.set(key, structuredClone(value));
          throw Error("injected journal write failure");
        }
        if (key === "restore-recovery" && value === null && control.failCleanupWrites > 0) { control.failCleanupWrites--; throw Error("injected journal cleanup failure"); }
        if (key === "world-state" && control.failWorldWrites > 0) {
          control.failWorldWrites--;
          if (control.committedWriteError) stored.set(key, structuredClone(value));
          throw Error("injected authoritative write failure");
        }
        stored.set(key, structuredClone(value));
      }, async setAlarm(value) { ctx.alarmAt = value; } } };
  const env = { DB: db };
  const room = new SchoolRoom(ctx, env, { now: () => clock }); await room.ready;
  const teacherRequest = (path, data = null) => new Request(`https://room.internal${path}`, {
    method: data === null ? "GET" : "POST", headers: { "X-School-Context": JSON.stringify({ worldId, sessionHash: users[0].tokenHash }) },
    ...(data === null ? {} : { body: JSON.stringify(data) }),
  });
  const restore = (target = room) => target.fetch(teacherRequest("/restore", { snapshotId, revision: 0 }));
  const mirror = () => sqlite.prepare("SELECT user_id,pose_json FROM school_members ORDER BY user_id").all().map((row) => ({ ...row }));
  const baseline = mirror();
  return { room, ctx, env, control, sockets, users, snapshot, object, restore, teacherRequest, mirror, baseline };
}

test("restore D1 batch failure leaves authoritative revision, objects, mirror and notifications unchanged", async (t) => {
  const s = await setup(t); s.control.failBatches = 1;
  const result = await s.restore();
  assert.equal(result.status, 500); assert.equal((await result.json()).error, "internal_error");
  assert.equal(s.room.state.revision, 0); assert.deepEqual(s.room.state.objects, []);
  assert.equal(s.ctx.stored.get("world-state").revision, 0); assert.deepEqual(s.mirror(), s.baseline);
  assert.equal(s.ctx.stored.get("restore-recovery"), null); assert.equal(s.room.restoreRecovery, null);
  assert.ok(s.sockets.every((socket) => socket.messages.length === 0));
});
test("failed DO authoritative write rolls its previously successful D1 mirror back", async (t) => {
  const s = await setup(t); s.control.failWorldWrites = 1;
  const result = await s.restore();
  assert.equal(result.status, 500); assert.equal(s.control.batches, 2);
  assert.equal(s.room.state.revision, 0); assert.equal(s.ctx.stored.get("world-state").revision, 0);
  assert.deepEqual(s.mirror(), s.baseline); assert.equal(s.ctx.stored.get("restore-recovery"), null);
  assert.ok(s.sockets.every((socket) => socket.messages.length === 0));
});
test("journal write failure cannot alter either store or publish a restore", async (t) => {
  const s = await setup(t); s.control.failJournalWrites = 1;
  assert.equal((await s.restore()).status, 500); assert.equal(s.control.batches, 0);
  assert.equal(s.ctx.stored.get("world-state").revision, 0); assert.deepEqual(s.mirror(), s.baseline);
  assert.equal(s.room.restoreRecovery, null); assert.ok(s.sockets.every((socket) => socket.messages.length === 0));
});
test("uncertain persisted journal write is resolved before a later unrelated edit can advance revision", async (t) => {
  const s = await setup(t); s.control.failJournalWrites = 1; s.control.committedJournalError = true;
  assert.equal((await s.restore()).status, 500);
  assert.equal(s.control.batches, 1); assert.deepEqual(s.mirror(), s.baseline);
  assert.equal(s.room.state.revision, 0); assert.equal(s.ctx.stored.get("restore-recovery"), null);
  assert.equal(s.room.restoreRecovery, null); assert.ok(s.sockets.every((socket) => socket.messages.length === 0));
});
test("unavailable rollback returns 503, keeps durable recovery and recovers after restart without live sockets", async (t) => {
  const s = await setup(t); s.control.failWorldWrites = 1; s.control.failBatches = 0;
  const normalBatch = s.env.DB.batch;
  // Initial D1 mirror succeeds, DO commit fails, and its rollback DB is unavailable.
  s.env.DB.batch = async (statements) => {
    if (s.control.batches >= 1) { s.control.failBatches = 1; }
    return normalBatch(statements);
  };
  const response = await s.restore(); assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "restore_recovery_pending");
  assert.equal(s.room.state.revision, 0); assert.equal(s.ctx.stored.get("world-state").revision, 0);
  assert.ok(s.ctx.stored.get("restore-recovery")); assert.equal(s.ctx.alarmAt, clock + 1000);
  assert.notDeepEqual(s.mirror(), s.baseline);
  assert.equal((await s.room.fetch(s.teacherRequest("/state"))).status, 503);
  s.env.DB.batch = normalBatch; s.control.failBatches = 0;
  for (const socket of s.sockets) socket.close(1000);
  const restarted = new SchoolRoom(s.ctx, s.env, { now: () => clock }); await restarted.ready;
  assert.ok(restarted.restoreRecovery); assert.equal(restarted.sessions.size, 0);
  await restarted.alarm();
  assert.equal(restarted.restoreRecovery, null); assert.equal(s.ctx.stored.get("restore-recovery"), null);
  assert.equal(restarted.state.revision, 0); assert.deepEqual(s.mirror(), s.baseline);
});
test("uncertain committed storage error reads authoritative commit and completes mirror and notification", async (t) => {
  const s = await setup(t); s.control.failWorldWrites = 1; s.control.committedWriteError = true;
  const result = await s.restore();
  assert.equal(result.status, 200); assert.equal((await result.json()).revision, 1);
  assert.equal(s.room.state.revision, 1); assert.deepEqual(s.room.state.objects[0], s.object);
  assert.equal(s.ctx.stored.get("restore-recovery"), null);
  for (const socket of s.sockets) assert.ok(socket.messages.some((message) => message.type === "state" && message.revision === 1));
  const mirror = Object.fromEntries(s.mirror().map((row) => [row.user_id, row.pose_json]));
  for (const [userId, pose] of Object.entries(s.snapshot.poses)) assert.deepEqual(JSON.parse(mirror[userId]), pose);
  assert.deepEqual(s.sockets[1].attachment.pose, s.snapshot.poses[s.users[1].id]);
});
test("one failed restore recipient is removed and every healthy recipient still receives committed state", async (t) => {
  const s = await setup(t); s.sockets[0].failSend = true;
  const result = await s.restore(); assert.equal(result.status, 200); assert.equal((await result.json()).revision, 1);
  assert.equal(s.room.sessions.size, 2); assert.equal(s.sockets[0].closeCode, 1011);
  for (const socket of s.sockets.slice(1)) {
    const state = socket.messages.find((message) => message.type === "state");
    assert.equal(state.revision, 1); assert.deepEqual(state.objects[0], s.object);
    assert.equal(socket.messages.at(-1).type, "participants"); assert.equal(socket.messages.at(-1).participants.length, 2);
  }
  assert.deepEqual(s.ctx.stored.get("world-state").objects[0], s.object);
});
test("one failed attachment is isolated like a failed send and cannot interrupt remaining recipients", async (t) => {
  const s = await setup(t); s.sockets[0].failAttachment = true;
  assert.equal((await s.restore()).status, 200); assert.equal(s.sockets[0].closeCode, 1011);
  assert.ok(s.sockets.slice(1).every((socket) => socket.messages.some((message) => message.type === "state" && message.revision === 1)));
});
test("committed restore with failed journal cleanup is explicit pending and retries forward after restart", async (t) => {
  const s = await setup(t); s.control.failCleanupWrites = 10;
  const result = await s.restore(); assert.equal(result.status, 503); assert.equal((await result.json()).error, "restore_recovery_pending");
  assert.equal(s.ctx.stored.get("world-state").revision, 1); assert.deepEqual(s.ctx.stored.get("world-state").objects[0], s.object);
  assert.ok(s.ctx.stored.get("restore-recovery")); assert.equal(s.ctx.alarmAt, clock + 1000);
  assert.ok(s.sockets.every((socket) => socket.messages.some((message) => message.type === "state" && message.revision === 1)));
  s.control.failCleanupWrites = 0;
  const restarted = new SchoolRoom(s.ctx, s.env, { now: () => clock }); await restarted.ready;
  const state = await restarted.fetch(s.teacherRequest("/state")); assert.equal(state.status, 200);
  assert.equal((await state.json()).revision, 1); assert.equal(restarted.restoreRecovery, null);
  assert.equal(s.ctx.stored.get("restore-recovery"), null); assert.equal(restarted.sessions.size, 3);
  assert.deepEqual(s.sockets[1].attachment.pose, s.snapshot.poses[s.users[1].id]);
  assert.deepEqual(s.sockets[1].messages.filter((message) => message.type === "state").at(-1).participants.find((person) => person.id === s.users[1].id).position, s.snapshot.poses[s.users[1].id].position);
});
test("recovery requires the exact restore commit marker rather than an unrelated matching revision", async (t) => {
  const s = await setup(t); s.control.failCleanupWrites = 1;
  assert.equal((await s.restore()).status, 503);
  const committed = s.ctx.stored.get("world-state");
  // A durable journal without its matching authoritative commit must roll back,
  // even when another durable state happens to have the intended revision.
  s.ctx.stored.set("world-state", { ...committed, restoreCommit: crypto.randomUUID(), objects: [] });
  const restarted = new SchoolRoom(s.ctx, s.env, { now: () => clock }); await restarted.ready;
  await restarted.alarm();
  assert.equal(restarted.state.revision, 1); assert.deepEqual(restarted.state.objects, []);
  assert.deepEqual(s.mirror(), s.baseline); assert.equal(s.ctx.stored.get("restore-recovery"), null);
});
