import test from "node:test";
import assert from "node:assert/strict";
import { outsideRectangle } from "../scripts/build-region-terrain.mjs";

const area = (polygon) => Math.abs(polygon.reduce((sum, a, i) => { const b = polygon[(i + 1) % polygon.length]; return sum + a[0] * b[2] - b[0] * a[2]; }, 0) / 2);
test("Core terrain clipping preserves entirely outside triangles", () => {
  const triangle = [[-3, 0, -3, 0, 1], [-3, 0, -2, 0, 0], [-2, 0, -3, 1, 1]];
  assert.equal(outsideRectangle(triangle, [0, 0, 1, 1]).reduce((sum, p) => sum + area(p), 0), 0.5);
});
test("Core terrain clipping removes inside area exactly", () => {
  const triangle = [[0.1, 0, 0.1, 0, 1], [0.1, 0, 0.9, 0, 0], [0.9, 0, 0.1, 1, 1]];
  assert.deepEqual(outsideRectangle(triangle, [0, 0, 1, 1]), []);
});
test("Core terrain clip splits a crossing triangle without coarse grid gaps", () => {
  const triangle = [[-1, 0, -1, 0, 1], [-1, 0, 3, 0, 0], [3, 0, -1, 1, 1]];
  const pieces = outsideRectangle(triangle, [0, 0, 1, 1]);
  assert.ok(pieces.length >= 2);
  assert.equal(pieces.reduce((sum, polygon) => sum + area(polygon), 0), 7);
  for (const polygon of pieces) for (const p of polygon) assert.ok(p.every(Number.isFinite));
});
