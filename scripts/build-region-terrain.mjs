import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import sharp from "sharp";
import * as THREE from "three";
import polygonClipping from 'polygon-clipping';
import { tileToLonLat, lonLatToTile, lonLatToWorld } from "./lib/region-geo.mjs";
import { decodeDemRgb } from "../src/terrain-height.js";
import { terrainBoundaryLoops } from "../src/terrain-boundary.js";

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

export async function coreTerrainFootprint() {
  const manifest = JSON.parse(await fs.readFile(path.join(app, "public", "city", "manifest.json"), "utf8"));
  const item = manifest.parts.find((part) => part.texture === "Texture-001.png");
  const buffer = await fs.readFile(path.join(app, "public", "city", item.file));
  const positions = new Float32Array(buffer.buffer, buffer.byteOffset, item.vertices * 3);
  const rectangle = [Infinity, Infinity, -Infinity, -Infinity];
  for (let index = 0; index < item.vertices; index++) {
    rectangle[0] = Math.min(rectangle[0], positions[index * 3]); rectangle[2] = Math.max(rectangle[2], positions[index * 3]);
    rectangle[1] = Math.min(rectangle[1], positions[index * 3 + 2]); rectangle[3] = Math.max(rectangle[3], positions[index * 3 + 2]);
  }
  const indices=new Uint32Array(buffer.buffer,buffer.byteOffset+item.vertices*32,item.indices);
  const loops=terrainBoundaryLoops(positions,indices);
  if(loops.length!==1)throw Error('Expected one original terrain boundary');
  const points=loops[0].map(p=>new THREE.Vector2(p[0],p[2]));
  const masks=THREE.ShapeUtils.triangulateShape(points,[]).map(ids=>ids.map(i=>loops[0][i]));
  return {rectangle,loop:loops[0],masks};
}

// Subtract the actual rim, interpolating all XYZ/UV components at each cut.
export function outsideFootprint(triangle,masks) {
  const area=p=>Math.abs(p.reduce((s,a,i)=>{const b=p[(i+1)%p.length];return s+a[0]*b[2]-b[0]*a[2];},0))/2;
  let pieces=[triangle];
  for(const mask of masks){
    const signed=mask.reduce((s,a,i)=>{const b=mask[(i+1)%3];return s+a[0]*b[2]-b[0]*a[2];},0);
    const rim=signed<0?[mask[0],mask[2],mask[1]]:mask, next=[];
    for(const polygon of pieces){
      if(Math.max(...polygon.map(p=>p[0]))<Math.min(...rim.map(p=>p[0]))||Math.min(...polygon.map(p=>p[0]))>Math.max(...rim.map(p=>p[0]))||Math.max(...polygon.map(p=>p[2]))<Math.min(...rim.map(p=>p[2]))||Math.min(...polygon.map(p=>p[2]))>Math.max(...rim.map(p=>p[2]))){next.push(polygon);continue;}
      let inside=polygon;
      for(let i=0;i<3&&inside.length;i++){
        const a=rim[i],b=rim[(i+1)%3],distance=p=>(b[0]-a[0])*(p[2]-a[2])-(b[2]-a[2])*(p[0]-a[0]);
        const cut=keep=>{const out=[];for(let j=0;j<inside.length;j++){const p=inside[j],q=inside[(j+1)%inside.length],dp=distance(p),dq=distance(q),ip=keep?dp>=0:dp<=0,iq=keep?dq>=0:dq<=0;if(ip)out.push(p);if(ip!==iq){const t=dp/(dp-dq);out.push(p.map((v,k)=>v+(q[k]-v)*t));}}return out;};
        const outside=cut(false);if(outside.length>=3&&area(outside)>1e-8)next.push(outside);inside=cut(true);
      }
    }
    pieces=next;if(!pieces.length)break;
  }
  return pieces;
}

// Polygon subtraction introduces T-junctions. Split the neighbouring face at
// every shared edge vertex before sampling heights, so both sides stay joined
// even when DEM samples or the core transition are not coplanar.
export function conformTerrainEdges(vertices, indices) {
  const count=vertices.length,result=[];
  for(let i=0;i<indices.length;i+=3){
    const ids=indices.slice(i,i+3),ring=[];
    for(let j=0;j<3;j++){
      const a=vertices[ids[j]],b=vertices[ids[(j+1)%3]],dx=b[0]-a[0],dz=b[2]-a[2],length=dx*dx+dz*dz,edge=[];
      ring.push(ids[j]);if(length<1e-12)continue;
      for(let k=0;k<count;k++){
        const p=vertices[k],t=((p[0]-a[0])*dx+(p[2]-a[2])*dz)/length;
        if(t>1e-9&&t<1-1e-9&&Math.hypot(p[0]-a[0]-t*dx,p[2]-a[2]-t*dz)<.001)edge.push({k,t});
      }
      edge.sort((a,b)=>a.t-b.t);let previous=-Infinity;
      for(const p of edge)if((p.t-previous)*Math.sqrt(length)>1e-5){ring.push(p.k);previous=p.t;}
    }
    if(ring.length===3){result.push(...ids);continue;}
    const center=vertices.length;vertices.push(vertices[ids[0]].map((_,k)=>ids.reduce((s,id)=>s+vertices[id][k],0)/3));
    for(let j=0;j<ring.length;j++)result.push(center,ring[j],ring[(j+1)%ring.length]);
  }
  return result;
}

function outsideCoreTriangle(triangle,loop){
  const polygons=polygonClipping.difference([triangle.map(p=>[p[0],p[2]])],[loop.map(p=>[p[0],p[2]])]);
  const a=triangle[0],b=triangle[1],c=triangle[2],den=(b[2]-c[2])*(a[0]-c[0])+(c[0]-b[0])*(a[2]-c[2]);
  return polygons.flatMap(polygon=>{
    const rings=polygon.map(ring=>ring.slice(0,-1).map(p=>new THREE.Vector2(...p))),flat=rings.flat();
    const points=flat.map(p=>{const u=((b[2]-c[2])*(p.x-c[0])+(c[0]-b[0])*(p.y-c[2]))/den,v=((c[2]-a[2])*(p.x-c[0])+(a[0]-c[0])*(p.y-c[2]))/den;return [p.x,0,p.y,a[3]*u+b[3]*v+c[3]*(1-u-v),a[4]*u+b[4]*v+c[4]*(1-u-v)];});
    return THREE.ShapeUtils.triangulateShape(rings[0],rings.slice(1)).map(ids=>[points[ids[0]],points[ids[2]],points[ids[1]]]);
  });
}

export function geometry(x, y, rectangle, masks=null, coreLoop=null) {
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
      const key = `${point[0].toFixed(8)},${point[2].toFixed(8)}`;
      if (!vertexMap.has(key)) { vertexMap.set(key, vertices.length); vertices.push(point); }
      return vertexMap.get(key);
    });
    for (let index = 1; index < polygon.length - 1; index++) {
      const [a,b,c]=[polygon[0],polygon[index],polygon[index+1]];
      if(Math.abs((b[0]-a[0])*(c[2]-a[2])-(b[2]-a[2])*(c[0]-a[0]))>1e-8)indices.push(mapped[0], mapped[index], mapped[index + 1]);
    }
  };
  for (let row = 0; row < 16; row++) for (let column = 0; column < 16; column++) {
    const a = row * 17 + column, b = a + 1, c = a + 17, d = c + 1;
    for (const triangle of [[points[a], points[c], points[b]], [points[b], points[c], points[d]]]) {
      const intersects=Math.max(...triangle.map(p=>p[0]))>=rectangle[0]&&Math.min(...triangle.map(p=>p[0]))<=rectangle[2]&&Math.max(...triangle.map(p=>p[2]))>=rectangle[1]&&Math.min(...triangle.map(p=>p[2]))<=rectangle[3];
      for (const polygon of coreLoop?(intersects?outsideCoreTriangle(triangle,coreLoop):[triangle]):masks?(intersects?outsideFootprint(triangle,masks):[triangle]):outsideRectangle(triangle, rectangle)) add(polygon);
    }
  }
  // Core heights vary at every original rim vertex. Regional boundary faces
  // must include those vertices rather than bridging over their height detail.
  for(const p of coreLoop??[]){
    if(vertices.some(v=>Math.hypot(v[0]-p[0],v[2]-p[2])<.0001))continue;
    let inserted=false;
    for(let n=0;n<indices.length&&!inserted;n+=3)for(let j=0;j<3&&!inserted;j++){
      const a=vertices[indices[n+j]],b=vertices[indices[n+(j+1)%3]],dx=b[0]-a[0],dz=b[2]-a[2],length=dx*dx+dz*dz;
      if(!length)continue;const t=((p[0]-a[0])*dx+(p[2]-a[2])*dz)/length;
      if(t<=0||t>=1||Math.hypot(p[0]-a[0]-t*dx,p[2]-a[2]-t*dz)>.0001)continue;
      vertices.push(a.map((v,k)=>v+(b[k]-v)*t));inserted=true;
    }
  }
  const conformed=masks?conformTerrainEdges(vertices,indices):indices;
  const position = new Float32Array(vertices.length * 3), uv = new Float32Array(vertices.length * 2);
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (let index = 0; index < vertices.length; index++) {
    position.set(vertices[index].slice(0, 3), index * 3); uv.set(vertices[index].slice(3), index * 2);
    bounds[0] = Math.min(bounds[0], vertices[index][0]); bounds[2] = Math.max(bounds[2], vertices[index][0]);
    bounds[1] = Math.min(bounds[1], vertices[index][2]); bounds[3] = Math.max(bounds[3], vertices[index][2]);
  }
  const index = Uint32Array.from(conformed);
  const mesh = new THREE.BufferGeometry();
  mesh.setAttribute("position", new THREE.BufferAttribute(position, 3));
  mesh.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  mesh.setIndex(new THREE.BufferAttribute(index, 1)); mesh.computeVertexNormals();
  const normal = mesh.getAttribute("normal").array;
  const buffer = Buffer.concat([position, normal, uv, index].map((array) => Buffer.from(array.buffer, array.byteOffset, array.byteLength)));
  mesh.dispose();
  return { buffer, vertices: vertices.length, indices: index.length, triangles: index.length / 3, bounds };
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
  const {rectangle,masks,loop} = await coreTerrainFootprint();
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
    const id = `g-${zoom}-${x}-${y}`, generated = geometry(x, y, rectangle, masks, loop);
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
    coreExclusion: { type: "exact original Mesh-004 footprint clipping", bounds: rectangle,
      note: "Only the actual original terrain footprint is excluded; its bounding-box corner strips remain covered by live DEM terrain." },
    groundGrid: "17 by 17 per z14 source tile, source latitude/longitude projected into the original Unity coordinate system",
    photoUpsampling: false, elevationNoDataPolicy: "Live terrain fails to load if a vertex has no valid DEM sample; partial bilinear samples are renormalized and reported, never silently filled with zero",
    imageryFallbackTiles: tiles.filter((tile) => tile.imageryFallback).length,
    totalTriangles: tiles.reduce((sum, tile) => sum + tile.triangles, 0),
    totalGeometryBytes: tiles.reduce((sum, tile) => sum + tile.bytes, 0), totalTextureBytes: tiles.reduce((sum, tile) => sum + tile.textureBytes, 0), tiles };
  await fs.writeFile(path.join(output, "terrain.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, tiles: tiles.length, triangles: metadata.totalTriangles, geometryBytes: metadata.totalGeometryBytes, textureBytes: metadata.totalTextureBytes, fallbackPhotos: metadata.imageryFallbackTiles, publicElevations: false }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(`Region terrain build failed: ${error.message}`); process.exitCode = 1; });
