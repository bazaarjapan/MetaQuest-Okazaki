import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { decodeDemRgb, interpolateElevation, validateDemTile, applyLiveTerrainHeight } from "../src/terrain-height.js";

test("GSI DEM unsigned positive RGB uses centimetres", () => {
  assert.equal(decodeDemRgb(0, 0, 100), 1);
  assert.equal(decodeDemRgb(0, 3, 232), 10);
});
test("GSI DEM signed RGB preserves below-sea-level elevations", () => {
  assert.equal(decodeDemRgb(255, 255, 156), -1);
  assert.equal(decodeDemRgb(255, 255, 255), -0.01);
});
test("GSI DEM nodata and transparent samples are never flat zeros", () => {
  assert.equal(decodeDemRgb(128, 0, 0), null);
  assert.equal(decodeDemRgb(0, 0, 0, 0), null);
  assert.equal(decodeDemRgb(0, 0, 0), 0);
});
test("Bilinear interpolation respects corner weights and fractional slopes", () => {
  assert.deepEqual(interpolateElevation([0, 10, 20, 30], 0.5, 0.5), { height: 15, partial: false });
  assert.deepEqual(interpolateElevation([4, 10, 20, 30], 0, 0), { height: 4, partial: false });
});
test("Partial NoData is normalized and whole NoData rejects rather than inventing ground", () => {
  assert.deepEqual(interpolateElevation([null, 10, 20, 30], 0.5, 0.5), { height: 20, partial: true });
  assert.equal(interpolateElevation([null, null, null, null], 0.5, 0.5), null);
  assert.equal(interpolateElevation([null, 10, 20, 30], 0, 0), null);
});
test("Live DEM endpoints are tightly limited to official z14 DEM10B", () => {
  const tile = { zoom: 14, x: 14433, y: 6493, demUrl: "https://cyberjapandata.gsi.go.jp/xyz/dem_png/14/14433/6493.png", heightMode: "live-gsi-dem" };
  assert.equal(validateDemTile(tile), tile.demUrl);
  assert.throws(() => validateDemTile({ ...tile, demUrl: "https://example.com/height.png" }));
  assert.throws(() => validateDemTile({ ...tile, zoom: 18 }));
  assert.throws(() => validateDemTile({ ...tile, x: -1 }));
  assert.throws(() => validateDemTile({ ...tile, heightMode: "static" }));
});

function fixtureGeometry() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 1], 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute([0, 1, 1, 1, 0, 0, 1, 0], 2));
  geometry.setIndex([0, 2, 1, 1, 2, 3]);
  return geometry;
}

async function fakeDecoder(callback) {
  const oldBitmap = globalThis.createImageBitmap, oldCanvas = globalThis.OffscreenCanvas;
  globalThis.createImageBitmap = async (blob) => ({ width: 256, height: 256, pixels: new Uint8ClampedArray(await blob.arrayBuffer()), close() {} });
  globalThis.OffscreenCanvas = class {
    getContext() { const state = {}; return { drawImage(bitmap) { state.pixels = bitmap.pixels; }, getImageData() { return { data: state.pixels }; } }; }
  };
  try { return await callback(); }
  finally {
    if (oldBitmap) globalThis.createImageBitmap = oldBitmap; else delete globalThis.createImageBitmap;
    if (oldCanvas) globalThis.OffscreenCanvas = oldCanvas; else delete globalThis.OffscreenCanvas;
  }
}

function fakePng(height) {
  const pixels = new Uint8Array(256 * 256 * 4), encoded = height === null ? 8388608 : Math.round(height * 100);
  for (let index = 0; index < pixels.length; index += 4) { pixels[index] = encoded >>> 16; pixels[index + 1] = encoded >>> 8; pixels[index + 2] = encoded; pixels[index + 3] = 255; }
  return new Response(new Blob([pixels], { type: "image/png" }), { status: 200 });
}

test("Live height pipeline samples matching neighbouring tile borders and recomputes geometry", async () => {
  await fakeDecoder(async () => {
    const tile = { zoom: 14, x: 100, y: 100, demUrl: "https://cyberjapandata.gsi.go.jp/xyz/dem_png/14/100/100.png", heightMode: "live-gsi-dem" };
    const geometry = fixtureGeometry(), requests = [];
    const stats = await applyLiveTerrainHeight(THREE, geometry, tile, { fetchImpl: async (url) => {
      requests.push(url); const match = url.match(/\/(\d+)\/(\d+)\.png$/);
      return fakePng(1 + (+match[1] - 100) + 2 * (+match[2] - 100));
    } });
    assert.deepEqual([0, 1, 2, 3].map((i) => geometry.getAttribute("position").getY(i)), [1, 2, 3, 4]);
    assert.equal(requests.length, 4);
    assert.equal(stats.sourceTileCount, 4);
    assert.deepEqual(stats.heightRange, [1, 4]);
    assert.ok(geometry.getAttribute("normal").array.every(Number.isFinite));
    assert.ok(geometry.boundingSphere.radius > 0);
    geometry.dispose();
  });
});

test("Missing live elevations fail atomically without displaying artificial flat ground", async () => {
  await fakeDecoder(async () => {
    const tile = { zoom: 14, x: 200, y: 200, demUrl: "https://cyberjapandata.gsi.go.jp/xyz/dem_png/14/200/200.png", heightMode: "live-gsi-dem" };
    const geometry = fixtureGeometry();
    await assert.rejects(applyLiveTerrainHeight(THREE, geometry, tile, { fetchImpl: async () => fakePng(null) }), /no valid elevation/);
    assert.deepEqual([0, 1, 2, 3].map((i) => geometry.getAttribute("position").getY(i)), [0, 0, 0, 0]);
    geometry.dispose();
  });
});

test("Live DEM request failure is not treated as a zero-elevation success", async () => {
  const tile = { zoom: 14, x: 300, y: 300, demUrl: "https://cyberjapandata.gsi.go.jp/xyz/dem_png/14/300/300.png", heightMode: "live-gsi-dem" };
  const geometry = fixtureGeometry();
  await assert.rejects(applyLiveTerrainHeight(THREE, geometry, tile, { fetchImpl: async () => new Response("not found", { status: 404 }) }), /DEM request failed/);
  geometry.dispose();
});

test("Cancelled consumers cannot start network requests or mutate terrain", async () => {
  const tile = { zoom: 14, x: 400, y: 400, demUrl: "https://cyberjapandata.gsi.go.jp/xyz/dem_png/14/400/400.png", heightMode: "live-gsi-dem" };
  const controller = new AbortController(); controller.abort();
  let requests = 0;
  const geometry = fixtureGeometry();
  await assert.rejects(applyLiveTerrainHeight(THREE, geometry, tile, { signal: controller.signal, fetchImpl: async () => { requests++; return fakePng(1); } }));
  assert.equal(requests, 0); geometry.dispose();
});
