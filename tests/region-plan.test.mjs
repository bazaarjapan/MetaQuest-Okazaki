import { test } from "node:test";
import assert from "node:assert/strict";
import { regionProfiles, defaultRegionBounds, planRegionTiles, clampToRegion } from "../src/region-plan.js";

const tile = (id, bounds, triangles = 1000, bytes = 16000) => ({
  id, bounds, triangles, bytes, file: `${id}.bin`,
});

test("point-containing tile is first, then neighbours are nearest-first", () => {
  const tiles = [tile("far", [1000, 0, 1500, 500]), tile("inside", [-250, -250, 250, 250]),
    tile("near", [250, -250, 750, 250])];
  assert.deepEqual(planRegionTiles(tiles, { x: 10, y: 800, z: 20 }, "balanced"), ["inside", "near", "far"]);
});

test("adjacent tiles at shared edges are selected deterministically", () => {
  const tiles = [tile("b", [0, 0, 500, 500]), tile("a", [-500, 0, 0, 500])];
  assert.deepEqual(planRegionTiles(tiles, [0, 20, 250]), ["a", "b"]);
  assert.deepEqual(planRegionTiles([...tiles].reverse(), [0, 20, 250]), ["a", "b"]);
});

test("each profile has hard resident and triangle limits", () => {
  const tiles = Array.from({ length: 50 }, (_, index) => tile(`tile-${String(index).padStart(2, "0")}`,
    [-10, -10, 10, 10], 1));
  for (const [id, profile] of Object.entries(regionProfiles)) {
    const ids = planRegionTiles(tiles, { x: 0, z: 0 }, id);
    assert.equal(ids.length, profile.maxResident);
    assert.ok(ids.length <= profile.maxTriangles);
    const costly = tiles.map((entry) => ({ ...entry, triangles: 30000 }));
    const costlyIds = planRegionTiles(costly, { x: 0, z: 0 }, id);
    assert.equal(costlyIds.length, Math.floor(profile.maxTriangles / 30000));
  }
});

test("triangle budget allows smaller later tile without admitting oversized tiles", () => {
  const tiles = [tile("inside", [-1, -1, 1, 1], 60000),
    tile("oversized", [0, 0, 20, 20], 500000),
    tile("next-expensive", [10, 0, 20, 10], 70000),
    tile("next-small", [30, 0, 40, 10], 40000)];
  assert.deepEqual(planRegionTiles(tiles, { x: 0, z: 0 }, "performance"), ["inside", "next-small"]);
});

test("search radius is measured to tile bounds, not only to its centre", () => {
  const tiles = [tile("large-containing", [-5000, -5000, 5000, 5000]),
    tile("radius-edge", [1800, 0, 1900, 100]),
    tile("outside", [1801, 0, 1901, 100])];
  assert.deepEqual(planRegionTiles(tiles, { x: 0, z: 0 }, "performance"), ["large-containing", "radius-edge"]);
});

test("nearest valid tile remains a transport fallback outside coverage and radius", () => {
  const tiles = [tile("far", [-5000, -100, -4500, 100]), tile("nearest", [100, -100, 600, 100])];
  assert.deepEqual(planRegionTiles(tiles, { x: 10000, z: 0 }, "performance"), ["nearest"]);
  assert.deepEqual(planRegionTiles([tile("oversized", [0, 0, 500, 500], 500000)], { x: 0, z: 0 }, "high"), []);
});

test("invalid metadata cannot consume slots or produce nonfinite plans", () => {
  const good = tile("good", [0, 0, 100, 100]);
  const invalid = [null, { ...good, id: "" }, { ...good, id: "bad-bounds", bounds: [NaN, 0, 100, 100] },
    { ...good, id: "backwards", bounds: [10, 10, 0, 0] },
    { ...good, id: "fractional", triangles: 0.5 }, { ...good, id: "negative", triangles: -1 },
    { ...good, id: "infinite", bytes: Infinity }];
  assert.deepEqual(planRegionTiles([...invalid, good, good], { x: NaN, z: Infinity }), ["good"]);
  assert.deepEqual(planRegionTiles(null, null), []);
});

test("unknown quality selects balanced; planner never mutates metadata or position", () => {
  const input = Object.freeze([Object.freeze(tile("one", Object.freeze([-20, -20, 20, 20])))]);
  const position = Object.freeze({ x: 0, y: 80, z: 0 });
  assert.deepEqual(planRegionTiles(input, position, "unknown"), planRegionTiles(input, position, "balanced"));
  assert.deepEqual(position, { x: 0, y: 80, z: 0 });
});

test("clamp uses manifest coverage with a bounded altitude and returns a copy", () => {
  const position = Object.freeze({ x: 9999, y: 5000, z: -9999, marker: "retained" });
  const result = clampToRegion(position, [-3000, -4000, 3500, 4500], 1200);
  assert.deepEqual(result, { x: 3500, y: 1200, z: -4000, marker: "retained" });
  assert.notEqual(result, position);
  assert.deepEqual(position, { x: 9999, y: 5000, z: -9999, marker: "retained" });
  assert.deepEqual(clampToRegion([9999, -1, -9999], [-3000, -4000, 3500, 4500], 900), [3500, 20, -4000]);
});

test("clamp has finite old-area fallback for absent or invalid coverage", () => {
  assert.deepEqual(defaultRegionBounds, [-265, -325, 265, 325]);
  assert.deepEqual(clampToRegion({ x: 999, y: -10, z: -999 }), { x: 265, y: 20, z: -325 });
  assert.deepEqual(clampToRegion({ x: NaN, y: Infinity, z: undefined }, [Infinity, 0, 0, 0]), { x: 0, y: 20, z: 0 });
  assert.deepEqual(clampToRegion(null, null, -10), { x: 0, y: 20, z: 0 });
});
