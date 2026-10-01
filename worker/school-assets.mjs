import { normalizeSTLPositions, parseSTL } from "../src/stl-model.js";
import { LIMITS, SchoolError, cleanName, fail, readBounded, sha256 } from "./school-common.mjs";
import { assetPublic, assetReservation, assetReservationPolicy, claimStaleAssetReservations,
  completeAssetReservation, getAsset, removeRetiredAssetReservation, reserveAsset,
  retireAssetReservation } from "./school-store.mjs";

function deadline(task, milliseconds, options, code) {
  const setTimer = options.setTimeoutImpl ?? globalThis.setTimeout;
  const clearTimer = options.clearTimeoutImpl ?? globalThis.clearTimeout;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimer(() => reject(new SchoolError(504, code)), milliseconds);
  });
  return Promise.race([task, timeout]).finally(() => clearTimer(timer));
}
function ownedKey(asset, session, worldId) {
  return asset.world_id === worldId && asset.owner_id === session.id &&
    asset.object_key === `${worldId}/${session.id}/${asset.id}.stl`;
}
async function removeRetired(env, session, worldId, asset) {
  // Never delete by a stored arbitrary key or by a ready row. The preceding
  // atomic claim prevents any legitimate finalize from reviving this lease.
  if (asset.status !== "pending" || asset.created_at >= 0 || !ownedKey(asset, session, worldId)) return false;
  await env.STL_BUCKET.delete(asset.object_key);
  await removeRetiredAssetReservation(env.DB, session, worldId, asset);
  return true;
}
export async function reconcileStaleAssetReservations(env, session, worldId, now, options = {}) {
  const claimed = await claimStaleAssetReservations(env.DB, session, worldId, now);
  // Bound the owner/world scope and cleanup request time. Failed R2/D1 deletes
  // retain the negative ledger for another upload's idempotent retry. There is
  // no bucket-wide scan and no deletion of already ready assets.
  const attempts = Promise.all(claimed.map(async (asset) => {
    try { return await removeRetired(env, session, worldId, asset); }
    catch { return false; }
  }));
  try {
    const removed = await deadline(attempts, assetReservationPolicy.cleanupTimeoutMs, options, "asset_cleanup_timeout");
    return { claimed: claimed.length, removed: removed.filter(Boolean).length };
  } catch { return { claimed: claimed.length, removed: 0 }; }
}

export async function uploadAsset(request, env, session, worldId, now, options = {}) {
  const wallNow = options.nowMilliseconds ?? (() => Date.now()), started = wallNow();
  const currentTime = () => now + Math.floor(Math.max(0, wallNow() - started) / 1000);
  if (!/^(?:application\/octet-stream|model\/stl)(?:;|$)/i.test(request.headers.get("Content-Type") ?? "")) fail(415, "stl_required");
  const upAxis = request.headers.get("X-Up-Axis") ?? "z", units = request.headers.get("X-Units") ?? "fit10";
  if (!["y", "z"].includes(upAxis) || !["mm", "m", "fit10"].includes(units)) fail(400, "invalid_stl_units");
  let filename = "model.stl";
  try { filename = decodeURIComponent(request.headers.get("X-Filename") ?? "model.stl"); }
  catch { fail(400, "invalid_filename"); }
  filename = cleanName(filename, "model.stl", 80);
  if (!/\.stl$/i.test(filename) || /[\\/]/.test(filename)) fail(400, "invalid_filename");
  const bytes = await readBounded(request, LIMITS.stlBytes);
  let model;
  try { model = parseSTL(bytes.buffer); }
  catch (error) { if (error instanceof SchoolError) throw error; fail(400, "invalid_stl"); }
  if (!Number.isInteger(model.triangles) || model.triangles < 1 || model.triangles > LIMITS.assetTriangles) fail(413, "stl_triangle_limit");
  const id = crypto.randomUUID();
  const asset = { id, world_id: worldId, owner_id: session.id, object_key: `${worldId}/${session.id}/${id}.stl`,
    name: filename, up_axis: upAxis, units, bytes: bytes.byteLength, triangles: model.triangles, sha256: await sha256(bytes) };
  try { await reconcileStaleAssetReservations(env, session, worldId, currentTime(), options); }
  catch { /* D1 outage keeps the retry ledger; atomic quota SQL still excludes expired leases. */ }
  // Slow request-body reads do not spend a reservation's fifteen-minute lease.
  const reservedAt = currentTime();
  await reserveAsset(env.DB, session, worldId, asset, reservedAt);
  let abandoned = false, putSettled = false;
  const cleanupFailure = async (settled) => {
    const retirement = settled ? currentTime() : reservedAt + assetReservationPolicy.leaseSeconds;
    try {
      const retired = await retireAssetReservation(env.DB, session, worldId, asset, reservedAt, retirement);
      if (retired && settled) await removeRetired(env, session, worldId, retired);
      else if (settled && !await assetReservation(env.DB, session, worldId, asset)) {
        // A stale cleaner can have removed the ledger before a timed-out PUT
        // resolves. This generated UUID/key is never reused; remove that late
        // orphan, but any extant ready row must remain completely untouched.
        await env.STL_BUCKET.delete(asset.object_key);
      }
    } catch { /* Preserve the original error. Pending/retired rows retry after the conservative TTL. */ }
  };
  const put = Promise.resolve().then(() => env.STL_BUCKET.put(asset.object_key, bytes,
    { httpMetadata: { contentType: "model/stl" } }));
  // The R2 binding has no AbortSignal option. A timed-out PUT is not claimed
  // to be cancelled: keep a deferred ledger and also clean its late completion.
  put.then(() => { putSettled = true; if (abandoned) return cleanupFailure(true); },
    () => { putSettled = true; if (abandoned) return cleanupFailure(true); }).catch(() => {});
  try {
    const commit = put.then(() => completeAssetReservation(env.DB, session, worldId, asset, reservedAt, currentTime()));
    const ready = await deadline(commit, assetReservationPolicy.uploadTimeoutMs, options, "asset_upload_timeout");
    return assetPublic(ready);
  } catch (error) {
    abandoned = true;
    // An acknowledged SQL write can have succeeded even when its response was
    // lost. Reconcile that immutable ready asset instead of deleting its bytes.
    try {
      const existing = await assetReservation(env.DB, session, worldId, asset);
      if (existing?.status === "ready" && existing.sha256 === asset.sha256 && existing.bytes === asset.bytes) return assetPublic(existing);
    } catch { /* Cleanup remains conservative if metadata cannot be read. */ }
    await cleanupFailure(putSettled);
    throw error;
  }
}

export async function readAssetModel(env, asset) {
  const object = await env.STL_BUCKET.get(asset.object_key);
  if (!object || object.size !== asset.bytes || object.size > LIMITS.stlBytes) fail(503, "asset_storage_unavailable");
  const data = await object.arrayBuffer();
  if (data.byteLength !== asset.bytes || await sha256(data) !== asset.sha256) fail(503, "asset_hash_mismatch");
  let model;
  try { model = parseSTL(data); }
  catch { fail(503, "stored_asset_invalid"); }
  if (model.triangles !== asset.triangles || model.triangles > LIMITS.assetTriangles) fail(503, "stored_asset_invalid");
  return { ...model, ...normalizeSTLPositions(model.positions, asset.up_axis) };
}
export async function downloadAsset(env, worldId, id) {
  const asset = await getAsset(env.DB, worldId, id);
  const object = await env.STL_BUCKET.get(asset.object_key);
  if (!object || object.size !== asset.bytes || object.size > LIMITS.stlBytes) fail(503, "asset_storage_unavailable");
  const bytes = await object.arrayBuffer();
  if (await sha256(bytes) !== asset.sha256) fail(503, "asset_hash_mismatch");
  return new Response(bytes, { headers: { "Content-Type": "model/stl", "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff", "Content-Disposition": `attachment; filename="${id}.stl"` } });
}
