import { normalizeSTLPositions, parseSTL } from "../src/stl-model.js";
import { LIMITS, SchoolError, cleanName, fail, readBounded, sha256 } from "./school-common.mjs";
import { assetPublic, getAsset, reserveAsset, run } from "./school-store.mjs";

export async function uploadAsset(request, env, session, worldId, now) {
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
  await reserveAsset(env.DB, session, worldId, asset, now);
  try {
    await env.STL_BUCKET.put(asset.object_key, bytes, { httpMetadata: { contentType: "model/stl" } });
    await run(env.DB, "UPDATE school_assets SET status='ready' WHERE id=?", id);
  } catch (error) {
    // Pending entries remain quota-counted until removed; a failed upload never becomes readable.
    await run(env.DB, "DELETE FROM school_assets WHERE id=? AND status='pending'", id);
    try { await env.STL_BUCKET.delete(asset.object_key); } catch { /* orphan is nonpublic, not a usable asset */ }
    throw error;
  }
  return assetPublic(asset);
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
