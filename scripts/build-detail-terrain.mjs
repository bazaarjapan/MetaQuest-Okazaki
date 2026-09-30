/**
 * Build genuine higher-resolution terrain photographs without changing UVs.
 * The existing PLATEAU DEM uses the north-up z16 rectangle x57735..57737,
 * y25974..25975. Its 768x512 atlas was checked against all six original tiles.
 * Multiplying these tile bounds by 2 or 4 keeps precisely the same coverage.
 * There is no image upscaling, AI detail, geography replacement, or mesh edit.
 *
 * Run from OkazakiWeb: node scripts/build-detail-terrain.mjs
 * Requires sharp. At most 120 GSI tiles are downloaded; cached tiles are reused.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const originals = path.resolve(
  root,
  "../OkazakiPlateauXR/PLATEAUData/Okazaki2020Mvp/udx/dem/523731_dem_6697_00_op.gml_map",
);
const city = path.join(root, "public/city");
const cache = path.join(root, ".cache/gsi/seamlessphoto");
const base = { zoom: 16, xMin: 57735, xMax: 57737, yMin: 25974, yMax: 25975 };
const sourceTemplate = "https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg";
const concurrency = 6;
const timeoutMs = 15000;
const maxFileBytes = 25 * 1024 * 1024;
const profiles = [
  { name: "standard", zoom: 17 },
  { name: "high", zoom: 18 },
];

function tileUrl(z, x, y) {
  return sourceTemplate.replace("{z}", z).replace("{x}", x).replace("{y}", y);
}

function extent(zoom) {
  const scale = 2 ** (zoom - base.zoom);
  return {
    xMin: base.xMin * scale,
    xMax: (base.xMax + 1) * scale - 1,
    yMin: base.yMin * scale,
    yMax: (base.yMax + 1) * scale - 1,
  };
}

async function validateTile(buffer, label) {
  const metadata = await sharp(buffer).metadata();
  if (metadata.format !== "jpeg" || metadata.width !== 256 || metadata.height !== 256) {
    throw new Error(`${label}: expected a genuine 256x256 JPEG tile`);
  }
}

async function loadTile(z, x, y) {
  const target = path.join(cache, String(z), String(x), `${y}.jpg`);
  try {
    const buffer = await fs.readFile(target);
    await validateTile(buffer, target);
    return { buffer, origin: "cache", cachedAt: (await fs.stat(target)).mtime.toISOString() };
  } catch (error) {
    // A corrupt cache must not silently pass as a successfully loaded image.
    if (error.code !== "ENOENT") throw error;
  }
  const url = tileUrl(z, x, y);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) {
        // Missing photography must fail, not be substituted with enlarged z16.
        const error = new Error(`HTTP ${response.status}: ${url}`);
        error.doNotRetry = response.status === 404 || response.status === 403;
        throw error;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > 2 * 1024 * 1024) throw new Error(`Unexpectedly large tile: ${url}`);
      await validateTile(buffer, url);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, buffer);
      return { buffer, origin: "download", cachedAt: new Date().toISOString() };
    } catch (error) {
      if (error.doNotRetry || attempt === 1) throw error;
    }
  }
}

async function mapBounded(items, handler) {
  const results = new Array(items.length);
  let cursor = 0;
  let firstError;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (!firstError) {
        const index = cursor++;
        if (index >= items.length) return;
        try {
          results[index] = await handler(items[index]);
        } catch (error) {
          firstError ??= error;
        }
      }
    }),
  );
  if (firstError) throw firstError;
  return results;
}

async function validateOriginalExtent() {
  const originalAtlasBuffer = await fs.readFile(path.join(originals, "combined_map_mesh0_v0_p0.png"));
  const atlas = await sharp(originalAtlasBuffer).metadata();
  if (atlas.width !== 768 || atlas.height !== 512) {
    throw new Error("Original atlas extent changed; re-establish UV alignment before building photographs");
  }
  const atlasPixels = await sharp(originalAtlasBuffer).removeAlpha().raw().toBuffer();
  if (atlasPixels.length !== atlas.width * atlas.height * 3) {
    throw new Error("Expected an RGB original terrain atlas for exact pixel alignment validation");
  }
  let matchedSamples = 0;
  // Use the original cache as the georeference source. Do not fetch extra tiles.
  for (let x = base.xMin; x <= base.xMax; x++) {
    for (let y = base.yMin; y <= base.yMax; y++) {
      const original = path.join(originals, "16", String(x), `${y}.jpg`);
      const originalTileBuffer = await fs.readFile(original);
      await validateTile(originalTileBuffer, original);
      const tilePixels = await sharp(originalTileBuffer).removeAlpha().raw().toBuffer();
      if (tilePixels.length !== 256 * 256 * 3) throw new Error(`Expected RGB tile: ${original}`);
      for (const px of [16, 128, 240]) {
        for (const py of [16, 128, 240]) {
          const tileOffset = (py * 256 + px) * 3;
          const atlasOffset = (((y - base.yMin) * 256 + py) * atlas.width + (x - base.xMin) * 256 + px) * 3;
          for (let channel = 0; channel < 3; channel++) {
            if (tilePixels[tileOffset + channel] !== atlasPixels[atlasOffset + channel]) {
              throw new Error(`Exact original tile/atlas pixel alignment failed: x${x} y${y} pixel${px},${py} channel${channel}`);
            }
          }
          matchedSamples++;
        }
      }
    }
  }
  if (matchedSamples !== 54) throw new Error("Original atlas validation did not check all 54 RGB samples");
  const manifest = JSON.parse(await fs.readFile(path.join(city, "manifest.json"), "utf8"));
  const terrain = manifest.parts.find((part) => part.texture === "Texture-001.png");
  if (!terrain || terrain.name !== "Mesh-004") {
    throw new Error("Unexpected terrain part; review its UV mapping before replacing imagery");
  }
  const webAtlasBuffer = await fs.readFile(path.join(city, "Texture-001.png"));
  const originalWeb = await sharp(webAtlasBuffer).metadata();
  if (originalWeb.width !== 768 || originalWeb.height !== 512) {
    throw new Error("Web terrain atlas changed; UV verification is required");
  }
  // Unity re-encodes the PNG, so file hashes differ although every RGB pixel is
  // identical. Verify the entire decoded atlas rather than comparing encodings.
  const webPixels = await sharp(webAtlasBuffer).removeAlpha().raw().toBuffer();
  if (!webPixels.equals(atlasPixels)) {
    throw new Error("Native and Web terrain atlas RGB pixels differ; review source/UV provenance");
  }
  return {
    samples: matchedSamples,
    channelsCompared: matchedSamples * 3,
    exactPixelEquality: true,
    orientation: "north-up row-major x57735..57737 y25974..25975",
    nativeSourceAtlasSha256: createHash("sha256").update(originalAtlasBuffer).digest("hex"),
    webAtlasSha256: createHash("sha256").update(webAtlasBuffer).digest("hex"),
    decodedPixelSha256: createHash("sha256").update(atlasPixels).digest("hex"),
    webAtlasExactPixelEquality: true,
    decodedChannelsCompared: atlasPixels.length,
  };
}

async function build(profile) {
  const bounds = extent(profile.zoom);
  const columns = bounds.xMax - bounds.xMin + 1;
  const rows = bounds.yMax - bounds.yMin + 1;
  const width = columns * 256;
  const height = rows * 256;
  const tiles = [];
  for (let y = bounds.yMin; y <= bounds.yMax; y++) {
    for (let x = bounds.xMin; x <= bounds.xMax; x++) tiles.push({ x, y });
  }
  console.log(`${profile.name}: GSI z${profile.zoom}, ${tiles.length} genuine tiles, ${width}x${height}`);
  const loaded = await mapBounded(tiles, async ({ x, y }) => ({ x, y, ...(await loadTile(profile.zoom, x, y)) }));
  const buffer = await sharp({ create: { width, height, channels: 3, background: "#000000" } })
    .composite(loaded.map(({ x, y, buffer: input }) => ({
      input,
      left: (x - bounds.xMin) * 256,
      top: (y - bounds.yMin) * 256,
    })))
    .webp({ quality: 90, effort: 5 })
    .toBuffer();
  if (buffer.length >= maxFileBytes) throw new Error(`${profile.name}: photograph exceeds 25 MiB asset budget`);
  const filename = `terrain-${profile.name}.webp`;
  return {
    filename,
    buffer,
    metadata: {
      file: filename,
      zoom: profile.zoom,
      width,
      height,
      tileSize: 256,
      tileCount: tiles.length,
      extent: bounds,
      bytes: buffer.length,
      sha256: createHash("sha256").update(buffer).digest("hex"),
      encoding: "WebP quality 90",
      largestTileBytes: Math.max(...loaded.map((tile) => tile.buffer.length)),
      inputTileFormat: "JPEG, validated exactly 256x256 pixels",
      downloadedTiles: loaded.filter((tile) => tile.origin === "download").length,
      cachedTiles: loaded.filter((tile) => tile.origin === "cache").length,
      earliestCacheDate: loaded.map((tile) => tile.cachedAt).sort()[0],
      latestCacheDate: loaded.map((tile) => tile.cachedAt).sort().at(-1),
    },
  };
}

async function main() {
  const expectedTiles = profiles.reduce((sum, profile) => {
    const e = extent(profile.zoom);
    return sum + (e.xMax - e.xMin + 1) * (e.yMax - e.yMin + 1);
  }, 0);
  if (expectedTiles > 120) throw new Error("Tile budget exceeds the explicitly bounded 120 tile region");
  const uvValidation = await validateOriginalExtent();
  const generated = [];
  // Finish both profiles before replacing outputs; a missing tile is a failed build.
  for (const profile of profiles) generated.push(await build(profile));
  const metadata = {
    version: "1.0.0",
    generatedAt: new Date().toISOString(),
    source: "国土地理院 地理院タイル 全国最新写真（シームレス）",
    attributionUrl: "https://maps.gsi.go.jp/development/ichiran.html#seamlessphoto",
    sourceUrlTemplate: sourceTemplate,
    terrainMesh: "Mesh-004",
    originalAtlas: { file: "Texture-001.png", width: 768, height: 512, ...base },
    geographicCoverage: "Exactly the original z16 tile rectangle; north-up; normalized UVs unchanged",
    uvValidation,
    provenance: "Original six cached z16 tiles and atlas checked; higher-zoom photographs are genuine source tiles, never enlarged lower-zoom imagery",
    acquisitionDate: null,
    acquisitionDateNote: "Cache/download dates are not aerial photograph acquisition dates. GSI seamless photography may combine multiple years; building geometry remains PLATEAU 2020.",
    profiles: Object.fromEntries(generated.map(({ metadata: item }, index) => [profiles[index].name, item])),
  };
  await fs.mkdir(city, { recursive: true });
  for (const item of generated) await fs.writeFile(path.join(city, item.filename), item.buffer);
  await fs.writeFile(path.join(city, "detail.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  console.log(JSON.stringify(metadata.profiles, null, 2));
}

main().catch((error) => {
  console.error(`Detail terrain build failed: ${error.message}`);
  process.exitCode = 1;
});
