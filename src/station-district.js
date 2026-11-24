import { Box3, Frustum, Group, Matrix4, Vector3 } from "three";

const directory = "/station/district/";
const cellSize = 250;
const halfWidth = 500;
const profiles = {
  performance: { radius: 220, resident: 2, triangles: 32000, concurrent: 1 },
  balanced: { radius: 420, resident: 7, triangles: 80000, concurrent: 2 },
  high: { radius: 700, resident: 16, triangles: 180000, concurrent: 2 },
  xr: { radius: 340, resident: 4, triangles: 50000, concurrent: 1 },
};

function readTiles(manifest, station) {
  const matches = (a, b) => Array.isArray(a) && a.length === b.length &&
    a.every((v, i) => Number.isFinite(v) && Math.abs(v - b[i]) < 0.001);
  const [x, , z] = station;
  if (manifest?.version !== 1 || manifest.tileSize !== cellSize || !matches(manifest.origin, station) ||
      !matches(manifest.bounds, [x-halfWidth, z-halfWidth, x+halfWidth, z+halfWidth]) ||
      manifest.tiles?.length !== 16) throw Error("Invalid station district extent");
  const seen = new Set();
  return manifest.tiles.map(tile => {
    const cell = /^r([0-3])-c([0-3])$/.exec(tile.id);
    if (!cell || seen.has(tile.id) || tile.file !== tile.id + ".glb" ||
        !Number.isSafeInteger(tile.bytes) || tile.bytes < 20 || tile.bytes > 4 * 1024 * 1024 ||
        !Number.isSafeInteger(tile.triangles) || tile.triangles <= 0 || tile.triangles > profiles.performance.triangles ||
        !/^[0-9a-f]{64}$/.test(tile.sha256) || !Array.isArray(tile.regionBuildings) ||
        !tile.regionBuildings.every(id => typeof id === "string" && /^b-[\d-]+$/.test(id)) ||
        !Array.isArray(tile.heightRange) || tile.heightRange.length !== 2 ||
        !tile.heightRange.every(Number.isFinite) || tile.heightRange[1] < tile.heightRange[0]) throw Error("Invalid station district tile");
    const x0 = x - halfWidth + Number(cell[2]) * cellSize;
    const z0 = z - halfWidth + Number(cell[1]) * cellSize;
    if (!matches(tile.bounds, [x0, z0, x0 + cellSize, z0 + cellSize])) throw Error("Misplaced station district tile");
    seen.add(tile.id);
    return {...tile, box: new Box3(new Vector3(x0, tile.heightRange[0], z0),
      new Vector3(x0 + cellSize, tile.heightRange[1], z0 + cellSize))};
  });
}

function release(model) {
  model.removeFromParent();
  const geometries = new Set(), materials = new Set();
  model.traverse(child => {
    if (!child.isMesh) return;
    geometries.add(child.geometry);
    for (const material of [].concat(child.material)) materials.add(material);
  });
  for (const geometry of geometries) geometry.dispose();
  // The Blender batch contains only opaque vertex-colour materials.
  for (const material of materials) material.dispose();
}

async function parseModel(bytes) {
  const { GLTFLoader } = await import("three/addons/loaders/GLTFLoader.js");
  return (await new GLTFLoader().parseAsync(bytes, directory)).scene;
}

export function createStationDistrict(scene, { fetchImpl = fetch, parse = parseModel, hasBuilding = () => false } = {}) {
  const group = new Group();
  group.name = "station-district";
  scene.add(group);
  const resident = new Map(), loading = new Map(), retryAfter = new Map();
  const matrix = new Matrix4(), frusta = [new Frustum(), new Frustum()];
  let tiles, manifestRequest, active = false, profile, wanted = [];
  let lastPlan = -Infinity, lastTime = 0, lastBuildingRevision, errors = 0;

  async function request(url, controller) {
    const response = await fetchImpl(directory + url, { credentials: "same-origin", redirect: "error",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]) });
    if (!response.ok) throw Error("Station district file unavailable");
    return response;
  }

  async function loadManifest(station) {
    const task = manifestRequest = new AbortController();
    try {
      const response = await request("manifest.json", task);
      const manifest = await response.json();
      if (task.signal.aborted) return;
      tiles = readTiles(manifest, station);
      group.position.fromArray(station);
    } catch {
      if (!task.signal.aborted) { errors++; retryAfter.set("manifest", lastTime + 10000); }
    } finally {
      manifestRequest = null;
      lastPlan = -Infinity;
    }
  }

  async function loadTile(tile) {
    const task = new AbortController();
    loading.set(tile.id, task);
    let model;
    try {
      const response = await request(tile.file + "?v=" + tile.sha256, task);
      const bytes = await response.arrayBuffer();
      if (task.signal.aborted) return;
      if (bytes.byteLength !== tile.bytes) throw Error("Station district size mismatch");
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      if ([...digest].map(v => v.toString(16).padStart(2, "0")).join("") !== tile.sha256) throw Error("Station district hash mismatch");
      if (task.signal.aborted) return;
      model = await parse(bytes);
      if (task.signal.aborted || !wanted.includes(tile) || !tile.regionBuildings.every(hasBuilding)) return;
      group.add(model);
      resident.set(tile.id, {model, tile});
      model = null;
    } catch {
      if (!task.signal.aborted) { errors++; retryAfter.set(tile.id, lastTime + 10000); }
    } finally {
      if (model) release(model);
      loading.delete(tile.id);
      pump();
    }
  }

  function pump() {
    for (const tile of wanted) {
      if (loading.size >= profile.concurrent) break;
      if (!resident.has(tile.id) && !loading.has(tile.id) && lastTime >= (retryAfter.get(tile.id) ?? -Infinity) &&
          tile.regionBuildings.every(hasBuilding)) void loadTile(tile);
    }
  }

  function select(next) {
    wanted = next;
    const ids = new Set(wanted.map(t => t.id));
    for (const [id, task] of loading) if (!ids.has(id)) task.abort();
    for (const [id, entry] of resident) if (!ids.has(id)) {
      release(entry.model);
      resident.delete(id);
    }
    pump();
  }

  function update({station, position, camera, enabled, quality, xr, time = performance.now(), buildingRevision}) {
    lastTime = time;
    const requested = xr && quality !== "performance" ? profiles.xr : profiles[quality] ?? profiles.balanced;
    const nearby = station && Math.hypot(Math.max(0, Math.abs(position.x - station[0]) - halfWidth),
      Math.max(0, Math.abs(position.z - station[2]) - halfWidth)) <= requested.radius;
    if (!enabled || !nearby) {
      if (active) { active = false; manifestRequest?.abort(); select([]); }
      return;
    }
    if (active && requested === profile && buildingRevision === lastBuildingRevision && time >= lastPlan && time - lastPlan < 300) return;
    profile = requested;
    active = true;
    lastPlan = time;
    lastBuildingRevision = buildingRevision;
    if (!tiles) {
      if (!manifestRequest && time >= (retryAfter.get("manifest") ?? -Infinity)) void loadManifest(station);
      return;
    }

    const eyes = camera.isArrayCamera && camera.cameras.length ? camera.cameras : [camera];
    const eyeCount = Math.min(eyes.length, frusta.length);
    for (let i = 0; i < eyeCount; i++) {
      const eye = eyes[i];
      frusta[i].setFromProjectionMatrix(matrix.multiplyMatrices(eye.projectionMatrix, eye.matrixWorldInverse));
    }
    const candidates = [];
    for (const tile of tiles) {
      if (!tile.regionBuildings.every(hasBuilding)) continue;
      const [x0, z0, x1, z1] = tile.bounds;
      const distance = Math.hypot(Math.max(x0-position.x, 0, position.x-x1), Math.max(z0-position.z, 0, position.z-z1));
      if (distance > profile.radius) continue;
      const inSight = frusta[0].intersectsBox(tile.box) || (eyeCount > 1 && frusta[1].intersectsBox(tile.box));
      // Keep immediately adjacent blocks available for a quick turn on foot.
      if (!inSight && distance > 45) continue;
      const center = Math.hypot(x0+cellSize/2-position.x, z0+cellSize/2-position.z);
      candidates.push({tile, priority: distance + center * .15 + (inSight ? 0 : 90) - (resident.has(tile.id) ? 15 : 0)});
    }
    candidates.sort((a, b) => a.priority - b.priority);
    const next = [];
    let triangles = 0;
    for (const {tile} of candidates) {
      if (triangles + tile.triangles > profile.triangles) continue;
      triangles += tile.triangles;
      next.push(tile);
      if (next.length === profile.resident) break;
    }
    select(next);
  }

  return { update, getState: () => ({
    status: tiles ? "ready" : manifestRequest ? "loading" : retryAfter.has("manifest") ? "unavailable" : "idle",
    enabled: active, available: tiles?.length ?? 0, resident: [...resident.keys()], loading: [...loading.keys()], errors,
    triangles: [...resident.values()].reduce((sum, {tile}) => sum + tile.triangles, 0),
    limits: profile ? {...profile} : null,
  }) };
}
