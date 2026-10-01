import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { assetReservationPolicy, all, completeAssetReservation, createUser, first,
  reserveAsset, run } from "../worker/school-store.mjs";
import { reconcileStaleAssetReservations, uploadAsset } from "../worker/school-assets.mjs";
import { LIMITS, sha256 } from "../worker/school-common.mjs";

const migration = await readFile(new URL("../migrations/0001_school_worlds.sql", import.meta.url), "utf8");
const baseTime = 1801332000;
const triangle = new TextEncoder().encode("solid test\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid test\n");
function deferred() {
  let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(predicate) {
  const expiresAt = Date.now() + 3000;
  while (Date.now() < expiresAt) {
    if (await predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw Error("unit fixture did not settle");
}
async function setup() {
  const sqlite = new DatabaseSync(":memory:"); sqlite.exec(migration);
  const faults = [];
  const db = { prepare(sql) { return { bind(...args) {
    const statement = sqlite.prepare(sql);
    async function call(method, operation) {
      const index = faults.findIndex((fault) => fault.method === method && fault.sql.test(sql));
      const fault = index >= 0 ? faults.splice(index, 1)[0] : null;
      if (fault && !fault.after) throw fault.error;
      const result = operation();
      if (fault) throw fault.error;
      return result;
    }
    return {
      first: () => call("first", () => { const row = statement.get(...args); return row ? { ...row } : null; }),
      all: () => call("all", () => ({ results: statement.all(...args).map((row) => ({ ...row })) })),
      run: () => call("run", () => ({ meta: { changes: Number(statement.run(...args).changes) } })),
    };
  } }; } };
  const user = await createUser(db, { sub: "owner" }, "student", baseTime);
  const other = await createUser(db, { sub: "other" }, "student", baseTime);
  const worldId = crypto.randomUUID(), otherWorldId = crypto.randomUUID();
  for (const id of [worldId, otherWorldId]) await run(db,
    "INSERT INTO school_worlds(id,teacher_id,name,join_code,created_at) VALUES(?,?,?,?,?)",
    id, user.id, "fixture", crypto.randomUUID().slice(0, 12), baseTime);
  const objects = new Map(), puts = [], deletes = [], timers = new Map();
  let elapsedMs = 0, nextTimer = 0, putHook = null, deleteHook = null;
  const bucket = {
    async put(key, value) { puts.push(key); if (putHook) await putHook(key, value); objects.set(key, new Uint8Array(value).slice()); },
    async delete(key) { deletes.push(key); if (deleteHook) await deleteHook(key); objects.delete(key); },
  };
  const env = { DB: db, STL_BUCKET: bucket };
  const options = { nowMilliseconds: () => elapsedMs,
    setTimeoutImpl(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, due: elapsedMs + delay }); return id; },
    clearTimeoutImpl(id) { timers.delete(id); } };
  const now = () => baseTime + Math.floor(elapsedMs / 1000);
  function advance(seconds, fireTimers = false) {
    elapsedMs += seconds * 1000;
    if (fireTimers) for (const [id, timer] of [...timers]) if (timer.due <= elapsedMs) {
      timers.delete(id); timer.callback();
    }
  }
  async function asset({ owner = user, world = worldId, bytes = triangle.byteLength,
    reservedAt = now(), ready = false, stored = true } = {}) {
    const id = crypto.randomUUID(), value = { id, world_id: world, owner_id: owner.id,
      object_key: `${world}/${owner.id}/${id}.stl`, name: "test.stl", up_axis: "y", units: "m",
      bytes, triangles: 1, sha256: await sha256(triangle) };
    await reserveAsset(db, owner, world, value, reservedAt);
    if (ready) await completeAssetReservation(db, owner, world, value, reservedAt, reservedAt);
    if (stored) objects.set(value.object_key, triangle.slice());
    return { ...value, status: ready ? "ready" : "pending", created_at: reservedAt };
  }
  function request(body = triangle) {
    return new Request(`https://example.invalid/api/worlds/${worldId}/assets`, { method: "POST",
      headers: { "Content-Type": "model/stl", "X-Up-Axis": "y", "X-Units": "m", "X-Filename": "test.stl" },
      body, ...(body instanceof ReadableStream ? { duplex: "half" } : {}) });
  }
  return { sqlite, db, env, user, other, worldId, otherWorldId, objects, puts, deletes, asset, now, advance,
    options, timers, fault(sql, method, error, after = false) { faults.push({ sql, method, error, after }); },
    putHook(value) { putHook = value; }, deleteHook(value) { deleteHook = value; },
    upload(body = triangle) { return uploadAsset(request(body), env, user, worldId, now(), options); },
    cleanup(owner = user, world = worldId) { return reconcileStaleAssetReservations(env, owner, world, now(), options); },
    rows: () => all(db, "SELECT * FROM school_assets ORDER BY id"), close: () => sqlite.close() };
}

test("interrupted ten-slot/25MiB reservations expire and orphan cleanup releases quotas without touching ready originals", async () => {
  const s = await setup();
  const old = s.now() - assetReservationPolicy.leaseSeconds - 1;
  for (let i = 0; i < 10; i++) await s.asset({ reservedAt: old, bytes: LIMITS.userAssetBytes / 10 });
  const original = await s.asset({ owner: s.other, reservedAt: old, ready: true });
  const otherWorld = await s.asset({ world: s.otherWorldId, reservedAt: old });
  const result = await s.cleanup(); assert.equal(result.claimed, 10); assert.equal(result.removed, 10);
  assert.equal(s.objects.has(original.object_key), true); assert.equal(s.objects.has(otherWorld.object_key), true);
  assert.equal((await s.rows()).length, 2);
  const ready = await s.upload(); assert.equal(ready.ownerId, s.user.id);
  assert.equal((await first(s.db, "SELECT COUNT(*) AS n FROM school_assets WHERE status='ready'")).n, 2);
  s.close();
});

test("fresh six-MiB pending leases remain counted and atomic concurrent reservations cannot exceed byte or count quotas", async () => {
  const s = await setup();
  const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => s.asset({ bytes: LIMITS.stlBytes })));
  assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 4);
  assert.equal(attempts.filter((item) => item.status === "rejected" && item.reason.code === "asset_quota_exceeded").length, 4);
  s.advance(assetReservationPolicy.leaseSeconds - 1);
  assert.equal((await s.cleanup()).claimed, 0); assert.equal((await s.rows()).length, 4); assert.equal(s.deletes.length, 0);
  s.close();
  const slots = await setup();
  const counted = await Promise.allSettled(Array.from({ length: 15 }, () => slots.asset({ stored: false })));
  assert.equal(counted.filter((item) => item.status === "fulfilled").length, 10);
  assert.equal(counted.filter((item) => item.status === "rejected" && item.reason.code === "asset_quota_exceeded").length, 5);
  slots.close();
});

test("cleanup-query failure cannot make expired slots or bytes permanently quota-counted", async () => {
  const s = await setup(), old = s.now() - assetReservationPolicy.leaseSeconds - 1;
  const expired = [];
  for (let i = 0; i < 10; i++) expired.push(await s.asset({ reservedAt: old, bytes: LIMITS.userAssetBytes / 10 }));
  s.fault(/UPDATE school_assets SET created_at/, "all", Error("cleanup D1 unavailable"));
  const ready = await s.upload(); assert.equal((await s.rows()).length, 11);
  await assert.rejects(completeAssetReservation(s.db, s.user, s.worldId, expired[0], old, s.now()),
    (error) => error.code === "asset_reservation_expired");
  await s.cleanup(); assert.equal((await s.rows()).length, 1);
  assert.equal((await s.rows())[0].id, ready.id); assert.equal((await s.rows())[0].status, "ready"); s.close();
});

test("a normal delayed six-MiB upload is not reclaimed by a concurrent cleaner and becomes ready with original hash", async () => {
  const s = await setup(), gate = deferred(); s.putHook(() => gate.promise);
  const bytes = new Uint8Array(LIMITS.stlBytes).fill(10); bytes.set(triangle);
  const pending = s.upload(bytes); await until(() => s.puts.length === 1);
  s.advance(60);
  assert.equal((await s.cleanup()).claimed, 0); assert.equal(s.deletes.length, 0);
  gate.resolve(); const ready = await pending;
  assert.equal(ready.bytes, LIMITS.stlBytes); assert.equal(ready.sha256, await sha256(bytes));
  assert.deepEqual(s.objects.get(s.puts[0]), bytes); assert.equal((await s.rows())[0].status, "ready");
  s.close();
});

test("D1 cleanup failure cannot mask a PUT error and its retired ledger retries on next owner upload", async () => {
  const s = await setup(), original = Error("PUT failure");
  s.putHook(() => { throw original; });
  s.fault(/DELETE FROM school_assets/, "run", Error("D1 delete failed"));
  await assert.rejects(s.upload(), (error) => error === original);
  const retained = (await s.rows())[0]; assert.equal(retained.status, "pending"); assert.ok(retained.created_at < 0);
  s.putHook(null); await s.upload();
  assert.equal((await s.rows()).length, 1); assert.equal((await s.rows())[0].status, "ready");
  assert.ok(s.deletes.filter((key) => key === retained.object_key).length >= 2);
  s.close();
});

test("R2 deletion failure retains retry ledger, does not occupy quotas, and never deletes another owner or ready asset", async () => {
  const s = await setup(), original = await s.asset({ ready: true });
  const stale = await s.asset({ reservedAt: s.now() - assetReservationPolicy.leaseSeconds - 1 });
  s.deleteHook(() => { throw Error("R2 delete failed"); });
  assert.equal((await s.cleanup()).removed, 0);
  assert.ok((await first(s.db, "SELECT created_at FROM school_assets WHERE id=?", stale.id)).created_at < 0);
  assert.equal(s.objects.has(original.object_key), true);
  s.deleteHook(null); await s.upload();
  assert.equal(await first(s.db, "SELECT id FROM school_assets WHERE id=?", stale.id), null);
  assert.equal(s.objects.has(stale.object_key), false); assert.equal(s.objects.has(original.object_key), true);
  assert.ok(!s.deletes.includes(original.object_key)); s.close();
});

test("failed retirement D1 write keeps original error and positive lease is reclaimed after TTL", async () => {
  const s = await setup(), failure = Error("PUT failed"); s.putHook(() => { throw failure; });
  s.fault(/UPDATE school_assets SET created_at/, "first", Error("D1 retirement failed"));
  await assert.rejects(s.upload(), (error) => error === failure);
  assert.ok((await s.rows())[0].created_at >= 0); assert.equal(s.deletes.length, 0);
  s.advance(assetReservationPolicy.leaseSeconds); s.putHook(null); await s.upload();
  assert.equal((await s.rows()).length, 1); assert.equal((await s.rows())[0].status, "ready"); s.close();
});

test("lost ready-write response reconciles successful immutable asset instead of deleting its original", async () => {
  const s = await setup(); s.fault(/UPDATE school_assets SET status='ready'/, "first", Error("response lost"), true);
  const ready = await s.upload();
  assert.equal((await s.rows())[0].id, ready.id); assert.equal((await s.rows())[0].status, "ready");
  assert.deepEqual(s.objects.get(s.puts[0]), triangle); assert.equal(s.deletes.length, 0); s.close();
});

test("ready original survives lost commit response plus failed reconciliation reads", async () => {
  const s = await setup(), original = Error("commit response lost");
  s.fault(/UPDATE school_assets SET status='ready'/, "first", original, true);
  s.fault(/SELECT \* FROM school_assets WHERE id=/, "first", Error("read unavailable"));
  s.fault(/SELECT \* FROM school_assets WHERE id=/, "first", Error("read unavailable"));
  await assert.rejects(s.upload(), (error) => error === original);
  assert.equal((await s.rows())[0].status, "ready"); assert.equal(s.deletes.length, 0);
  assert.deepEqual(s.objects.get(s.puts[0]), triangle); s.close();
});

test("parallel stale cleaners atomically retire before delete; delayed finalization is rejected without phantom success", async () => {
  const s = await setup(), gate = deferred(), old = s.now() - assetReservationPolicy.leaseSeconds - 1;
  const stale = await s.asset({ reservedAt: old }), original = await s.asset({ ready: true });
  s.deleteHook(() => gate.promise);
  const firstCleaner = s.cleanup(); await until(() => s.deletes.length >= 1);
  const secondCleaner = s.cleanup(); await until(() => s.deletes.length >= 2);
  await assert.rejects(completeAssetReservation(s.db, s.user, s.worldId, stale, old, old + 1),
    (error) => error.code === "asset_reservation_expired");
  gate.resolve(); await Promise.all([firstCleaner, secondCleaner]);
  assert.equal(await first(s.db, "SELECT id FROM school_assets WHERE id=?", stale.id), null);
  assert.equal(s.objects.has(stale.object_key), false); assert.equal(s.objects.has(original.object_key), true);
  assert.equal((await s.rows()).length, 1); s.close();
});

test("bounded PUT timeout retains deferred ledger and cleans late completion without publishing expired asset", async () => {
  const s = await setup(), gate = deferred(); s.putHook(() => gate.promise);
  const pending = s.upload(); const rejected = assert.rejects(pending, (error) => error.code === "asset_upload_timeout");
  await until(() => s.puts.length === 1); s.advance(assetReservationPolicy.uploadTimeoutMs / 1000, true); await rejected;
  assert.ok((await s.rows())[0].created_at < 0); assert.equal((await s.cleanup()).claimed, 0);
  gate.resolve(); await until(async () => (await s.rows()).length === 0 && s.objects.size === 0);
  assert.equal((await first(s.db, "SELECT COUNT(*) AS n FROM school_assets WHERE status='ready'")).n, 0);
  s.close();
});

test("upload whose lease was reclaimed cannot report success when finalization changes no row", async () => {
  const s = await setup(), gate = deferred(); s.putHook(() => gate.promise);
  const pending = s.upload(); const rejected = assert.rejects(pending, (error) => error.code === "asset_reservation_expired");
  await until(() => s.puts.length === 1);
  // Explicit scheduler fault: this original isolate cannot observe its timeout
  // while another request's cleanup sees the expired server-clock lease.
  s.advance(assetReservationPolicy.leaseSeconds, false); await s.cleanup();
  gate.resolve(); await rejected;
  await until(async () => (await s.rows()).length === 0 && s.objects.size === 0);
  s.close();
});

test("a late timed-out PUT after stale ledger deletion removes its orphan but cannot touch ready data", async () => {
  const s = await setup(), original = await s.asset({ ready: true }), gate = deferred(); s.putHook(() => gate.promise);
  const pending = s.upload(); const rejected = assert.rejects(pending, (error) => error.code === "asset_upload_timeout");
  await until(() => s.puts.length === 1); s.advance(assetReservationPolicy.uploadTimeoutMs / 1000, true); await rejected;
  s.advance(assetReservationPolicy.leaseSeconds); await s.cleanup(); assert.equal((await s.rows()).length, 1);
  gate.resolve(); await until(() => !s.objects.has(s.puts[0]) && s.deletes.filter((key) => key === s.puts[0]).length >= 2);
  assert.equal(s.objects.has(original.object_key), true); assert.equal((await s.rows())[0].status, "ready"); s.close();
});

test("slow body consumption starts lease at reservation, not request creation time", async () => {
  const s = await setup(), gate = deferred(); let began = false;
  const body = new ReadableStream({ async pull(controller) {
    if (began) return; began = true; await gate.promise; controller.enqueue(triangle); controller.close();
  } });
  const pending = s.upload(body); await until(() => began);
  s.advance(assetReservationPolicy.leaseSeconds + 5); gate.resolve(); await pending;
  assert.equal((await s.rows())[0].created_at, s.now()); assert.equal((await s.rows())[0].status, "ready"); s.close();
});

test("a corrupted pending key is retired and excluded from quota but never used for arbitrary R2 deletion", async () => {
  const s = await setup(), original = await s.asset({ ready: true });
  const stale = await s.asset({ reservedAt: s.now() - assetReservationPolicy.leaseSeconds - 1 });
  await run(s.db, "UPDATE school_assets SET object_key=? WHERE id=?", "another-owner/original.stl", stale.id);
  s.objects.set("another-owner/original.stl", triangle.slice());
  assert.equal((await s.cleanup()).removed, 0); assert.equal(s.deletes.length, 0);
  assert.equal(s.objects.has(original.object_key), true); assert.equal(s.objects.has("another-owner/original.stl"), true); s.close();
});
