import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import sharp from "sharp";

const root = new URL("../public/city/", import.meta.url);
const detail = JSON.parse(await readFile(new URL("detail.json", root), "utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
assert.equal(detail.terrainMesh, "Mesh-004");
assert.equal(detail.uvValidation.exactPixelEquality, true);
assert.equal(detail.uvValidation.samples, 54);
assert.equal(detail.uvValidation.channelsCompared, 162);
assert.equal(detail.acquisitionDate, null, "Download dates are not photograph acquisition dates");
const webAtlasBytes = await readFile(new URL(detail.originalAtlas.file, root));
assert.equal(hash(webAtlasBytes), detail.uvValidation.webAtlasSha256);
const nativeAtlasUrl = new URL(
  "../../OkazakiPlateauXR/PLATEAUData/Okazaki2020Mvp/udx/dem/523731_dem_6697_00_op.gml_map/combined_map_mesh0_v0_p0.png",
  import.meta.url,
);
const nativeAtlasBytes = await readFile(nativeAtlasUrl);
assert.equal(hash(nativeAtlasBytes), detail.uvValidation.nativeSourceAtlasSha256);
const webPixels = await sharp(webAtlasBytes).removeAlpha().raw().toBuffer();
const nativePixels = await sharp(nativeAtlasBytes).removeAlpha().raw().toBuffer();
assert.deepEqual(webPixels, nativePixels, "Native and Web atlas encodings must decode to identical RGB pixels");
assert.equal(detail.uvValidation.webAtlasExactPixelEquality, true);
assert.equal(webPixels.length, detail.uvValidation.decodedChannelsCompared);
assert.equal(hash(webPixels), detail.uvValidation.decodedPixelSha256);
const results = [];
for (const [id, p] of Object.entries(detail.profiles)) {
  assert.match(p.file, /^terrain-(standard|high)\.webp$/);
  const bytes = await readFile(new URL(p.file, root));
  const image = await sharp(bytes).metadata();
  assert.equal(bytes.length, p.bytes);
  assert.equal(hash(bytes), p.sha256);
  assert.equal(image.format, "webp");
  assert.equal(image.width, p.width);
  assert.equal(image.height, p.height);
  assert.ok(p.bytes < 3 * 1024 * 1024);
  assert.ok(p.width <= 4096 && p.height <= 4096);
  const factor = 2 ** (p.zoom - detail.originalAtlas.zoom);
  assert.equal(p.width, detail.originalAtlas.width * factor);
  assert.equal(p.height, detail.originalAtlas.height * factor);
  assert.equal(p.extent.xMin, detail.originalAtlas.xMin * factor);
  assert.equal(p.extent.xMax + 1, (detail.originalAtlas.xMax + 1) * factor);
  assert.equal(p.extent.yMin, detail.originalAtlas.yMin * factor);
  assert.equal(p.extent.yMax + 1, (detail.originalAtlas.yMax + 1) * factor);
  assert.equal(p.tileCount, (p.extent.xMax - p.extent.xMin + 1) * (p.extent.yMax - p.extent.yMin + 1));
  assert.equal(p.tileCount, p.downloadedTiles + p.cachedTiles);
  results.push({ id, size: [p.width, p.height], bytes: p.bytes, verified: true });
}
assert.equal(results.length, 2);
console.log(JSON.stringify({ ok: true, uvSamples: 54, profiles: results }));
