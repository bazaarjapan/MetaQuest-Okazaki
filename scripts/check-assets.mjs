import { readFile, stat } from "node:fs/promises";
import assert from "node:assert/strict";
const root = new URL("../public/city/", import.meta.url),
  m = JSON.parse(await readFile(new URL("manifest.json", root), "utf8"));
let bytes = 0,
  triangles = 0;
for (const p of m.parts) {
  const b = await readFile(new URL(p.file, root));
  assert.equal(b.length, p.vertices * 32 + p.indices * 4);
  const v = new Float32Array(b.buffer, b.byteOffset, p.vertices * 8);
  assert.ok(v.every(Number.isFinite));
  const indices = new Uint32Array(
    b.buffer,
    b.byteOffset + p.vertices * 32,
    p.indices,
  );
  assert.ok(indices.every((i) => i < p.vertices));
  triangles += p.indices / 3;
  bytes += b.length;
  if (p.texture) assert.ok((await stat(new URL(p.texture, root))).size > 0);
  assert.ok(b.length < 25 * 1024 * 1024);
}
assert.equal(triangles, m.triangles);
assert.equal(triangles, 58845);
console.log(
  JSON.stringify({
    ok: true,
    parts: m.parts.length,
    triangles,
    geometryBytes: bytes,
  }),
);
