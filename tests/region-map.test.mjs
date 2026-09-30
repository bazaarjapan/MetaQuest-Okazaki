import { test } from "node:test";
import assert from "node:assert/strict";
import { mapToWorld, worldToMap } from "../src/region-map.js";
test("coverage map uses north at the top and full official model bounds", () => {
  const bounds = [-3000, -15000, 20000, 5000];
  assert.deepEqual(mapToWorld(0, 0, bounds), { x: -3000, z: -15000 });
  assert.deepEqual(mapToWorld(1, 1, bounds), { x: 20000, z: 5000 });
  assert.deepEqual(mapToWorld(0.5, 0.5, bounds), { x: 8500, z: -5000 });
});
test("coverage map clamps clicks and protects against invalid coordinates", () => {
  assert.deepEqual(mapToWorld(-1, 3, [0, 0, 100, 200]), { x: 0, z: 200 });
  assert.deepEqual(mapToWorld(NaN, Infinity, [0, 0, 100, 200]), { x: 50, z: 100 });
  assert.equal(mapToWorld(0, 0, null), null);
});
test("world and map coordinates round-trip without mutating position", () => {
  const p = Object.freeze({ x: 95.92456, z: 49.00273 }), b = [-8000, -13000, 21000, 6000];
  const m = worldToMap(p, b), out = mapToWorld(m.u, m.v, b);
  assert.ok(Math.abs(out.x - p.x) < 1e-8 && Math.abs(out.z - p.z) < 1e-8);
});
