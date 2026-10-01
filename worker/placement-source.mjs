import { createSurfaceIndex } from "../src/placement.js";
import { fail, sha256 } from "./school-common.mjs";

// These are the existing verified PLATEAU model bytes, not a generated flat ground
// or a client-supplied collision flag. Changing source models requires re-verification.
export const CORE_SOURCE_HASHES = Object.freeze({
  "manifest.json": "e170a514ee1258413de7afecdbab2d3f29d3890e09c73c9f11bf81a25b45ebf4",
  "mesh-0.bin": "cb4191decfb17a9cd64d37f131212f130e23119da8682442e5142aba8c94d807",
  "mesh-1.bin": "6246006bcdec4b58b9b0ea947f2371d8b853407586bc52340f1a491aaa849442",
  "mesh-2.bin": "f3a9822bc06e858e0bce814edf78f80492d731c0ac01e18d9ed90245760618d8",
  "mesh-3.bin": "8465707a2bba820d25aca7ab609e80cc16469108409dd327cf8d109bde08bd4b",
  "mesh-4.bin": "3dc800f81fbdd08d31879544e066eddd4ed21407c264de103d0f4108dbf135a7",
});
const surfaces = new WeakMap();
async function checkedAsset(binding, file) {
  const response = await binding.fetch(new Request(`https://metaquest001.gigach.net/city/${file}`));
  if (!response.ok) fail(503, "placement_source_unavailable");
  const data = await response.arrayBuffer();
  if (await sha256(data) !== CORE_SOURCE_HASHES[file]) fail(503, "placement_source_hash_mismatch");
  return data;
}
export function decodeCoreMesh(data, part) {
  if (data.byteLength !== part.vertices * 32 + part.indices * 4) fail(503, "invalid_core_mesh");
  const positions = new Float32Array(data, 0, part.vertices * 3);
  const indices = new Uint32Array(data, part.vertices * 32, part.indices);
  if (!positions.every(Number.isFinite) || !indices.every((index) => index < part.vertices)) fail(503, "invalid_core_mesh");
  return { positions, indices };
}
export async function loadCorePlacement(binding) {
  if (!binding) fail(503, "placement_source_unavailable");
  if (surfaces.has(binding)) return surfaces.get(binding);
  const task = (async () => {
    const manifest = JSON.parse(new TextDecoder().decode(await checkedAsset(binding, "manifest.json")));
    const obstacles = [];
    let terrain = null, bounds = null;
    for (const part of manifest.parts) {
      if (!Object.hasOwn(CORE_SOURCE_HASHES, part.file)) fail(503, "invalid_core_mesh");
      const decoded = decodeCoreMesh(await checkedAsset(binding, part.file), part);
      const index = createSurfaceIndex(decoded.positions, decoded.indices);
      if (part.texture === "Texture-001.png") {
        terrain = index;
        let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
        for (let i = 0; i < decoded.positions.length; i += 3) {
          minX = Math.min(minX, decoded.positions[i]); maxX = Math.max(maxX, decoded.positions[i]);
          minZ = Math.min(minZ, decoded.positions[i + 2]); maxZ = Math.max(maxZ, decoded.positions[i + 2]);
        }
        bounds = [minX, minZ, maxX, maxZ];
      } else obstacles.push(index);
    }
    if (!terrain || obstacles.length !== 4 || !bounds.every(Number.isFinite)) fail(503, "placement_source_unavailable");
    return { terrain, obstacles, bounds };
  })();
  surfaces.set(binding, task);
  try { return await task; }
  catch (error) { surfaces.delete(binding); throw error; }
}
