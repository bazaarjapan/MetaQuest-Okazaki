import { planRegionTiles, regionProfiles } from "./region-plan.js";
import { textureMemoryBytes } from "./quality.js";
import { applyLiveTerrainHeight } from "./terrain-height.js";

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TERRAIN_TEXTURE_BYTES = 32 * 1024 * 1024;
const RETRY_DELAY_MS = 5000;
const PLAN_INTERVAL_MS = 500;
const MAX_CONCURRENT = 3;

function abortError() {
  return Object.assign(new Error("Region request cancelled"), { name: "AbortError" });
}

function validTile(tile) {
  if (!tile || !["building", "terrain"].includes(tile.type) ||
    typeof tile.id !== "string" || !tile.id || typeof tile.file !== "string" ||
    !/^[a-zA-Z0-9._/-]+$/.test(tile.file) || tile.file.startsWith("/") ||
    tile.file.split("/").some((part) => !part || part === "..")) return false;
  if (![tile.vertices, tile.indices, tile.triangles, tile.bytes].every(Number.isSafeInteger) ||
    tile.vertices <= 0 || tile.indices <= 0 || tile.indices % 3 ||
    tile.triangles !== tile.indices / 3 || tile.bytes > MAX_FILE_BYTES || tile.bytes <= 0) return false;
  if (tile.format === "region-building-v1") {
    if (tile.type !== "building" || !Array.isArray(tile.origin) || tile.origin.length !== 3 ||
      !tile.origin.every(Number.isFinite) || !Number.isFinite(tile.scale) || tile.scale <= 0 ||
      tile.indexOffset !== Math.ceil(tile.vertices * 9 / 4) * 4 ||
      tile.bytes !== tile.indexOffset + tile.indices * 4 ||
      (tile.maxQuantizationErrorMeters !== undefined &&
        (!Number.isFinite(tile.maxQuantizationErrorMeters) || tile.maxQuantizationErrorMeters < 0))) return false;
  } else if (tile.format || tile.bytes !== tile.vertices * 32 + tile.indices * 4) return false;
  if (!Array.isArray(tile.bounds) || tile.bounds.length !== 4 ||
    !tile.bounds.every(Number.isFinite) || tile.bounds[0] > tile.bounds[2] || tile.bounds[1] > tile.bounds[3]) return false;
  if (tile.texture && (typeof tile.texture !== "string" ||
    !/^[a-zA-Z0-9._/-]+$/.test(tile.texture) || tile.texture.startsWith("/") ||
    tile.texture.split("/").some((part) => !part || part === ".."))) return false;
  return !tile.sha256 || /^[a-fA-F0-9]{64}$/.test(tile.sha256);
}

function coordinates(position) {
  const values = Array.isArray(position) ? position : [position?.x, position?.y, position?.z];
  return { x: Number.isFinite(values[0]) ? values[0] : 0,
    y: Number.isFinite(values[1]) ? values[1] : 20,
    z: Number.isFinite(values[2]) ? values[2] : 0 };
}

async function verifyHash(data, expected) {
  if (!expected) return;
  if (!globalThis.crypto?.subtle) throw new Error("Region hash verification is unavailable");
  const digest = await crypto.subtle.digest("SHA-256", data);
  const actual = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (actual !== expected.toLowerCase()) throw new Error("Region mesh hash mismatch");
}

/**
 * A bounded two-pool streamer for station-independent region assets. Only
 * local /region assets are requested. A partial failure never fails the core.
 */
export function createRegionStreamer(THREE, parentGroup, {
  fetchImpl = globalThis.fetch,
  textureLoader,
  heightLoader = applyLiveTerrainHeight,
} = {}) {
  const ownedBitmaps = new WeakMap();
  // Modern Quest/desktop browsers use real cancellable HTTP. The fallback is
  // only for old browsers without ImageBitmap, and custom test loaders remain
  // supported without browser APIs.
  const loader = textureLoader ?? (typeof globalThis.createImageBitmap === "function" && typeof THREE.Texture === "function"
    ? loadBrowserTexture : new THREE.TextureLoader());
  const buildingMaterial = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0.72, 0.76, 0.78).multiplyScalar(0.84), roughness: 1, metalness: 0,
  });
  let tiles = new Map();
  let generation = 0;
  let disposed = false;
  let wanted = new Set();
  let queue = [];
  let qualityId = "balanced";
  let lastPlanTime = -Infinity;
  let bounds = null;
  let errors = 0;
  let lastError = null;
  let requested = 0;
  const resident = new Map();
  const loading = new Map();
  const negativeCache = new Map();
  const learnedTextureBytes = new Map();

  function recordError(error, id) {
    errors += 1;
    lastError = `${id}: ${error?.message ?? "Region load failed"}`;
    negativeCache.set(id, performance.now() + RETRY_DELAY_MS);
  }

  function release(entry) {
    parentGroup.remove(entry.mesh);
    entry.mesh.geometry.dispose();
    if (entry.type === "terrain") {
      releaseTexture(entry.mesh.material.map);
      entry.mesh.material.dispose();
    }
  }

  function remove(id) {
    const entry = resident.get(id);
    if (!entry) return;
    resident.delete(id);
    release(entry);
  }

  function totals() {
    let triangles = 0, buildingTriangles = 0, terrainTriangles = 0;
    let geometryBytes = 0, sourceBytes = 0, textureBytes = 0, buildings = 0, terrain = 0;
    for (const entry of resident.values()) {
      triangles += entry.triangles;
      geometryBytes += entry.geometryBytes;
      sourceBytes += entry.bytes;
      textureBytes += entry.textureBytes;
      if (entry.type === "building") {
        buildingTriangles += entry.triangles;
        buildings += 1;
      } else {
        terrainTriangles += entry.triangles;
        terrain += 1;
      }
    }
    return { triangles, buildingTriangles, terrainTriangles, geometryBytes, sourceBytes, textureBytes, buildings, terrain };
  }

  function live(task) {
    return !disposed && task.generation === generation && wanted.has(task.tile.id) && !task.controller.signal.aborted;
  }

  function releaseTexture(texture) {
    if (!texture) return;
    texture.dispose();
    const bitmap = ownedBitmaps.get(texture);
    if (bitmap) {
      ownedBitmaps.delete(texture);
      bitmap.close();
    }
  }

  async function loadBrowserTexture(url, { signal }) {
    const response = await fetchImpl(url, { signal, credentials: "same-origin" });
    if (signal.aborted) throw abortError();
    if (!response.ok) throw new Error(`Region image request failed (${response.status})`);
    const advertised = Number(response.headers?.get("content-length"));
    if (Number.isFinite(advertised) && advertised > MAX_FILE_BYTES) throw new Error("Region image exceeds file budget");
    const blob = await response.blob();
    if (signal.aborted) throw abortError();
    if (!blob.size || blob.size > MAX_FILE_BYTES || !/^image\/(?:png|jpeg|webp|avif)(?:;|$)/i.test(blob.type))
      throw new Error("Invalid region image");
    // Texture.flipY is ignored for ImageBitmap. Flipping the bitmap at decode
    // exactly matches the existing TextureLoader/HTMLImageElement UV direction.
    const bitmap = await globalThis.createImageBitmap(blob, {
      imageOrientation: "flipY", colorSpaceConversion: "none", premultiplyAlpha: "none",
    });
    if (signal.aborted) { bitmap.close(); throw abortError(); }
    try {
      const texture = new THREE.Texture(bitmap);
      texture.flipY = false;
      texture.needsUpdate = true;
      ownedBitmaps.set(texture, bitmap);
      return texture;
    } catch (error) {
      bitmap.close();
      throw error;
    }
  }

  // Injected/legacy loaders may not support HTTP cancellation. Stop awaiting
  // on abort and always release a late decoded image; the browser default fetch
  // additionally receives the same AbortSignal to stop its HTTP request.
  function loadTexture(url, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(abortError()); return; }
      let done = false;
      const aborted = () => {
        done = true;
        signal.removeEventListener("abort", aborted);
        reject(abortError());
      };
      signal.addEventListener("abort", aborted, { once: true });
      let pending;
      try { pending = typeof loader === "function" ? loader(url, { signal }) : loader.loadAsync(url); }
      catch (error) {
        signal.removeEventListener("abort", aborted);
        done = true;
        reject(error);
        return;
      }
      Promise.resolve(pending).then((texture) => {
        signal.removeEventListener("abort", aborted);
        if (done || signal.aborted) { releaseTexture(texture); return; }
        done = true;
        resolve(texture);
      }, (error) => {
        signal.removeEventListener("abort", aborted);
        if (done) return;
        done = true;
        reject(error);
      });
    });
  }

  function makeGeometry(data, tile) {
    if (!(data instanceof ArrayBuffer) || data.byteLength !== tile.bytes || data.byteLength > MAX_FILE_BYTES)
      throw new Error("Region mesh byte length mismatch");
    const n = tile.vertices;
    const packed = tile.format === "region-building-v1";
    let positions, normals, uv = null;
    if (packed) {
      const quantized = new Int16Array(data, 0, n * 3);
      positions = new Float32Array(n * 3);
      for (let index = 0; index < quantized.length; index += 1)
        positions[index] = tile.origin[index % 3] + quantized[index] * tile.scale;
      normals = new Int8Array(data, n * 6, n * 3);
    } else {
      positions = new Float32Array(data, 0, n * 3);
      normals = new Float32Array(data, n * 12, n * 3);
      uv = new Float32Array(data, n * 24, n * 2);
    }
    const indices = new Uint32Array(data, packed ? tile.indexOffset : n * 32, tile.indices);
    if (!positions.every(Number.isFinite) || !normals.every(Number.isFinite) || (uv && !uv.every(Number.isFinite)))
      throw new Error("Region mesh contains nonfinite coordinates");
    if (!indices.every((index) => index < n)) throw new Error("Region mesh index out of range");
    const geometry = new THREE.BufferGeometry();
    try {
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3, packed));
      if (uv) geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
      geometry.setIndex(new THREE.BufferAttribute(indices, 1));
      geometry.computeBoundingSphere();
      return geometry;
    } catch (error) {
      geometry.dispose();
      throw error;
    }
  }

  async function run(task) {
    const tile = task.tile;
    let geometry = null, map = null, material = null;
    const timeout = setTimeout(() => {
      if (live(task)) recordError(new Error("Region request timed out"), tile.id);
      task.controller.abort();
    }, 45000);
    try {
      const response = await fetchImpl(`/region/${tile.file}`, { signal: task.controller.signal });
      if (!live(task)) return;
      if (!response.ok) throw new Error(`Region request failed (${response.status})`);
      const advertised = Number(response.headers?.get("content-length"));
      if (Number.isFinite(advertised) && advertised > MAX_FILE_BYTES) throw new Error("Region mesh exceeds file budget");
      const data = await response.arrayBuffer();
      if (!live(task)) return;
      await verifyHash(data, tile.sha256);
      if (!live(task)) return;
      geometry = makeGeometry(data, tile);
      let heightStats = null;
      if (tile.type === "terrain" && tile.heightMode === "live-gsi-dem") {
        heightStats = await heightLoader(THREE, geometry, tile, { signal: task.controller.signal, fetchImpl });
        if (!live(task)) return;
      }
      let decodedBytes = 0;
      if (tile.type === "terrain" && tile.texture) {
        map = await loadTexture(`/region/${tile.texture}`, task.controller.signal);
        if (!live(task)) return;
        const width = map.image?.width ?? map.image?.naturalWidth;
        const height = map.image?.height ?? map.image?.naturalHeight;
        decodedBytes = textureMemoryBytes(width, height);
        if (!decodedBytes || decodedBytes > MAX_TERRAIN_TEXTURE_BYTES)
          throw new Error("Region terrain texture exceeds decoded memory budget");
        learnedTextureBytes.set(tile.id, decodedBytes);
        map.colorSpace = THREE.SRGBColorSpace;
        map.anisotropy = 2;
        map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;
      }
      if (!live(task)) return;
      const current = totals();
      const profile = regionProfiles[qualityId];
      const terrainMax = qualityId === "high" ? 16 : 9;
      const poolSize = tile.type === "building" ? current.buildings : current.terrain;
      const poolTriangles = tile.type === "building" ? current.buildingTriangles : current.terrainTriangles;
      const poolLimit = tile.type === "building" ? profile.maxResident : terrainMax;
      if (poolSize >= poolLimit || poolTriangles + tile.triangles > profile.maxTriangles ||
        current.textureBytes + decodedBytes > MAX_TERRAIN_TEXTURE_BYTES)
        throw new Error("Region resident resource budget reached");
      material = tile.type === "terrain"
        ? new THREE.MeshStandardMaterial({ color: map ? 0xffffff : 0x879080, map, roughness: 1, metalness: 0 })
        : buildingMaterial;
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `region-${tile.type}-${tile.id}`;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.userData.regionType = tile.type;
      mesh.userData.regionTileId = tile.id;
      if (heightStats) mesh.userData.heightStats = { ...heightStats };
      // The final guard is directly before attach. No awaiting occurs afterward.
      if (!live(task)) return;
      parentGroup.add(mesh);
      const geometryBytes = tile.format === "region-building-v1"
        ? tile.vertices * 15 + tile.indices * 4 : tile.bytes;
      resident.set(tile.id, { mesh, type: tile.type, triangles: tile.triangles,
        bytes: tile.bytes, geometryBytes, textureBytes: decodedBytes });
      geometry = map = material = null;
      negativeCache.delete(tile.id);
    } catch (error) {
      if (live(task) && error?.name !== "AbortError") recordError(error, tile.id);
    } finally {
      clearTimeout(timeout);
      geometry?.dispose();
      releaseTexture(map);
      if (material && material !== buildingMaterial) material.dispose();
      if (loading.get(tile.id) === task) loading.delete(tile.id);
      // A replacement manifest may reuse this ID while the older request is
      // aborting. Its new request must not wait for another camera-plan tick.
      if (!disposed && wanted.has(tile.id) && !resident.has(tile.id) &&
        !loading.has(tile.id) && !queue.includes(tile.id)) queue.push(tile.id);
      pump();
    }
  }

  function pump() {
    if (disposed) return;
    while (loading.size < MAX_CONCURRENT && queue.length) {
      const id = queue.shift();
      const tile = tiles.get(id);
      if (!tile || !wanted.has(id) || resident.has(id) || loading.has(id) ||
        (negativeCache.get(id) ?? -Infinity) > performance.now()) continue;
      const task = { tile, generation, controller: new AbortController() };
      loading.set(id, task);
      requested += 1;
      void run(task);
    }
  }

  function setManifest(manifest) {
    if (disposed) return;
    generation += 1;
    for (const task of loading.values()) task.controller.abort();
    for (const id of [...resident.keys()]) remove(id);
    tiles = new Map();
    wanted = new Set();
    queue = [];
    negativeCache.clear();
    learnedTextureBytes.clear();
    errors = requested = 0;
    lastError = null;
    lastPlanTime = -Infinity;
    bounds = Array.isArray(manifest?.bounds) ? [...manifest.bounds] : null;
    for (const tile of Array.isArray(manifest?.tiles) ? manifest.tiles : []) {
      if (!validTile(tile) || tiles.has(tile.id)) {
        errors += 1;
        lastError = "Invalid or duplicate region tile metadata";
        continue;
      }
      tiles.set(tile.id, { ...tile, bounds: [...tile.bounds],
        ...(tile.origin ? { origin: [...tile.origin] } : {}) });
    }
  }

  function update(position, requestedQuality = "balanced", timeMs = performance.now()) {
    if (disposed) return;
    const nextQuality = Object.hasOwn(regionProfiles, requestedQuality) ? requestedQuality : "balanced";
    const now = Number.isFinite(timeMs) ? timeMs : performance.now();
    if (nextQuality === qualityId && now >= lastPlanTime && now - lastPlanTime < PLAN_INTERVAL_MS) return;
    qualityId = nextQuality;
    lastPlanTime = now;
    const point = coordinates(position);
    const all = [...tiles.values()];
    const buildings = planRegionTiles(all.filter((tile) => tile.type === "building"), point, qualityId);
    const nearbyTerrain = planRegionTiles(all.filter((tile) => tile.type === "terrain"), point, qualityId);
    const terrain = [];
    let textureBudget = 0;
    const terrainMax = qualityId === "high" ? 16 : 9;
    for (const id of nearbyTerrain) {
      if (terrain.length >= terrainMax) break;
      const tile = tiles.get(id);
      const estimate = tile.texture
        ? learnedTextureBytes.get(id) ?? (textureMemoryBytes(tile.textureWidth ?? 512, tile.textureHeight ?? 512) || textureMemoryBytes(512, 512)) : 0;
      if (textureBudget + estimate > MAX_TERRAIN_TEXTURE_BYTES) continue;
      terrain.push(id);
      textureBudget += estimate;
    }
    // A nearby ground tile must not wait behind all the city's building tiles.
    const priority = [];
    for (let index = 0; index < Math.max(buildings.length, terrain.length); index += 1) {
      if (buildings[index]) priority.push(buildings[index]);
      if (terrain[index]) priority.push(terrain[index]);
    }
    wanted = new Set(priority);
    for (const [id, task] of loading) if (!wanted.has(id)) task.controller.abort();
    for (const id of [...resident.keys()]) if (!wanted.has(id)) remove(id);
    queue = [...wanted].filter((id) => !resident.has(id) && !loading.has(id));
    pump();
  }

  function getState() {
    return {
      resident: resident.size, loading: loading.size, errors, ...totals(),
      requested, totalAvailable: tiles.size, loadedIds: [...resident.keys()],
      loadingIds: [...loading.keys()], wantedIds: [...wanted], lastError, qualityId,
      bounds: bounds ? [...bounds] : null,
      limits: { ...regionProfiles[qualityId], terrainResident: qualityId === "high" ? 16 : 9,
        terrainTextureBytes: MAX_TERRAIN_TEXTURE_BYTES, concurrency: MAX_CONCURRENT },
    };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    generation += 1;
    for (const task of loading.values()) task.controller.abort();
    for (const id of [...resident.keys()]) remove(id);
    queue = [];
    wanted.clear();
    tiles.clear();
    negativeCache.clear();
    learnedTextureBytes.clear();
    buildingMaterial.dispose();
  }

  return { setManifest, update, getState,
    getGroundMeshes: () => [...resident.values()].filter((entry) => entry.type === "terrain").map((entry) => entry.mesh),
    getMeshes: () => [...resident.values()].map((entry) => entry.mesh), dispose };
}
