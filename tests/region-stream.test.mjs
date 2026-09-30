import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRegionStreamer } from "../src/region-stream.js";

function stubs() {
  const created = { geometries: [], materials: [], textures: [] };
  class BufferGeometry {
    constructor() { this.attributes = {}; this.disposed = 0; created.geometries.push(this); }
    setAttribute(name, attribute) { this.attributes[name] = attribute; }
    setIndex(attribute) { this.index = attribute; }
    computeBoundingSphere() { this.boundingSphereComputed = true; }
    dispose() { this.disposed += 1; }
  }
  class BufferAttribute { constructor(array, itemSize, normalized = false) { this.array = array; this.itemSize = itemSize; this.normalized = normalized; } }
  class MeshStandardMaterial {
    constructor(properties) { Object.assign(this, properties); this.disposed = 0; created.materials.push(this); }
    dispose() { this.disposed += 1; }
  }
  class Mesh { constructor(geometry, material) { this.geometry = geometry; this.material = material; this.userData = {}; } }
  class Color {
    constructor(r, g, b) { Object.assign(this, { r, g, b }); }
    multiplyScalar(value) { this.r *= value; this.g *= value; this.b *= value; return this; }
  }
  class TextureLoader { loadAsync() { return Promise.resolve(texture()); } }
  class Texture {
    constructor(image) { this.image = image; this.disposed = 0; created.textures.push(this); }
    dispose() { this.disposed += 1; }
  }
  function texture(width = 256, height = 256) {
    const value = { image: { width, height }, disposed: 0, dispose() { this.disposed += 1; } };
    created.textures.push(value);
    return value;
  }
  const group = {
    children: [], maxChildren: 0,
    add(mesh) { this.children.push(mesh); this.maxChildren = Math.max(this.maxChildren, this.children.length); },
    remove(mesh) { this.children = this.children.filter((child) => child !== mesh); },
  };
  return { THREE: { BufferGeometry, BufferAttribute, MeshStandardMaterial, Mesh, Color, TextureLoader, Texture,
    SRGBColorSpace: "srgb", ClampToEdgeWrapping: "clamp" }, group, created, texture };
}

function tile(id, type = "building", bounds = [0, 0, 500, 500], triangles = 1) {
  return { id, type, bounds, file: `${id}.bin`, vertices: 3, indices: triangles * 3,
    triangles, bytes: 3 * 32 + triangles * 12,
    ...(type === "terrain" ? { texture: `${id}.webp`, textureWidth: 256, textureHeight: 256 } : {}) };
}

function data(tile) {
  const buffer = new ArrayBuffer(tile.bytes);
  if (tile.format === "region-building-v1") {
    new Int16Array(buffer, 0, 9).set([0, 0, 0, 50, 0, 0, 0, 0, 50]);
    new Int8Array(buffer, 18, 9).set([0, 127, 0, 0, 127, 0, 0, 127, 0]);
    const indices = new Uint32Array(buffer, tile.indexOffset, tile.indices);
    for (let index = 0; index < indices.length; index += 1) indices[index] = index % 3;
    return buffer;
  }
  new Float32Array(buffer, 0, 9).set([0, 0, 0, 1, 0, 0, 0, 0, 1]);
  new Float32Array(buffer, 36, 9).set([0, 1, 0, 0, 1, 0, 0, 1, 0]);
  new Float32Array(buffer, 72, 6).set([0, 0, 1, 0, 0, 1]);
  const indices = new Uint32Array(buffer, 96, tile.indices);
  for (let index = 0; index < indices.length; index += 1) indices[index] = index % 3;
  return buffer;
}

function packedTile(id, bounds = [1000, -800, 1500, -300]) {
  const entry = tile(id, "building", bounds);
  entry.format = "region-building-v1";
  entry.origin = [1000, 20, -800];
  entry.scale = 0.02;
  entry.indexOffset = Math.ceil(entry.vertices * 9 / 4) * 4;
  entry.bytes = entry.indexOffset + entry.indices * 4;
  entry.maxQuantizationErrorMeters = 0.01;
  return entry;
}

function immediateFetch(tiles, intercept) {
  const entries = new Map(tiles.map((entry) => [`/region/${entry.file}`, entry]));
  return async (url, options) => {
    const entry = entries.get(url);
    if (intercept) return intercept(entry, url, options);
    return { ok: true, headers: { get: () => String(entry.bytes) }, arrayBuffer: async () => data(entry) };
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

async function settle() {
  for (let index = 0; index < 12; index += 1) await new Promise(setImmediate);
}

async function settleAsyncLoads(streamer) {
  // WebCrypto runs in a worker pool. A fixed number of immediate callbacks
  // does not guarantee SHA256 completion, especially while XR tests render.
  const deadline = Date.now() + 3000;
  while (streamer.getState().loading > 0 && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(streamer.getState().loading, 0, "asynchronous integrity checks must finish");
}

test("loads two pools with nearest terrain priority and releases tile-owned resources", async () => {
  const fixture = stubs();
  const tiles = [tile("b0"), tile("b1"), tile("g0", "terrain")];
  const requests = [];
  const streamer = createRegionStreamer(fixture.THREE, fixture.group, {
    fetchImpl: immediateFetch(tiles, async (entry, url) => {
      requests.push(url);
      return { ok: true, arrayBuffer: async () => data(entry) };
    }),
  });
  streamer.setManifest({ tiles, bounds: [-100, -100, 1000, 1000] });
  streamer.update([20, 100, 20], "balanced", 0);
  await settle();
  assert.deepEqual(requests, ["/region/b0.bin", "/region/g0.bin", "/region/b1.bin"]);
  const state = streamer.getState();
  assert.equal(state.resident, 3);
  assert.equal(state.triangles, 3);
  assert.equal(state.geometryBytes, tiles.reduce((sum, entry) => sum + entry.bytes, 0));
  assert.ok(state.textureBytes > 256 * 256 * 4);
  assert.equal(streamer.getGroundMeshes().length, 1);
  assert.equal(streamer.getMeshes().length, 3);
  assert.ok(streamer.getMeshes().every((mesh) => !mesh.castShadow && !mesh.receiveShadow));
  const ground = streamer.getGroundMeshes()[0];
  assert.equal(ground.material.map.colorSpace, "srgb");
  assert.equal(ground.material.map.anisotropy, 2);
  const shared = fixture.created.materials[0];
  streamer.setManifest({ tiles: [] });
  assert.equal(fixture.group.children.length, 0);
  assert.ok(fixture.created.geometries.every((geometry) => geometry.disposed === 1));
  assert.equal(ground.material.disposed, 1);
  assert.equal(fixture.created.textures[0].disposed, 1);
  assert.equal(shared.disposed, 0, "tile eviction must preserve shared building material");
  streamer.dispose();
  streamer.dispose();
  assert.equal(shared.disposed, 1);
});

test("network concurrency is three and unwanted late responses never attach", async () => {
  const fixture = stubs();
  const tiles = Array.from({ length: 40 }, (_, index) => tile(`b${index}`, "building", [index * 100, 0, index * 100 + 90, 100]));
  const pending = [];
  const streamer = createRegionStreamer(fixture.THREE, fixture.group, {
    fetchImpl: (url, options) => {
      const request = deferred();
      pending.push({ ...request, url, signal: options.signal });
      return request.promise;
    },
  });
  streamer.setManifest({ tiles });
  streamer.update({ x: 0, z: 0 }, "balanced", 0);
  assert.equal(pending.length, 3);
  assert.equal(streamer.getState().loading, 3);
  streamer.update({ x: 10000, z: 0 }, "balanced", 500);
  assert.ok(pending.every((request) => request.signal.aborted));
  for (const request of pending.slice(0, 3)) {
    const entry = tiles.find((candidate) => `/region/${candidate.file}` === request.url);
    request.resolve({ ok: true, arrayBuffer: async () => data(entry) });
  }
  await settle();
  assert.equal(fixture.group.children.length, 0);
  assert.equal(pending.length, 4, "only new nearest fallback is requested after stale jobs release slots");
  pending[3].resolve({ ok: true, arrayBuffer: async () => data(tiles[39]) });
  await settle();
  assert.deepEqual(streamer.getState().loadedIds, ["b39"]);
  streamer.dispose();
});

test("quality reduction immediately enforces smaller resident limits", async () => {
  const fixture = stubs();
  const tiles = Array.from({ length: 50 }, (_, index) => tile(`b${String(index).padStart(2, "0")}`));
  const streamer = createRegionStreamer(fixture.THREE, fixture.group, { fetchImpl: immediateFetch(tiles) });
  streamer.setManifest({ tiles });
  streamer.update({ x: 0, z: 0 }, "high", 0);
  await settle();
  assert.equal(streamer.getState().resident, 36);
  streamer.update({ x: 0, z: 0 }, "performance", 10);
  assert.equal(streamer.getState().resident, 16, "quality changes bypass pose throttle");
  assert.ok(fixture.created.geometries.filter((geometry) => geometry.disposed).length >= 20);
  assert.equal(fixture.group.maxChildren, 36);
  streamer.dispose();
});

test("triangle and terrain pool budgets are hard limits", async () => {
  const fixture = stubs();
  const tiles = [
    ...Array.from({ length: 12 }, (_, index) => tile(`b${index}`, "building", [0, 0, 100, 100], 30000)),
    ...Array.from({ length: 25 }, (_, index) => tile(`g${String(index).padStart(2, "0")}`, "terrain")),
  ];
  const streamer = createRegionStreamer(fixture.THREE, fixture.group, { fetchImpl: immediateFetch(tiles) });
  streamer.setManifest({ tiles });
  streamer.update({ x: 20, z: 20 }, "performance", 0);
  await settle();
  assert.equal(streamer.getState().buildings, 3);
  assert.equal(streamer.getState().buildingTriangles, 90000);
  assert.equal(streamer.getState().terrain, 9);
  streamer.update({ x: 20, z: 20 }, "high", 500);
  await settle();
  assert.equal(streamer.getState().buildings, 7);
  assert.equal(streamer.getState().terrain, 16);
  assert.ok(streamer.getState().textureBytes <= 32 * 1024 * 1024);
  streamer.dispose();
});

test("invalid metadata, nonfinite buffers and bad indices never attach", async () => {
  const fixture = stubs();
  const tiles = [tile("finite"), tile("index"), { ...tile("oversized"), bytes: 30 * 1024 * 1024 },
    { ...tile("foreign"), file: "../outside.bin" }, { ...tile("mismatch"), triangles: 2 }];
  const streamer = createRegionStreamer(fixture.THREE, fixture.group, {
    fetchImpl: immediateFetch(tiles, async (entry) => {
      const buffer = data(entry);
      if (entry.id === "finite") new Float32Array(buffer)[0] = NaN;
      if (entry.id === "index") new Uint32Array(buffer, 96)[0] = 3;
      return { ok: true, arrayBuffer: async () => buffer };
    }),
  });
  streamer.setManifest({ tiles });
  streamer.update({ x: 0, z: 0 }, "balanced", 0);
  await settle();
  assert.equal(streamer.getState().totalAvailable, 2);
  assert.equal(streamer.getState().resident, 0);
  assert.equal(streamer.getState().errors, 5);
  assert.equal(fixture.created.geometries.length, 0);
  streamer.dispose();
});

test("failed requests use a five second negative cache without failing other tiles", async () => {
  const fixture = stubs();
  const tiles = [tile("bad"), tile("good")];
  const previous = Object.getOwnPropertyDescriptor(globalThis, "performance");
  let clock = 0, badRequests = 0;
  Object.defineProperty(globalThis, "performance", { configurable: true, value: { now: () => clock } });
  const streamer = createRegionStreamer(fixture.THREE, fixture.group, {
    fetchImpl: immediateFetch(tiles, async (entry) => {
      if (entry.id === "bad") { badRequests += 1; return { ok: false, status: 503 }; }
      return { ok: true, arrayBuffer: async () => data(entry) };
    }),
  });
  try {
    streamer.setManifest({ tiles });
    streamer.update({ x: 0, z: 0 }, "balanced", clock);
    await settle();
    assert.equal(badRequests, 1);
    assert.deepEqual(streamer.getState().loadedIds, ["good"]);
    clock = 4500;
    streamer.update({ x: 0, z: 0 }, "balanced", clock);
    await settle();
    assert.equal(badRequests, 1);
    clock = 5000;
    streamer.update({ x: 0, z: 0 }, "balanced", clock);
    await settle();
    assert.equal(badRequests, 2);
    assert.equal(streamer.getState().errors, 2);
  } finally {
    streamer.dispose();
    Object.defineProperty(globalThis, "performance", previous);
  }
});

test("abort during image decode releases late texture and never reattaches old tile", async () => {
  const fixture = stubs();
  const ground = tile("g0", "terrain");
  const image = deferred();
  const streamer = createRegionStreamer(fixture.THREE, fixture.group, {
    fetchImpl: immediateFetch([ground]), textureLoader: () => image.promise,
  });
  streamer.setManifest({ tiles: [ground] });
  streamer.update({ x: 0, z: 0 }, "balanced", 0);
  await settle();
  assert.equal(streamer.getState().loading, 1);
  streamer.setManifest({ tiles: [] });
  await settle();
  const texture = fixture.texture();
  image.resolve(texture);
  await settle();
  assert.equal(texture.disposed, 1);
  assert.equal(fixture.created.geometries[0].disposed, 1);
  assert.equal(streamer.getState().loading, 0);
  assert.equal(fixture.group.children.length, 0);
  assert.equal(streamer.getState().errors, 0);
  streamer.dispose();
});

test("decoded texture budget is enforced even if image metadata underestimated size", async () => {
  const fixture = stubs();
  const grounds = [tile("g0", "terrain"), tile("g1", "terrain")];
  const streamer = createRegionStreamer(fixture.THREE, fixture.group, {
    fetchImpl: immediateFetch(grounds), textureLoader: async () => fixture.texture(2048, 2048),
  });
  streamer.setManifest({ tiles: grounds });
  streamer.update({ x: 0, z: 0 }, "balanced", 0);
  await settle();
  assert.equal(streamer.getState().resident, 1);
  assert.equal(streamer.getState().errors, 1);
  assert.ok(streamer.getState().textureBytes <= 32 * 1024 * 1024);
  assert.equal(fixture.created.textures.filter((texture) => texture.disposed).length, 1);
  streamer.dispose();
});

test("live DEM height must succeed before terrain attach; failure releases geometry", async () => {
  const fixture = stubs();
  const grounds = [tile("good", "terrain"), tile("bad", "terrain")].map((entry) => ({ ...entry, heightMode: "live-gsi-dem" }));
  const heightCalls = [];
  const streamer = createRegionStreamer(fixture.THREE, fixture.group, {
    fetchImpl: immediateFetch(grounds),
    heightLoader: async (_THREE, geometry, entry, options) => {
      heightCalls.push(entry.id);
      assert.equal(fixture.group.children.length, 0);
      assert.ok(options.signal instanceof AbortSignal);
      if (entry.id === "bad") throw new Error("All DEM pixels are NoData");
      geometry.attributes.position.array[1] = 17;
      return { validVertices: 3, nodataVertices: 0 };
    },
  });
  streamer.setManifest({ tiles: grounds });
  streamer.update({ x: 0, z: 0 }, "balanced", 0);
  await settle();
  assert.deepEqual(heightCalls.sort(), ["bad", "good"]);
  assert.deepEqual(streamer.getState().loadedIds, ["good"]);
  assert.equal(streamer.getGroundMeshes()[0].geometry.attributes.position.array[1], 17);
  assert.equal(streamer.getState().errors, 1);
  assert.equal(fixture.created.geometries.filter((geometry) => geometry.disposed).length, 1);
  streamer.dispose();
});

test("pose planning throttles to 500ms and dispose guards all late requests", async () => {
  const fixture = stubs();
  const pending = deferred();
  const tiles = [tile("near"), tile("far", "building", [10000, 0, 10500, 500])];
  const streamer = createRegionStreamer(fixture.THREE, fixture.group, { fetchImpl: () => pending.promise });
  streamer.setManifest({ tiles });
  streamer.update([0, 50, 0], "balanced", 0);
  streamer.update([10000, 50, 0], "balanced", 499);
  assert.deepEqual(streamer.getState().wantedIds, ["near"]);
  streamer.dispose();
  pending.resolve({ ok: true, arrayBuffer: async () => data(tiles[0]) });
  await settle();
  streamer.update([10000, 50, 0], "high", 500);
  streamer.setManifest({ tiles });
  assert.equal(streamer.getState().resident, 0);
  assert.equal(streamer.getState().loading, 0);
  assert.equal(streamer.getState().totalAvailable, 0);
  assert.equal(fixture.group.children.length, 0);
});

test("manifest replacement reusing an ID rejects the old generation and loads the new one", async () => {
  const fixture = stubs();
  const old = tile("same");
  const replacement = { ...tile("same"), file: "replacement.bin" };
  const first = deferred();
  const requests = [];
  const streamer = createRegionStreamer(fixture.THREE, fixture.group, {
    fetchImpl: (url) => {
      requests.push(url);
      return url.endsWith("replacement.bin")
        ? Promise.resolve({ ok: true, arrayBuffer: async () => data(replacement) }) : first.promise;
    },
  });
  streamer.setManifest({ tiles: [old] });
  streamer.update({ x: 0, z: 0 }, "balanced", 0);
  streamer.setManifest({ tiles: [replacement] });
  streamer.update({ x: 0, z: 0 }, "balanced", 1);
  first.resolve({ ok: true, arrayBuffer: async () => data(old) });
  await settle();
  assert.deepEqual(requests, ["/region/same.bin", "/region/replacement.bin"]);
  assert.deepEqual(streamer.getState().loadedIds, ["same"]);
  assert.equal(fixture.created.geometries.length, 1, "old generation is discarded before creating a geometry");
  streamer.dispose();
});

test("optional SHA256 integrity and exact response byte lengths are checked before attach", async () => {
  const fixture = stubs();
  const good = tile("good");
  good.sha256 = createHash("sha256").update(new Uint8Array(data(good))).digest("hex");
  const bad = { ...tile("bad"), sha256: "0".repeat(64) };
  const short = tile("short");
  const large = tile("large-header");
  const tiles = [good, bad, short, large];
  const streamer = createRegionStreamer(fixture.THREE, fixture.group, {
    fetchImpl: immediateFetch(tiles, async (entry) => ({
      ok: true,
      headers: { get: () => entry.id === "large-header" ? String(30 * 1024 * 1024) : null },
      arrayBuffer: async () => entry.id === "short" ? new ArrayBuffer(4) : data(entry),
    })),
  });
  streamer.setManifest({ tiles });
  streamer.update({ x: 0, z: 0 }, "balanced", 0);
  await settleAsyncLoads(streamer);
  assert.deepEqual(streamer.getState().loadedIds, ["good"]);
  assert.equal(streamer.getState().errors, 3);
  assert.equal(fixture.created.geometries.length, 1);
  streamer.dispose();
});

test("packed building positions decode into world coordinates with normalized Int8 normals and no UV", async () => {
  const fixture = stubs();
  const building = packedTile("packed");
  building.sha256 = createHash("sha256").update(new Uint8Array(data(building))).digest("hex");
  const ground = tile("ground", "terrain", building.bounds);
  const streamer = createRegionStreamer(fixture.THREE, fixture.group, { fetchImpl: immediateFetch([building, ground]) });
  streamer.setManifest({ tiles: [building, ground] });
  streamer.update({ x: 1000, z: -800 }, "balanced", 0);
  await settleAsyncLoads(streamer);
  assert.equal(streamer.getState().resident, 2);
  const geometry = streamer.getMeshes().find((mesh) => mesh.userData.regionType === "building").geometry;
  assert.deepEqual([...geometry.attributes.position.array], [1000, 20, -800, 1001, 20, -800, 1000, 20, -799]);
  assert.ok(geometry.attributes.position.array instanceof Float32Array);
  assert.ok(geometry.attributes.normal.array instanceof Int8Array);
  assert.equal(geometry.attributes.normal.normalized, true);
  assert.equal(geometry.attributes.uv, undefined);
  assert.deepEqual([...geometry.index.array], [0, 1, 2]);
  assert.ok(streamer.getGroundMeshes()[0].geometry.attributes.uv, "raw terrain retains its UV attribute");
  assert.equal(streamer.getState().sourceBytes, building.bytes + ground.bytes);
  assert.equal(streamer.getState().geometryBytes, building.vertices * 15 + building.indices * 4 + ground.bytes);
  streamer.dispose();
});

test("packed invalid alignment, origin, scale and out-of-range indices never attach", async () => {
  const fixture = stubs();
  const index = packedTile("bad-index");
  const overflow = { ...packedTile("overflow"), origin: [1e300, 20, 0] };
  const invalid = [
    { ...packedTile("bad-offset"), indexOffset: 27 },
    { ...packedTile("bad-origin"), origin: [NaN, 0, 0] },
    { ...packedTile("bad-scale"), scale: 0 },
    { ...packedTile("bad-type"), type: "terrain" },
  ];
  const streamer = createRegionStreamer(fixture.THREE, fixture.group, {
    fetchImpl: immediateFetch([index, overflow], async (entry) => {
      const buffer = data(entry);
      if (entry.id === "bad-index") new Uint32Array(buffer, entry.indexOffset)[0] = entry.vertices;
      return { ok: true, arrayBuffer: async () => buffer };
    }),
  });
  streamer.setManifest({ tiles: [...invalid, index, overflow] });
  streamer.update({ x: 1000, z: -800 }, "balanced", 0);
  await settle();
  assert.equal(streamer.getState().resident, 0);
  assert.equal(streamer.getState().errors, 6);
  assert.equal(fixture.created.geometries.length, 0);
  streamer.dispose();
});

test("browser image default uses cancellable fetch, matching flipY decode, and closes owned bitmaps", async () => {
  const fixture = stubs();
  const ground = tile("g0", "terrain");
  const previous = Object.getOwnPropertyDescriptor(globalThis, "createImageBitmap");
  const bitmap = { width: 256, height: 256, closed: 0, close() { this.closed += 1; } };
  let options;
  Object.defineProperty(globalThis, "createImageBitmap", { configurable: true, value: async (_blob, decodeOptions) => {
    options = decodeOptions;
    return bitmap;
  } });
  const fetchOptions = [];
  const streamer = createRegionStreamer(fixture.THREE, fixture.group, {
    fetchImpl: async (url, requestOptions) => {
      fetchOptions.push(requestOptions);
      return url.endsWith(".bin")
        ? { ok: true, arrayBuffer: async () => data(ground) }
        : { ok: true, blob: async () => ({ size: 10, type: "image/webp" }) };
    },
  });
  try {
    streamer.setManifest({ tiles: [ground] });
    streamer.update({ x: 0, z: 0 }, "balanced", 0);
    await settle();
    assert.equal(streamer.getState().resident, 1);
    assert.equal(fetchOptions.length, 2);
    assert.equal(fetchOptions[0].signal, fetchOptions[1].signal);
    assert.deepEqual(options, { imageOrientation: "flipY", colorSpaceConversion: "none", premultiplyAlpha: "none" });
    assert.equal(streamer.getGroundMeshes()[0].material.map.flipY, false);
    streamer.dispose();
    assert.equal(bitmap.closed, 1);
    assert.equal(fixture.created.textures[0].disposed, 1);
  } finally {
    streamer.dispose();
    if (previous) Object.defineProperty(globalThis, "createImageBitmap", previous);
    else delete globalThis.createImageBitmap;
  }
});

test("browser image HTTP is aborted when its terrain tile is no longer wanted", async () => {
  const fixture = stubs();
  const ground = tile("g0", "terrain");
  const previous = Object.getOwnPropertyDescriptor(globalThis, "createImageBitmap");
  Object.defineProperty(globalThis, "createImageBitmap", { configurable: true, value: async () => {
    throw new Error("aborted HTTP must not reach image decode");
  } });
  let imageSignal, aborted = false;
  const streamer = createRegionStreamer(fixture.THREE, fixture.group, {
    fetchImpl: async (url, { signal }) => {
      if (url.endsWith(".bin")) return { ok: true, arrayBuffer: async () => data(ground) };
      imageSignal = signal;
      return new Promise((_, reject) => signal.addEventListener("abort", () => {
        aborted = true;
        reject(Object.assign(new Error("cancelled"), { name: "AbortError" }));
      }, { once: true }));
    },
  });
  try {
    streamer.setManifest({ tiles: [ground] });
    streamer.update({ x: 0, z: 0 }, "balanced", 0);
    await settle();
    assert.ok(imageSignal && !imageSignal.aborted);
    streamer.setManifest({ tiles: [] });
    await settle();
    assert.ok(aborted && imageSignal.aborted);
    assert.equal(streamer.getState().loading, 0);
    assert.equal(streamer.getState().resident, 0);
    assert.equal(fixture.created.textures.length, 0);
    assert.equal(fixture.created.geometries[0].disposed, 1);
  } finally {
    streamer.dispose();
    if (previous) Object.defineProperty(globalThis, "createImageBitmap", previous);
    else delete globalThis.createImageBitmap;
  }
});

test("late browser bitmap decode closes without creating a texture after cancellation", async () => {
  const fixture = stubs();
  const ground = tile("g0", "terrain");
  const previous = Object.getOwnPropertyDescriptor(globalThis, "createImageBitmap");
  const image = deferred();
  Object.defineProperty(globalThis, "createImageBitmap", { configurable: true, value: () => image.promise });
  const streamer = createRegionStreamer(fixture.THREE, fixture.group, {
    fetchImpl: async (url) => url.endsWith(".bin")
      ? { ok: true, arrayBuffer: async () => data(ground) }
      : { ok: true, blob: async () => ({ size: 10, type: "image/webp" }) },
  });
  try {
    streamer.setManifest({ tiles: [ground] });
    streamer.update({ x: 0, z: 0 }, "balanced", 0);
    await settle();
    streamer.dispose();
    const bitmap = { width: 256, height: 256, closed: 0, close() { this.closed += 1; } };
    image.resolve(bitmap);
    await settle();
    assert.equal(bitmap.closed, 1);
    assert.equal(fixture.created.textures.length, 0);
    assert.equal(streamer.getState().resident, 0);
    assert.equal(streamer.getState().loading, 0);
  } finally {
    streamer.dispose();
    if (previous) Object.defineProperty(globalThis, "createImageBitmap", previous);
    else delete globalThis.createImageBitmap;
  }
});
