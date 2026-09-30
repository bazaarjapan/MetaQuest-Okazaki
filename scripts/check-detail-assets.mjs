import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";

const defaultRoot = new URL("../public/city/", import.meta.url);
const defaultNativeAtlasUrl = new URL(
  "../../OkazakiPlateauXR/PLATEAUData/Okazaki2020Mvp/udx/dem/523731_dem_6697_00_op.gml_map/combined_map_mesh0_v0_p0.png",
  import.meta.url,
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Repository-only checks never silently claim that the external Unity source
// was verified. Pass its path explicitly to also verify native bytes and RGB.
export async function checkDetailAssets({ root = defaultRoot, nativeAtlasUrl = null } = {}) {
  const rootUrl = root instanceof URL ? new URL(root.href) : pathToFileURL(resolve(root) + sep);
  if (!rootUrl.pathname.endsWith("/")) rootUrl.pathname += "/";
  const detail = JSON.parse(await readFile(new URL("detail.json", rootUrl), "utf8"));
  assert.equal(detail.terrainMesh, "Mesh-004");
  assert.equal(detail.uvValidation.exactPixelEquality, true);
  assert.equal(detail.uvValidation.samples, 54);
  assert.equal(detail.uvValidation.channelsCompared, 162);
  assert.equal(detail.acquisitionDate, null, "Download dates are not photograph acquisition dates");
  const webAtlasBytes = await readFile(new URL(detail.originalAtlas.file, rootUrl));
  assert.equal(hash(webAtlasBytes), detail.uvValidation.webAtlasSha256, "Web atlas SHA-256 mismatch");
  const webImage = await sharp(webAtlasBytes).metadata();
  assert.equal(webImage.format, "png");
  assert.equal(webImage.width, detail.originalAtlas.width);
  assert.equal(webImage.height, detail.originalAtlas.height);
  const webPixels = await sharp(webAtlasBytes).removeAlpha().raw().toBuffer();
  assert.equal(detail.uvValidation.webAtlasExactPixelEquality, true);
  assert.equal(webPixels.length, detail.uvValidation.decodedChannelsCompared);
  assert.equal(hash(webPixels), detail.uvValidation.decodedPixelSha256, "Decoded Web atlas RGB SHA-256 mismatch");
  let nativeSourceVerified = false;
  if (nativeAtlasUrl !== null) {
    const nativeAtlasBytes = await readFile(nativeAtlasUrl);
    assert.equal(hash(nativeAtlasBytes), detail.uvValidation.nativeSourceAtlasSha256, "Native source atlas SHA-256 mismatch");
    const nativePixels = await sharp(nativeAtlasBytes).removeAlpha().raw().toBuffer();
    assert.deepEqual(webPixels, nativePixels, "Native and Web atlas encodings must decode to identical RGB pixels");
    nativeSourceVerified = true;
  }
  const results = [];
  for (const [id, p] of Object.entries(detail.profiles)) {
    assert.match(p.file, /^terrain-(standard|high)\.webp$/);
    const bytes = await readFile(new URL(p.file, rootUrl));
    const image = await sharp(bytes).metadata();
    assert.equal(bytes.length, p.bytes, `${id} profile byte length mismatch`);
    assert.equal(hash(bytes), p.sha256, `${id} profile SHA-256 mismatch`);
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
  return { ok: true, uvSamples: 54, nativeSourceVerified, profiles: results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  assert.ok(args.length === 0 || (args.length === 1 && args[0] === "--with-native-source"),
    "Usage: node scripts/check-detail-assets.mjs [--with-native-source]");
  console.log(JSON.stringify(await checkDetailAssets({
    nativeAtlasUrl: args.length ? defaultNativeAtlasUrl : null,
  })));
}
