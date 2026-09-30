import { test } from "node:test";
import assert from "node:assert/strict";
import { lonLatToWorld, worldToLonLat, tileToLonLat, lonLatToTile, origin, withinCore } from "../scripts/lib/region-geo.mjs";
test("wide region projection matches the saved JR Okazaki station within one millimetre", () => {
  const p = lonLatToWorld(137.1573, 34.9256, 16.5);
  assert.ok(Math.abs(p[0] - 95.924560546875) < 0.001);
  assert.ok(Math.abs(p[2] - 49.00273132324219) < 0.001);
  assert.equal(p[1], 16.5);
  assert.deepEqual(lonLatToWorld(...origin), [0, 0, 0]);
});
test("wide region longitude-latitude projection round-trips across the city", () => {
  for (const [lon, lat] of [[137.1, 34.85], [137.4, 35.05], [...origin]]) {
    const p = lonLatToWorld(lon, lat), result = worldToLonLat(p[0], p[2]);
    assert.ok(Math.abs(result[0] - lon) < 1e-8 && Math.abs(result[1] - lat) < 1e-8);
  }
});
test("map tile bounds retain north-up placement and exact tile coordinates", () => {
  const p = tileToLonLat(14434, 6493, 14), t = lonLatToTile(...p, 14);
  assert.ok(Math.abs(t[0] - 14434) < 1e-8 && Math.abs(t[1] - 6493) < 1e-8);
  assert.ok(tileToLonLat(14434, 6494, 14)[1] < p[1]);
});
test("wide buildings avoid duplicating the preserved detailed station rectangle", () => {
  assert.ok(withinCore(95.92456, 49.00273));
  assert.ok(!withinCore(...[lonLatToWorld(137.17, 34.95)[0], lonLatToWorld(137.17, 34.95)[2]]));
});
