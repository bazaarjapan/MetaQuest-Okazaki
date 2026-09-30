import test from "node:test";
import assert from "node:assert/strict";
import { parseSTL, normalizeSTLPositions, STL_LIMITS } from "../src/stl-model.js";

const vertices = [10, 20, 30, 14, 20, 30, 10, 24, 34];
function ascii(points = vertices, name = "model") {
  return new TextEncoder().encode(`solid ${name}\nfacet normal 0 0 1\nouter loop\n${[0, 3, 6].map((i) => `vertex ${points.slice(i, i + 3).join(" ")}`).join("\n")}\nendloop\nendfacet\nendsolid ${name}`);
}
function binary(points = vertices, header = "binary mesh", count = 1) {
  const bytes = new Uint8Array(84 + count * 50), view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode(header)); view.setUint32(80, count, true);
  for (let triangle = 0; triangle < count; triangle++) for (let j = 0; j < 9; j++) view.setFloat32(84 + triangle * 50 + 12 + j * 4, points[j], true);
  return bytes;
}

test("ASCII STL preserves source coordinates and bounds without guessing units", () => {
  const parsed = parseSTL(ascii());
  assert.equal(parsed.triangles, 1); assert.deepEqual([...parsed.positions], vertices);
  assert.deepEqual(parsed.bounds, { min: [10, 20, 30], max: [14, 24, 34] });
});
test("binary STL whose header starts solid is detected by exact length", () => {
  assert.deepEqual([...parseSTL(binary(vertices, "solid confusing header")).positions], vertices);
});
test("binary input may be an ArrayBuffer or bounded Uint8Array view", () => {
  const raw = binary(), padded = new Uint8Array(raw.length + 20); padded.set(raw, 10);
  assert.equal(parseSTL(raw.buffer).triangles, 1);
  assert.deepEqual([...parseSTL(padded.subarray(10, 10 + raw.length)).positions], vertices);
});
test("ASCII accepts signed scientific numbers, CRLF and whitespace", () => {
  const text = new TextDecoder().decode(ascii()).replace("vertex 14 20 30", "vertex +1.4e1 2e1 3.0e1").replaceAll("\n", "\r\n");
  assert.deepEqual([...parseSTL(new TextEncoder().encode(`\n ${text}\n`)).positions], vertices);
});
test("malformed and truncated binary cannot silently become valid geometry", () => {
  const valid = binary();
  assert.throws(() => parseSTL(valid.subarray(0, -1)));
  const countMismatch = valid.slice(); new DataView(countMismatch.buffer).setUint32(80, 2, true);
  assert.throws(() => parseSTL(countMismatch));
  const extra = new Uint8Array(valid.length + 1); extra.set(valid); assert.throws(() => parseSTL(extra));
});
test("ASCII grammar rejects missing facet markers, extra vertices and trailing payloads", () => {
  const source = new TextDecoder().decode(ascii());
  for (const text of [source.replace("endfacet", ""), source.replace("endloop", "vertex 1 2 3\nendloop"), source + "\n<script>", source.replace("endsolid model", "endsolid other")]) assert.throws(() => parseSTL(new TextEncoder().encode(text)));
});
test("nonfinite and excessive coordinates or normals are rejected", () => {
  for (const invalid of [NaN, Infinity, -Infinity, 1e10]) {
    const points = [...vertices]; points[0] = invalid;
    assert.throws(() => parseSTL(ascii(points))); assert.throws(() => parseSTL(binary(points)));
  }
  const badNormal = binary(); new DataView(badNormal.buffer).setFloat32(84, NaN, true); assert.throws(() => parseSTL(badNormal));
});
test("empty, nontriangle and degenerate geometry is rejected", () => {
  for (const bytes of [new Uint8Array(), new TextEncoder().encode("solid\nendsolid"), binary([0, 0, 0, 1, 1, 1, 2, 2, 2]), binary([0, 0, 0, 0, 0, 0, 1, 1, 1])]) assert.throws(() => parseSTL(bytes));
  assert.throws(() => parseSTL("not bytes"));
});
test("byte and triangle caps are enforced before accepting geometry", () => {
  assert.throws(() => parseSTL(new Uint8Array(STL_LIMITS.maxBytes + 1)));
  assert.throws(() => parseSTL(binary(vertices, "mesh", STL_LIMITS.maxTriangles + 1)));
  assert.equal(parseSTL(binary(vertices, "mesh", STL_LIMITS.maxTriangles)).triangles, STL_LIMITS.maxTriangles);
});
test("Z-up conversion normalizes XZ center and bottom Y, preserving raw input", () => {
  const source = new Float32Array(vertices), normalized = normalizeSTLPositions(source);
  assert.deepEqual([...source], vertices);
  assert.deepEqual([...normalized.positions], [-2, 0, 2, 2, 0, 2, -2, 4, -2]);
  assert.deepEqual(normalized.bounds, { min: [-2, 0, -2], max: [2, 4, 2] });
});
test("Y-up normalization is explicit and performs no mm conversion", () => {
  const result = normalizeSTLPositions(new Float32Array(vertices), "y");
  assert.deepEqual([...result.positions], [-2, 0, -2, 2, 0, -2, -2, 4, 2]);
  assert.deepEqual(result.bounds, { min: [-2, 0, -2], max: [2, 4, 2] });
  assert.throws(() => normalizeSTLPositions(new Float32Array(vertices), "x"));
  assert.throws(() => normalizeSTLPositions([1, 2, 3], "y"));
});
test("newline-heavy ASCII is scanned without allocating an unbounded line array", () => {
  assert.throws(() => parseSTL(new Uint8Array(3 * 1024 * 1024).fill(10)));
  const actual = ascii(), padded = new Uint8Array(actual.length + 3 * 1024 * 1024).fill(10); padded.set(actual, 3 * 1024 * 1024);
  assert.equal(parseSTL(padded).triangles, 1);
  assert.throws(() => parseSTL(new TextEncoder().encode(`solid ${"a".repeat(1025)}\nendsolid`)), /line is too long/);
});
