// A bounded, deterministic tile plan. This module has no renderer, storage or
// network dependencies, so manifest coverage and memory policy are testable.
export const regionProfiles = Object.freeze({
  performance: Object.freeze({ maxResident: 16, maxTriangles: 100000, radius: 1800 }),
  balanced: Object.freeze({ maxResident: 25, maxTriangles: 160000, radius: 2400 }),
  high: Object.freeze({ maxResident: 36, maxTriangles: 220000, radius: 3200 }),
});

export const defaultRegionBounds = Object.freeze([-265, -325, 265, 325]);

function validBounds(bounds) {
  return Array.isArray(bounds) && bounds.length === 4 &&
    bounds.every(Number.isFinite) && bounds[0] <= bounds[2] && bounds[1] <= bounds[3];
}

function pointCoordinates(position) {
  const coordinates = Array.isArray(position)
    ? { x: position[0], y: position[1], z: position[2] }
    : position ?? {};
  return {
    x: Number.isFinite(coordinates.x) ? coordinates.x : 0,
    y: Number.isFinite(coordinates.y) ? coordinates.y : 20,
    z: Number.isFinite(coordinates.z) ? coordinates.z : 0,
  };
}

function distanceToBounds(point, bounds) {
  const dx = Math.max(bounds[0] - point.x, 0, point.x - bounds[2]);
  const dz = Math.max(bounds[1] - point.z, 0, point.z - bounds[3]);
  return Math.hypot(dx, dz);
}

/**
 * Pick nearest tile IDs under hard resident and triangle budgets. The station
 * core is not part of this input or the budget; it remains resident separately.
 * Metadata is validated before selection. One nearest tile may be selected
 * beyond the radius when the viewer is outside all available tile coverage.
 * Oversized tiles must be split at build time, never bypassing the hard budget.
 */
export function planRegionTiles(tiles, position, qualityId = "balanced") {
  const profile = regionProfiles[qualityId] ?? regionProfiles.balanced;
  const point = pointCoordinates(position);
  const seen = new Set();
  const candidates = [];
  for (const tile of Array.isArray(tiles) ? tiles : []) {
    if (!tile || typeof tile.id !== "string" || !tile.id || seen.has(tile.id) ||
      !validBounds(tile.bounds) || !Number.isSafeInteger(tile.triangles) || tile.triangles < 0 ||
      (tile.bytes !== undefined && (!Number.isSafeInteger(tile.bytes) || tile.bytes < 0))) continue;
    seen.add(tile.id);
    // Excluding oversized tiles first lets a valid neighbour provide coverage.
    if (tile.triangles > profile.maxTriangles) continue;
    const distance = distanceToBounds(point, tile.bounds);
    const centerX = tile.bounds[0] / 2 + tile.bounds[2] / 2;
    const centerZ = tile.bounds[1] / 2 + tile.bounds[3] / 2;
    candidates.push({
      tile,
      distance,
      centerDistance: Math.hypot(point.x - centerX, point.z - centerZ),
    });
  }
  candidates.sort((a, b) => a.distance - b.distance ||
    a.centerDistance - b.centerDistance ||
    (a.tile.id < b.tile.id ? -1 : a.tile.id > b.tile.id ? 1 : 0));
  const nearby = candidates.filter((candidate) => candidate.distance <= profile.radius);
  const eligible = nearby.length ? nearby : candidates.slice(0, 1);
  let triangles = 0;
  const selected = [];
  for (const { tile } of eligible) {
    if (selected.length >= profile.maxResident) break;
    if (triangles + tile.triangles > profile.maxTriangles) continue;
    triangles += tile.triangles;
    selected.push(tile.id);
  }
  return selected;
}

/** Return a finite, clamped copy; never mutate a live camera or rig object. */
export function clampToRegion(position, bounds = defaultRegionBounds, maxAltitude = 1200) {
  const range = validBounds(bounds) ? bounds : defaultRegionBounds;
  const ceiling = Number.isFinite(maxAltitude) && maxAltitude >= 20 ? maxAltitude : 1200;
  const point = pointCoordinates(position);
  const clamped = {
    x: Math.max(range[0], Math.min(range[2], point.x)),
    y: Math.max(20, Math.min(ceiling, point.y)),
    z: Math.max(range[1], Math.min(range[3], point.z)),
  };
  return Array.isArray(position)
    ? [clamped.x, clamped.y, clamped.z]
    : { ...(position ?? {}), ...clamped };
}
