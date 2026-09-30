import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";

const publicRoot = new URL("../public/", import.meta.url);
const regionRoot = new URL("region/", publicRoot);
const building = JSON.parse(await readFile(new URL("buildings.json", regionRoot), "utf8"));
const terrain = JSON.parse(await readFile(new URL("terrain.json", regionRoot), "utf8"));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const limit = 25 * 1024 * 1024;
const expectedRegionFiles = new Set(["buildings.json", "terrain.json"]);

function finiteBounds(bounds, label) {
  assert.equal(bounds.length, 4, `${label} bounds must be [minX,minZ,maxX,maxZ]`);
  assert.ok(bounds.every(Number.isFinite), `${label} bounds are finite`);
  assert.ok(bounds[0] <= bounds[2] && bounds[1] <= bounds[3], `${label} bounds ordering`);
}
function safeName(name) {
  assert.equal(path.basename(name), name, "Asset filenames cannot escape public/region");
  assert.ok(!name.includes("..") && !name.includes("/") && !name.includes("\\"), "Unsafe asset name");
  expectedRegionFiles.add(name);
}
async function asset(name, bytes, sha256) {
  safeName(name);
  const file = await readFile(new URL(name, regionRoot));
  assert.equal(file.length, bytes, `${name}: byte size`);
  assert.ok(file.length > 0 && file.length < limit, `${name}: under 25 MiB per asset`);
  assert.equal(hash(file), sha256, `${name}: SHA256`);
  return file;
}

assert.equal(building.year, 2020);
assert.equal(building.sourceTiles, 454);
assert.equal(building.tiles.length, 770);
assert.match(building.sourceUrl, /^https:\/\/assets\.cms\.plateau\.reearth\.io\/.+\/tileset\.json$/);
assert.equal(building.heightCorrection.model, "GSIGEO2011");
assert.equal(building.heightCorrection.samples, 63);
assert.equal(building.sourceUniqueBuildings, 214053);
assert.ok(building.heightCorrection.calibration.length >= 12);
for (const sample of building.heightCorrection.calibration) {
  assert.ok([sample.originalHeight, sample.convertedHeight, sample.errorMeters].every(Number.isFinite));
  assert.ok(Math.abs(sample.errorMeters) < .2, "Original CityGML orthometric height calibration");
}
finiteBounds(building.bounds, "Building region");
const ids = new Set();
let buildingBytes = 0, buildingTriangles = 0, buildingVertices = 0;
let maxBuildingAssetBytes = 0, maxQuantizationErrorMeters = 0;
let minNormalLength = Infinity, maxNormalLength = 0;
for (const tile of building.tiles) {
  assert.ok(!ids.has(tile.id), `Duplicate tile ID: ${tile.id}`); ids.add(tile.id);
  assert.equal(tile.type, "building");
  assert.equal(tile.format, "region-building-v1");
  finiteBounds(tile.bounds, tile.id);
  assert.ok(Number.isInteger(tile.vertices) && tile.vertices > 0);
  assert.ok(Number.isInteger(tile.indices) && tile.indices > 0);
  assert.equal(tile.indices, tile.triangles * 3);
  assert.ok(tile.triangles <= building.maxTileTriangles && tile.triangles <= 100000);
  assert.ok(tile.origin.length === 3 && tile.origin.every(Number.isFinite));
  assert.ok(Number.isFinite(tile.scale) && tile.scale >= .02);
  assert.equal(tile.indexOffset, Math.ceil(tile.vertices * 9 / 4) * 4);
  assert.ok(Number.isFinite(tile.maxQuantizationErrorMeters));
  assert.ok(tile.maxQuantizationErrorMeters <= .011, "Maximum axis quantization error <= 1.1 cm");
  assert.ok(tile.maxQuantizationErrorMeters <= tile.scale / 2 + 1e-7);
  const bytes = await asset(tile.file, tile.bytes, tile.sha256);
  assert.equal(bytes.length, tile.indexOffset + tile.indices * 4);
  const position = new Int16Array(bytes.buffer, bytes.byteOffset, tile.vertices * 3);
  const normal = new Int8Array(bytes.buffer, bytes.byteOffset + tile.vertices * 6, tile.vertices * 3);
  const indices = new Uint32Array(bytes.buffer, bytes.byteOffset + tile.indexOffset, tile.indices);
  for (const index of indices) assert.ok(index < tile.vertices, `${tile.id}: in-range index`);
  for (let index = 0; index < tile.vertices; index++) {
    for (let axis = 0; axis < 3; axis++) {
      const value = position[index * 3 + axis] * tile.scale + tile.origin[axis];
      assert.ok(Number.isFinite(value), "Finite reconstructed world coordinate");
      if (axis !== 1) {
        const b = axis === 0 ? 0 : 1;
        assert.ok(value >= tile.bounds[b] - .011 && value <= tile.bounds[b + 2] + .011, "Decoded vertex inside quantization-expanded bound");
      } else assert.ok(value >= tile.heightRange[0] - .011 && value <= tile.heightRange[1] + .011);
    }
    const length = Math.hypot(normal[index * 3], normal[index * 3 + 1], normal[index * 3 + 2]) / 127;
    assert.ok(length > .98 && length < 1.02, "Int8 normal remains unit length after normalized decoding");
    minNormalLength = Math.min(minNormalLength, length); maxNormalLength = Math.max(maxNormalLength, length);
  }
  buildingBytes += tile.bytes; buildingTriangles += tile.triangles; buildingVertices += tile.vertices;
  maxBuildingAssetBytes = Math.max(maxBuildingAssetBytes, tile.bytes);
  maxQuantizationErrorMeters = Math.max(maxQuantizationErrorMeters, tile.maxQuantizationErrorMeters);
}
assert.equal(buildingTriangles, building.totalTriangles);
assert.equal(building.sourceTriangles, buildingTriangles + building.coreExcluded.triangles);
assert.equal(building.maxQuantizationErrorMeters, maxQuantizationErrorMeters);

assert.equal(terrain.tiles.length, 154);
assert.equal(terrain.heightMode, "live-gsi-dem");
assert.equal(terrain.elevationDataPubliclyPackaged, false);
assert.equal(terrain.zoom, 14);
assert.equal(terrain.photoUpsampling, false);
assert.equal(terrain.privateSourceValidation.noDataPixels, 0);
assert.equal(terrain.privateSourceValidation.allFiniteSamplesPresent, true);
assert.deepEqual(terrain.geographicBounds, building.geographicBounds);
finiteBounds(terrain.bounds, "Terrain region");
let terrainBytes = 0, terrainTriangles = 0, photoBytes = 0;
for (const tile of terrain.tiles) {
  assert.ok(!ids.has(tile.id), `Duplicate tile ID: ${tile.id}`); ids.add(tile.id);
  assert.equal(tile.type, "terrain");
  assert.equal(tile.heightMode, "live-gsi-dem");
  assert.equal(tile.templateHeight, 0);
  assert.equal(tile.heightRange, null, "No baked DEM range should be disclosed as template elevation");
  assert.equal(tile.demUrl, `https://cyberjapandata.gsi.go.jp/xyz/dem_png/${tile.zoom}/${tile.x}/${tile.y}.png`);
  assert.equal(tile.zoom, 14);
  assert.equal(tile.indices, tile.triangles * 3);
  finiteBounds(tile.bounds, tile.id);
  const bytes = await asset(tile.file, tile.bytes, tile.sha256);
  assert.equal(bytes.length, tile.vertices * 32 + tile.indices * 4);
  const floats = new Float32Array(bytes.buffer, bytes.byteOffset, tile.vertices * 8);
  const indices = new Uint32Array(bytes.buffer, bytes.byteOffset + tile.vertices * 32, tile.indices);
  assert.ok(floats.every(Number.isFinite), `${tile.id}: all position/normal/UV finite`);
  for (let index = 0; index < tile.vertices; index++) assert.equal(floats[index * 3 + 1], 0, "Public terrain geometry is a flat template; DEM must be live-loaded");
  for (const index of indices) assert.ok(index < tile.vertices, `${tile.id}: in-range terrain index`);
  const imageBytes = await asset(tile.texture, tile.textureBytes, tile.textureSha256);
  const image = await sharp(imageBytes).metadata();
  assert.equal(image.format, "webp");
  assert.equal(image.width, tile.textureWidth); assert.equal(image.height, tile.textureHeight);
  assert.equal(image.width, 256); assert.equal(image.height, 256);
  const pixels = await sharp(imageBytes).raw().toBuffer();
  assert.equal(pixels.length, image.width * image.height * image.channels, "Fully decoded photo image");
  assert.ok(["seamlessphoto", "std"].includes(tile.imageryLayer));
  assert.match(tile.imagerySourceUrl, /^https:\/\/cyberjapandata\.gsi\.go\.jp\/xyz\/(seamlessphoto|std)\/14\/\d+\/\d+\.(jpg|png)$/);
  terrainBytes += tile.bytes; terrainTriangles += tile.triangles; photoBytes += tile.textureBytes;
}
assert.equal(terrainBytes, terrain.totalGeometryBytes);
assert.equal(terrainTriangles, terrain.totalTriangles);
assert.equal(photoBytes, terrain.totalTextureBytes);
const actualRegionFiles = await readdir(regionRoot);
assert.deepEqual(actualRegionFiles.sort(), [...expectedRegionFiles].sort(), "No stale/unreferenced region assets, private cache or raw source metadata");

// A public data audit prevents accidental copying of raw DEM pixels or official
// B3DM batch metadata when rebuilding or deploying. Texture PNGs in the original
// station model are imagery, not DEM, and are the only permitted public PNGs.
const allowedPng = new Set(["city/Texture-000.png", "city/Texture-001.png"]);
let publicFiles = 0;
async function auditPublic(directory, prefix = "") {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = `${prefix}${entry.name}`, target = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
    assert.ok(!/(?:^|\/)\.(?:cache|git)(?:\/|$)/i.test(relative), "Private cache directories must not be public");
    assert.ok(!/(?:^|\/)(?:dem(?:_png|10b)?|batch(?:table|metadata)?|geoid)(?:[\/.\-_]|$)/i.test(relative), "Raw elevation/batch artifacts must not be public");
    if (entry.isDirectory()) { await auditPublic(target, relative + "/"); continue; }
    assert.ok(!entry.isSymbolicLink(), "No symlink escape in public asset tree");
    assert.ok(!/\.(?:zip|gml|b3dm|glb|terrain|dem|partial)$/i.test(relative), "Raw CityGML/B3DM/DEM source must not be public");
    if (/\.png$/i.test(relative)) assert.ok(allowedPng.has(relative), `Unexpected public PNG could contain DEM: ${relative}`);
    assert.ok((await stat(target)).size < limit, `Asset under 25 MiB: ${relative}`);
    if (/\.json$/i.test(relative)) {
      const json = JSON.parse(await readFile(target, "utf8"));
      const auditObject = value => {
        if (!value || typeof value !== "object") return;
        for (const [key, child] of Object.entries(value)) {
          assert.ok(!/^(?:BATCH_LENGTH|_BATCHID|batchTable|batchJson|batchBinary|featureTable|featureTableBinary)$/i.test(key), `Raw batch metadata key forbidden in ${relative}: ${key}`);
          auditObject(child);
        }
      };
      auditObject(json);
    }
    publicFiles++;
  }
}
await auditPublic(publicRoot);
console.log(JSON.stringify({
  ok: true,
  building: { tiles: building.tiles.length, triangles: buildingTriangles, vertices: buildingVertices, bytes: buildingBytes, maxAssetBytes: maxBuildingAssetBytes, maxQuantizationErrorMeters, normalizedNormalLength: [minNormalLength, maxNormalLength] },
  terrain: { tiles: terrain.tiles.length, triangles: terrainTriangles, geometryBytes: terrainBytes, photoBytes, publicTemplateY: 0, heightMode: terrain.heightMode, publiclyPackagedDem: false },
  publicFiles,
  auditedPublicRoot: fileURLToPath(publicRoot),
}));
