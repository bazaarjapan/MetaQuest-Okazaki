import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createSurfaceIndex, validatePlacement } from "../src/placement.js";

function plane(minX = -20, minZ = -20, maxX = 20, maxZ = 20, elevation = () => 3) {
  const a = [minX, elevation(minX, minZ), minZ], b = [maxX, elevation(maxX, minZ), minZ], c = [maxX, elevation(maxX, maxZ), maxZ], d = [minX, elevation(minX, maxZ), maxZ];
  return new Float32Array([...a, ...b, ...c, ...a, ...c, ...d]);
}
function cube() {
  const corners = [[-1, 0, -1], [1, 0, -1], [1, 2, -1], [-1, 2, -1], [-1, 0, 1], [1, 0, 1], [1, 2, 1], [-1, 2, 1]];
  const faces = [[0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6], [0, 4, 5], [0, 5, 1], [3, 2, 6], [3, 6, 7], [0, 3, 7], [0, 7, 4], [1, 5, 6], [1, 6, 2]];
  return new Float32Array(faces.flatMap((face) => face.flatMap((id) => corners[id])));
}
const ground = createSurfaceIndex(plane());
const candidate = (overrides = {}) => ({ positions: cube(), position: [0, 999, 0], rotation: [0, 0, 0], scale: [1, 1, 1], ...overrides });
const context = (overrides = {}) => ({ terrain: ground, obstacles: [], bounds: [-20, -20, 20, 20], ...overrides });
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);

test("placement snaps to trusted ground instead of accepting submitted Y", () => {
  const result = validatePlacement(candidate(), context()); assert.equal(result.valid, true);
  assert.deepEqual(result.position, [0, 3, 0]); assert.deepEqual(result.bounds, { min: [-1, 3, -1], max: [1, 5, 1] });
});
test("sloped terrain ground contact follows actual bottom footprint", () => {
  const sloped = createSurfaceIndex(plane(-20, -20, 20, 20, (x, z) => 3 + x * .2 + z * .3));
  const result = validatePlacement(candidate(), context({ terrain: sloped }));
  assert.equal(result.valid, true); near(result.position[1], 3.5);
});
test("all-axis XYZ rotation and nonuniform scale match Three.js transforms", () => {
  const input = candidate({ rotation: [.4, .7, -.3], scale: [2, .5, 3] });
  const result = validatePlacement(input, context()); assert.equal(result.valid, true);
  const matrix = new THREE.Matrix4().compose(new THREE.Vector3(), new THREE.Quaternion().setFromEuler(new THREE.Euler(...input.rotation, "XYZ")), new THREE.Vector3(...input.scale));
  const box = new THREE.Box3();
  for (let i = 0; i < input.positions.length; i += 3) box.expandByPoint(new THREE.Vector3(...input.positions.slice(i, i + 3)).applyMatrix4(matrix));
  near(result.position[1], 3 - box.min.y);
  near(result.bounds.min[0], box.min.x); near(result.bounds.max[2], box.max.z); near(result.bounds.min[1], 3); near(result.bounds.max[1], 3 + box.max.y - box.min.y);
});
test("vertical facets use actual lower edges rather than unrelated minimum height", () => {
  const wall = new Float32Array([0, 0, -1, 0, 2, 1, 0, 3, -1]);
  const sloped = createSurfaceIndex(plane(-20, -20, 20, 20, (_x, z) => 3 + z));
  const result = validatePlacement(candidate({ positions: wall }), context({ terrain: sloped }));
  assert.equal(result.valid, true); near(result.position[1], 2);
});
test("terrain peaks inside footprint are considered, not only object vertices", () => {
  const triangles = [];
  for (const x of [-2, 0]) for (const z of [-2, 0]) triangles.push(...plane(x, z, x + 2, z + 2, (xx, zz) => xx === 0 && zz === 0 ? 10 : 0));
  const result = validatePlacement(candidate(), context({ terrain: createSurfaceIndex(new Float32Array(triangles)) }));
  assert.equal(result.valid, true); near(result.position[1], 10);
});
test("millimetre and smaller positive scales are accepted without guessing units", () => {
  for (const value of [.001, 1e-6]) assert.equal(validatePlacement(candidate({ scale: [value, value, value] }), context()).valid, true);
});
test("unknown terrain, fake indexes and footprint holes fail closed", () => {
  assert.equal(validatePlacement(candidate(), context({ terrain: {} })).valid, false);
  const away = createSurfaceIndex(plane(10, 10, 20, 20));
  assert.equal(validatePlacement(candidate(), context({ terrain: away })).valid, false);
  const strips = [...plane(-5, -5, -.2, 5), ...plane(.2, -5, 5, 5), ...plane(-.2, -5, .2, -.2), ...plane(-.2, .2, .2, 5)];
  const result = validatePlacement(candidate(), context({ terrain: createSurfaceIndex(new Float32Array(strips)) }));
  assert.equal(result.valid, false); assert.match(result.error, /unknown terrain/);
});
test("full footprint must lie within terrain, not merely the model origin", () => {
  assert.equal(validatePlacement(candidate({ position: [19.5, 0, 0] }), context()).valid, false);
  const narrow = createSurfaceIndex(new Float32Array([-5, 3, -5, 5, 3, -5, -5, 3, 5]));
  assert.equal(validatePlacement(candidate(), context({ terrain: narrow })).valid, false);
});
test("roofs reject occupied interiors including buildings far above the model", () => {
  const roof = createSurfaceIndex(plane(-3, -3, 3, 3, () => 50));
  assert.equal(validatePlacement(candidate(), context({ obstacles: roof })).valid, false);
  assert.equal(validatePlacement(candidate(), context({ obstacles: [roof] })).valid, false);
});
test("vertical wall line projections reject collisions and boundary contact", () => {
  const wall = createSurfaceIndex(new Float32Array([0, 0, -5, 0, 10, 5, 0, 0, 5]));
  assert.equal(validatePlacement(candidate(), context({ obstacles: [wall] })).valid, false);
  assert.equal(validatePlacement(candidate({ position: [1, 0, 0] }), context({ obstacles: [wall] })).valid, false);
  assert.equal(validatePlacement(candidate({ position: [3, 0, 0] }), context({ obstacles: [wall] })).valid, true);
});
test("spatial AABB overlap alone does not falsely report triangular roof collision", () => {
  const outside = createSurfaceIndex(new Float32Array([0, 5, 3, 3, 5, 0, 3, 5, 3]));
  assert.equal(validatePlacement(candidate(), context({ obstacles: outside })).valid, true);
});
test("multiple obstacle indexes are all checked, and forged obstacle indexes fail", () => {
  const far = createSurfaceIndex(plane(10, 10, 12, 12)), touching = createSurfaceIndex(plane(-2, -2, 2, 2));
  assert.equal(validatePlacement(candidate(), context({ obstacles: [far, touching] })).valid, false);
  assert.equal(validatePlacement(candidate(), context({ obstacles: [{}] })).valid, false);
});
test("negative, zero, nonfinite, excessive scale and oversized objects are rejected", () => {
  for (const scale of [[0, 1, 1], [-1, 1, 1], [NaN, 1, 1], [1e-7, 1, 1], [101, 1, 1], [60, 1, 1]]) assert.equal(validatePlacement(candidate({ scale }), context()).valid, false);
  assert.equal(validatePlacement(candidate({ position: [NaN, 0, 0] }), context()).valid, false);
  assert.equal(validatePlacement(candidate({ rotation: [Infinity, 0, 0] }), context()).valid, false);
});
test("invalid, degenerate and excessive candidate arrays fail without throwing", () => {
  for (const positions of [[], new Float32Array(), new Float32Array(9), new Float32Array([NaN, 0, 0, 1, 0, 0, 0, 1, 1]), new Float32Array(20001 * 9)]) assert.equal(validatePlacement(candidate({ positions }), context()).valid, false);
  assert.equal(validatePlacement(null, context()).valid, false);
  assert.equal(validatePlacement(candidate(), context({ bounds: null })).valid, false);
});
test("indexed terrain works and subsequent input mutation cannot poison its grid", () => {
  const source = new Float32Array([-20, 3, -20, 20, 3, -20, 20, 3, 20, -20, 3, 20]), indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
  const terrain = createSurfaceIndex(source, indices); source.fill(NaN); indices.fill(999);
  assert.equal(validatePlacement(candidate(), context({ terrain })).valid, true);
});
test("surface index rejects malformed vertices, indices and unsafe geometry sizes", () => {
  assert.throws(() => createSurfaceIndex(new Float32Array()));
  assert.throws(() => createSurfaceIndex(new Float32Array([0, 0, 0])));
  assert.throws(() => createSurfaceIndex(plane(), new Uint32Array([0, 1, 999])));
  assert.throws(() => createSurfaceIndex(plane(), new Uint16Array([0, 1, 2])));
  assert.throws(() => createSurfaceIndex(plane(), null, { cellSize: 0 }));
  const invalid = plane(); invalid[0] = Infinity; assert.throws(() => createSurfaceIndex(invalid));
});
test("large terrain triangles use bounded spill index rather than unbounded cell allocation", () => {
  const terrain = createSurfaceIndex(plane(-100000, -100000, 100000, 100000));
  assert.equal(validatePlacement(candidate(), context({ terrain })).valid, true);
});
test("high triangle-count STL remains bounded and valid on simple terrain", () => {
  const triangle = [-1, 0, -1, 1, 0, -1, 0, 1, 1], positions = new Float32Array(20000 * 9);
  for (let i = 0; i < positions.length; i += 9) positions.set(triangle, i);
  assert.equal(validatePlacement(candidate({ positions }), context()).valid, true);
});
