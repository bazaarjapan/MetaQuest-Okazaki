// GSI DEM10B is fetched live, not distributed as derived elevation assets.
// Specification: https://maps.gsi.go.jp/development/demtile.html
const DEM_ORIGIN = "https://cyberjapandata.gsi.go.jp";
const cache = new Map();
const pending = new Map();
const waiters = [];
let active = 0;
const MAX_CACHED = 24;

export function decodeDemRgb(r, g, b, alpha = 255) {
  if (alpha === 0) return null;
  const encoded = r * 65536 + g * 256 + b;
  if (encoded === 8388608) return null;
  return (encoded < 8388608 ? encoded : encoded - 16777216) * 0.01;
}

export function interpolateElevation(samples, fx, fy) {
  const weights = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy];
  let sum = 0, weight = 0, valid = 0;
  for (let i = 0; i < 4; i++) {
    if (!Number.isFinite(samples[i]) || weights[i] <= 0) continue;
    sum += samples[i] * weights[i];
    weight += weights[i];
    valid++;
  }
  return weight > 0 ? { height: sum / weight, partial: valid < weights.filter((w) => w > 0).length } : null;
}

export function validateDemTile(tile) {
  const { zoom, x, y } = tile;
  if (zoom !== 14 || !Number.isInteger(x) || !Number.isInteger(y)
    || x < 0 || y < 0 || x >= 2 ** zoom || y >= 2 ** zoom) throw new Error("Invalid GSI DEM tile coordinates");
  const expected = `${DEM_ORIGIN}/xyz/dem_png/${zoom}/${x}/${y}.png`;
  if (tile.demUrl !== expected || tile.heightMode !== "live-gsi-dem") throw new Error("Terrain must use the official live GSI DEM endpoint");
  return expected;
}

async function bounded(task) {
  if (active >= 3) await new Promise((resolve) => waiters.push(resolve));
  else active++;
  try { return await task(); }
  finally {
    const next = waiters.shift();
    // Reserve the released permit for an existing waiter; a newly queued task
    // cannot overtake it and accidentally exceed three live network requests.
    if (next) next(); else active--;
  }
}

async function loadDem(url, fetchImpl) {
  if (cache.has(url)) {
    const pixels = cache.get(url);
    cache.delete(url); cache.set(url, pixels);
    return pixels;
  }
  if (pending.has(url)) return pending.get(url);
  const request = bounded(async () => {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(15000), mode: "cors", credentials: "omit" });
    if (!response.ok) throw new Error(`GSI DEM request failed (${response.status})`);
    if (response.redirected && response.url && new URL(response.url).origin !== DEM_ORIGIN) throw new Error("Unexpected DEM redirect");
    const blob = await response.blob();
    if (!/^image\/png(?:;|$)/i.test(blob.type) || blob.size === 0 || blob.size > 2 * 1024 * 1024) throw new Error("Invalid GSI DEM image");
    const bitmap = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
    try {
      if (bitmap.width !== 256 || bitmap.height !== 256) throw new Error("GSI DEM dimensions must be 256 by 256");
      const canvas = new OffscreenCanvas(256, 256);
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("Cannot decode DEM image on this browser");
      context.drawImage(bitmap, 0, 0);
      const pixels = context.getImageData(0, 0, 256, 256).data;
      cache.set(url, pixels);
      while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
      return pixels;
    } finally { bitmap.close(); }
  }).finally(() => pending.delete(url));
  pending.set(url, request);
  return request;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason || new DOMException("Terrain load cancelled", "AbortError");
}

async function consumerWait(promise, signal) {
  throwIfAborted(signal);
  if (!signal) return promise;
  let rejectAbort;
  const onAbort = () => rejectAbort(signal.reason || new DOMException("Terrain load cancelled", "AbortError"));
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      rejectAbort = reject;
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    })]);
  } finally { signal.removeEventListener("abort", onAbort); }
}

export async function applyLiveTerrainHeight(THREE, geometry, tile, { signal, fetchImpl = fetch } = {}) {
  validateDemTile(tile);
  throwIfAborted(signal);
  const position = geometry.getAttribute("position"), uv = geometry.getAttribute("uv");
  if (!position || !uv || position.count !== uv.count) throw new Error("Terrain position/UV geometry is invalid");
  // UV samples on east/south borders use the adjacent DEM's first pixel. Both
  // chunks then use the identical global sample and have no height seam.
  const source = new Map();
  const keys = new Set(["0,0"]);
  for (let i = 0; i < uv.count; i++) {
    const px = Math.max(0, Math.min(256, uv.getX(i) * 256));
    const py = Math.max(0, Math.min(256, (1 - uv.getY(i)) * 256));
    for (const xx of [Math.floor(px), Math.ceil(px)]) for (const yy of [Math.floor(py), Math.ceil(py)]) keys.add(`${Math.floor(xx / 256)},${Math.floor(yy / 256)}`);
  }
  await consumerWait(Promise.all([...keys].map(async (key) => {
    const [dx, dy] = key.split(",").map(Number);
    const url = `${DEM_ORIGIN}/xyz/dem_png/${tile.zoom}/${tile.x + dx}/${tile.y + dy}.png`;
    source.set(key, await loadDem(url, fetchImpl));
  })), signal);
  throwIfAborted(signal);
  const sample = (x, y) => {
    const pixels = source.get(`${Math.floor(x / 256)},${Math.floor(y / 256)}`);
    const offset = ((y % 256) * 256 + x % 256) * 4;
    return decodeDemRgb(pixels[offset], pixels[offset + 1], pixels[offset + 2], pixels[offset + 3]);
  };
  const heights = new Float32Array(position.count);
  let partialVertices = 0, minimum = Infinity, maximum = -Infinity;
  for (let i = 0; i < position.count; i++) {
    const px = Math.max(0, Math.min(256, uv.getX(i) * 256));
    const py = Math.max(0, Math.min(256, (1 - uv.getY(i)) * 256));
    const x0 = Math.floor(px), y0 = Math.floor(py), x1 = Math.ceil(px), y1 = Math.ceil(py);
    const value = interpolateElevation([sample(x0, y0), sample(x1, y0), sample(x0, y1), sample(x1, y1)], px - x0, py - y0);
    // No invented flat ground or neighbouring-hill fill when a node is missing.
    if (!value) throw new Error(`GSI DEM has no valid elevation at terrain vertex ${i}`);
    if (value.partial) partialVertices++;
    heights[i] = value.height;
    minimum = Math.min(minimum, value.height); maximum = Math.max(maximum, value.height);
  }
  throwIfAborted(signal);
  for (let i = 0; i < position.count; i++) position.setY(i, heights[i]);
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return { heightMode: "live-gsi-dem", validVertices: heights.length, partialVertices,
    noDataVertices: 0, sourceTileCount: source.size, heightRange: [minimum, maximum], datum: "GSI DEM orthometric height in metres" };
}
