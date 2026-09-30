import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import sharp from "sharp";
import * as THREE from "three";
import { tileToLonLat, lonLatToTile, lonLatToWorld } from "./lib/region-geo.mjs";
import { decodeDemRgb } from "../src/terrain-height.js";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cache = path.join(app, ".cache", "region");
const output = path.join(app, "public", "region");
const sourceTileset = "https://assets.cms.plateau.reearth.io/assets/eb/9515ec-6b7d-4acc-a511-022979da7661/23202_okazaki-shi_city_2020_citygml_8_op_files_bldg_3dtiles_lod1/tileset.json";
const gsi = "https://cyberjapandata.gsi.go.jp/xyz";
const zoom = 14;
const hash = (buffer) => createHash("sha256").update(buffer).digest("hex");

async function fetchBytes(url, optional = false) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (optional && [403, 404].includes(response.status)) return null;
      if (!response.ok) throw new Error(`${response.status} ${url}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length === 0 || buffer.length > 2 * 1024 * 1024) throw new Error(`Invalid source byte size: ${url}`);
      return buffer;
    } catch (error) { if (attempt === 1) throw error; }
  }
}

async function sourceImage(layer, x, y, optional = false) {
  const extension = layer === "seamlessphoto" ? "jpg" : "png";
  const filename = path.join(cache, "gsi", layer, String(zoom), String(x), `${y}.${extension}`);
  if (!filename.startsWith(cache + path.sep) || !Number.isInteger(x) || !Number.isInteger(y)) throw new Error("Invalid source cache path");
  let buffer;
  try { buffer = await fs.readFile(filename); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!buffer) {
    buffer = await fetchBytes(`${gsi}/${layer}/${zoom}/${x}/${y}.${extension}`, optional);
    if (!buffer) return null;
    await validateImage(buffer, layer);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, buffer);
  } else await validateImage(buffer, layer);
  return buffer;
}

async function validateImage(buffer, layer) {
  const metadata = await sharp(buffer).metadata();
  const format = layer === "seamlessphoto" ? "jpeg" : "png";
  if (metadata.format !== format || metadata.width !== 256 || metadata.height !== 256) throw new Error(`Invalid ${layer} source tile`);
}

async function bounded(items, task) {
  let cursor = 0;
  const results = new Array(items.length);
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (cursor < items.length) { const index = cursor++; results[index] = await task(items[index], index); }
  }));
  return results;
}

export function clipSide(polygon, axis, limit, lower, inside) {
  if (!polygon.length) return [];
  const result = [];
  const accepted = (point) => (lower ? point[axis] >= limit : point[axis] <= limit) === inside;
  for (let index = 0; index < polygon.length; index++) {
    const a = polygon[index], b = polygon[(index + 1) % polygon.length];
    const aa = accepted(a), bb = accepted(b);
    if (aa) result.push(a);
    if (aa !== bb) {
      const ratio = (limit - a[axis]) / (b[axis] - a[axis]);
      result.push(a.map((value, component) => value + (b[component] - value) * ratio));
    }
  }
  return result;
}

// Split each triangle at all four sides. This removes only the core rectangle
// rather than deleting a whole coarse cell and leaving a 100 m grid-sized gap.
export function outsideRectangle(triangle, rectangle) {
  const pieces = [];
  let candidate = triangle;
  for (const [axis, limit, lower] of [[0, rectangle[0], true], [2, rectangle[1], true], [0, rectangle[2], false], [2, rectangle[3], false]]) {
    const outside = clipSide(candidate, axis, limit, lower, false);
    if (outside.length >= 3) pieces.push(outside);
    candidate = clipSide(candidate, axis, limit, lower, true);
    if (!candidate.length) break;
  }
  return pieces;
}

async function coreExtent() {
  const manifest = JSON.parse(await fs.readFile(path.join(app, "public", "city", "manifest.json"), "utf8"));
  const item = manifest.parts.find((part) => part.texture === "Texture-001.png");
  const buffer = await fs.readFile(path.join(app, "public", "city", item.file));
  const positions = new Float32Array(buffer.buffer, buffer.byteOffset, item.vertices * 3);
  const rectangle = [Infinity, Infinity, -Infinity, -Infinity];
  for (let index = 0; index < item.vertices; index++) {
    rectangle[0] = Math.min(rectangle[0], positions[index * 3]); rectangle[2] = Math.max(rectangle[2], positions[index * 3]);
    rectangle[1] = Math.min(rectangle[1], positions[index * 3 + 2]); rectangle[3] = Math.max(rectangle[3], positions[index * 3 + 2]);
  }
  return rectangle;
}

function geometry(x, y, rectangle) {
  const points = [];
  for (let row = 0; row <= 16; row++) for (let column = 0; column <= 16; column++) {
    const u = column / 16, v = row / 16;
    const [lon, lat] = tileToLonLat(x + u, y + v, zoom);
    const [east, , south] = lonLatToWorld(lon, lat);
    points.push([east, 0, south, u, 1 - v]);
  }
  const vertices = [], indices = [], vertexMap = new Map();
  const add = (polygon) => {
    const mapped = polygon.map((point) => {
      const key = `${point[0].toFixed(6)},${point[2].toFixed(6)},${point[3].toFixed(9)},${point[4].toFixed(9)}`;
      if (!vertexMap.has(key)) { vertexMap.set(key, vertices.length); vertices.push(point); }
      return vertexMap.get(key);
    });
    for (let index = 1; index < polygon.length - 1; index++) indices.push(mapped[0], mapped[index], mapped[index + 1]);
  };
  for (let row = 0; row < 16; row++) for (let column = 0; column < 16; column++) {
    const a = row * 17 + column, b = a + 1, c = a + 17, d = c + 1;
    for (const triangle of [[points[a], points[c], points[b]], [points[b], points[c], points[d]]]) {
      for (const polygon of outsideRectangle(triangle, rectangle)) add(polygon);
    }
  }
  const position = new Float32Array(vertices.length * 3), uv = new Float32Array(vertices.length * 2);
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (let index = 0; index < vertices.length; index++) {
    position.set(vertices[index].slice(0, 3), index * 3); uv.set(vertices[index].slice(3), index * 2);
    bounds[0] = Math.min(bounds[0], vertices[index][0]); bounds[2] = Math.max(bounds[2], vertices[index][0]);
    bounds[1] = Math.min(bounds[1], vertices[index][2]); bounds[3] = Math.max(bounds[3], vertices[index][2]);
  }
  const index = Uint32Array.from(indices);
  const mesh = new THREE.BufferGeometry();
  mesh.setAttribute("position", new THREE.BufferAttribute(position, 3));
  mesh.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  mesh.setIndex(new THREE.BufferAttribute(index, 1)); mesh.computeVertexNormals();
  const normal = mesh.getAttribute("normal").array;
  const buffer = Buffer.concat([position, normal, uv, index].map((array) => Buffer.from(array.buffer, array.byteOffset, array.byteLength)));
  mesh.dispose();
  return { buffer, vertices: vertices.length, indices: indices.length, triangles: indices.length / 3, bounds };
}

async function main() {
  let tilesetBuffer;
  const tilesetCache = path.join(cache, "terrain-source-tileset.json");
  try { tilesetBuffer = await fs.readFile(tilesetCache); }
  catch (error) { if (error.code !== "ENOENT") throw error; tilesetBuffer = await fetchBytes(sourceTileset); }
  const tileset = JSON.parse(tilesetBuffer.toString("utf8"));
  const region = tileset.root.boundingVolume.region;
  if (!Array.isArray(region) || region.length !== 6 || !region.every(Number.isFinite)) throw new Error("Source has no valid root geographic region");
  const geographicBounds = region.slice(0, 4).map((value) => value * 180 / Math.PI);
  const nw = lonLatToTile(geographicBounds[0], geographicBounds[3], zoom), se = lonLatToTile(geographicBounds[2], geographicBounds[1], zoom);
  const extent = { xMin: Math.floor(nw[0]), xMax: Math.floor(se[0]), yMin: Math.floor(nw[1]), yMax: Math.floor(se[1]) };
  const tasks = [];
  for (let y = extent.yMin; y <= extent.yMax; y++) for (let x = extent.xMin; x <= extent.xMax; x++) tasks.push({ x, y });
  if (tasks.length > 200) throw new Error("This baker is explicitly bounded to the official Okazaki dataset (at most 200 ground chunks)");
  console.log(JSON.stringify({ sourceTileset, geographicBounds, zoom, extent, groundTiles: tasks.length, mode: "public flat template; elevation loaded live from GSI" }, null, 2));
  await fs.mkdir(cache, { recursive: true }); await fs.writeFile(tilesetCache, tilesetBuffer);
  const rectangle = await coreExtent();
  // Read-only/non-public DEM validation also includes the south/east neighbours
  // which the live renderer needs to sample identical heights on tile seams.
  const demTasks = [];
  for (let y = extent.yMin; y <= extent.yMax + 1; y++) for (let x = extent.xMin; x <= extent.xMax + 1; x++) demTasks.push({ x, y });
  let noDataPixels = 0, minHeight = Infinity, maxHeight = -Infinity;
  await bounded(demTasks, async ({ x, y }) => {
    const buffer = await sourceImage("dem_png", x, y);
    const pixels = await sharp(buffer).ensureAlpha().raw().toBuffer();
    for (let index = 0; index < pixels.length; index += 4) {
      const height = decodeDemRgb(pixels[index], pixels[index + 1], pixels[index + 2], pixels[index + 3]);
      if (height === null) noDataPixels++; else { minHeight = Math.min(minHeight, height); maxHeight = Math.max(maxHeight, height); }
    }
  });
  console.log(`Validated ${demTasks.length} DEM source tiles in private cache; range ${minHeight.toFixed(2)}..${maxHeight.toFixed(2)} m; NoData pixels ${noDataPixels}`);
  if (!Number.isFinite(minHeight)) throw new Error("All validation DEM samples are NoData");
  await fs.mkdir(output, { recursive: true });
  const tiles = await bounded(tasks, async ({ x, y }, index) => {
    const id = `g-${zoom}-${x}-${y}`, generated = geometry(x, y, rectangle);
    if (!generated.triangles) throw new Error(`${id} is wholly excluded by core terrain`);
    let layer = "seamlessphoto", photo = await sourceImage(layer, x, y, true);
    if (!photo) { layer = "std"; photo = await sourceImage(layer, x, y); }
    const texture = await sharp(photo).webp({ quality: 85, effort: 4 }).toBuffer();
    const file = `${id}.bin`, textureFile = `${id}.webp`;
    await fs.writeFile(path.join(output, file), generated.buffer); await fs.writeFile(path.join(output, textureFile), texture);
    if ((index + 1) % 20 === 0 || index === tasks.length - 1) console.log(`Ground ${index + 1}/${tasks.length}`);
    return { id, type: "terrain", file, texture: textureFile, zoom, x, y,
      vertices: generated.vertices, indices: generated.indices, triangles: generated.triangles,
      bytes: generated.buffer.length, bounds: generated.bounds, sha256: hash(generated.buffer),
      heightMode: "live-gsi-dem", heightRange: null, templateHeight: 0,
      demUrl: `${gsi}/dem_png/${zoom}/${x}/${y}.png`,
      textureWidth: 256, textureHeight: 256, textureBytes: texture.length, textureSha256: hash(texture),
      imageryLayer: layer, imageryFallback: layer !== "seamlessphoto", imagerySourceUrl: `${gsi}/${layer}/${zoom}/${x}/${y}.${layer === "seamlessphoto" ? "jpg" : "png"}` };
  });
  const bounds = tiles.reduce((b, tile) => [Math.min(b[0], tile.bounds[0]), Math.min(b[1], tile.bounds[1]), Math.max(b[2], tile.bounds[2]), Math.max(b[3], tile.bounds[3])], [Infinity, Infinity, -Infinity, -Infinity]);
  const metadata = { version: "1.0.0", generatedAt: new Date().toISOString(), source: "国土地理院 地理院タイル 全国最新写真（シームレス）・標高タイルDEM10B",
    attributionUrl: "https://maps.gsi.go.jp/development/ichiran.html", elevationSpecificationUrl: "https://maps.gsi.go.jp/development/demtile.html",
    sourceTileset, sourceTilesetSha256: hash(tilesetBuffer), geographicBounds, bounds, zoom, extent,
    heightMode: "live-gsi-dem", elevationDataPubliclyPackaged: false,
    privateSourceValidation: { tiles: demTasks.length, noDataPixels, allFiniteSamplesPresent: Number.isFinite(minHeight), acquisitionDate: null },
    sourceDateNote: "PLATEAU buildings are 2020; live GSI DEM and seamless imagery can have different capture/update dates. Download times are not acquisition dates. DEM orthometric heights can differ from 2020 city terrain.",
    coreExclusion: { type: "exact rectangle clipping at original Mesh-004 x/z bounding box", bounds: rectangle,
      note: "The original terrain footprint is not guaranteed to be exactly rectangular. Small boundary gaps are possible; no full grid cell is discarded." },
    groundGrid: "17 by 17 per z14 source tile, source latitude/longitude projected into the original Unity coordinate system",
    photoUpsampling: false, elevationNoDataPolicy: "Live terrain fails to load if a vertex has no valid DEM sample; partial bilinear samples are renormalized and reported, never silently filled with zero",
    imageryFallbackTiles: tiles.filter((tile) => tile.imageryFallback).length,
    totalTriangles: tiles.reduce((sum, tile) => sum + tile.triangles, 0),
    totalGeometryBytes: tiles.reduce((sum, tile) => sum + tile.bytes, 0), totalTextureBytes: tiles.reduce((sum, tile) => sum + tile.textureBytes, 0), tiles };
  await fs.writeFile(path.join(output, "terrain.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, tiles: tiles.length, triangles: metadata.totalTriangles, geometryBytes: metadata.totalGeometryBytes, textureBytes: metadata.totalTextureBytes, fallbackPhotos: metadata.imageryFallbackTiles, publicElevations: false }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(`Region terrain build failed: ${error.message}`); process.exitCode = 1; });
