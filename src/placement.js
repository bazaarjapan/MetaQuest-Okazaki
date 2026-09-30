// Pure geometry shared by browser previews and authoritative Worker validation.
// Surfaces must come from trusted PLATEAU assets, never from client-provided bounds.
const indexes = new WeakMap();
const EPSILON = 1e-8;
const MAX_TRIANGLES = 1000000;
const MAX_QUERY_CELLS = 20000;
const MAX_CHECKS = 1000000;
const MAX_PIECES = 4096;

function vector(value, name) {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite)) throw new Error(`Invalid ${name}`);
  return value;
}
function overlap(a, b) { return a[0] <= b[2] + EPSILON && a[2] + EPSILON >= b[0] && a[1] <= b[3] + EPSILON && a[3] + EPSILON >= b[1]; }
function xzBounds(points) {
  return [Math.min(...points.map((p) => p[0])), Math.min(...points.map((p) => p[1])), Math.max(...points.map((p) => p[0])), Math.max(...points.map((p) => p[1]))];
}
function cross(a, b, p) { return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]); }
function polygonArea(points) {
  let value = 0;
  for (let i = 0; i < points.length; i++) { const a = points[i], b = points[(i + 1) % points.length]; value += a[0] * b[1] - b[0] * a[1]; }
  return Math.abs(value) / 2;
}
function ccw(points) { return cross(points[0], points[1], points[2]) < 0 ? [points[0], points[2], points[1]] : points; }
function clipHalfPlane(polygon, a, b, inside = true) {
  if (!polygon.length) return [];
  const result = [];
  let previous = polygon.at(-1), previousDistance = cross(a, b, previous) * (inside ? 1 : -1);
  for (const current of polygon) {
    const distance = cross(a, b, current) * (inside ? 1 : -1);
    const wasInside = previousDistance >= -EPSILON, isInside = distance >= -EPSILON;
    if (wasInside !== isInside) {
      const ratio = previousDistance / (previousDistance - distance);
      result.push([previous[0] + (current[0] - previous[0]) * ratio, previous[1] + (current[1] - previous[1]) * ratio]);
    }
    if (isInside) result.push(current);
    previous = current; previousDistance = distance;
  }
  return result;
}
function clipTriangle(polygon, triangle) {
  const edges = ccw(triangle);
  for (let i = 0; i < 3 && polygon.length; i++) polygon = clipHalfPlane(polygon, edges[i], edges[(i + 1) % 3]);
  return polygon;
}
function subtractTriangle(polygon, triangle) {
  const result = [], edges = ccw(triangle);
  let inside = polygon;
  for (let i = 0; i < 3 && inside.length; i++) {
    const outside = clipHalfPlane(inside, edges[i], edges[(i + 1) % 3], false);
    if (outside.length >= 3 && polygonArea(outside) > EPSILON) result.push(outside);
    inside = clipHalfPlane(inside, edges[i], edges[(i + 1) % 3]);
  }
  return result;
}
function triangle(data, id) {
  const result = [];
  for (let i = 0; i < 3; i++) {
    const offset = (data.indices ? data.indices[id * 3 + i] : id * 3 + i) * 3;
    result.push([data.positions[offset], data.positions[offset + 1], data.positions[offset + 2]]);
  }
  return result;
}
function projected(points) { return points.map((p) => [p[0], p[2]]); }
function height(points, x, z) {
  const [a, b, c] = points;
  const divisor = cross([a[0], a[2]], [b[0], b[2]], [c[0], c[2]]);
  if (Math.abs(divisor) <= EPSILON) return null;
  const wa = cross([b[0], b[2]], [c[0], c[2]], [x, z]) / divisor;
  const wb = cross([c[0], c[2]], [a[0], a[2]], [x, z]) / divisor;
  return wa * a[1] + wb * b[1] + (1 - wa - wb) * c[1];
}
function lowerProjectedHeight(points, x, z) {
  const planeHeight = height(points, x, z);
  if (planeHeight !== null) return planeHeight;
  // A vertical facet projects to a line. Its lowest actual edge at each XZ
  // coordinate, not the whole facet's minimum Y, determines ground contact.
  let minimum = Infinity;
  for (let i = 0; i < 3; i++) {
    const a = points[i], b = points[(i + 1) % 3], dx = b[0] - a[0], dz = b[2] - a[2], lengthSquared = dx * dx + dz * dz;
    if (lengthSquared <= EPSILON * EPSILON) {
      if (Math.hypot(x - a[0], z - a[2]) <= 1e-7) minimum = Math.min(minimum, a[1], b[1]);
      continue;
    }
    const ratio = ((x - a[0]) * dx + (z - a[2]) * dz) / lengthSquared;
    if (ratio >= -EPSILON && ratio <= 1 + EPSILON && Math.abs(dx * (z - a[2]) - dz * (x - a[0])) <= 1e-7 * Math.sqrt(lengthSquared)) minimum = Math.min(minimum, a[1] + Math.max(0, Math.min(1, ratio)) * (b[1] - a[1]));
  }
  return Number.isFinite(minimum) ? minimum : null;
}

/** Flat XYZ triangles or indexed vertices. Copies inputs so the grid cannot become stale. */
export function createSurfaceIndex(positions, indices = null, { cellSize = 8 } = {}) {
  if (!(positions instanceof Float32Array) || !positions.length || positions.length % 3 || positions.length > MAX_TRIANGLES * 9 || !Number.isFinite(cellSize) || cellSize < 0.1 || cellSize > 1000) throw new Error("Invalid surface geometry");
  if (indices !== null && (!(indices instanceof Uint32Array) || !indices.length || indices.length % 3 || indices.length > MAX_TRIANGLES * 3)) throw new Error("Invalid surface indices");
  if (!indices && positions.length % 9) throw new Error("Unindexed surface must contain triangles");
  for (const value of positions) if (!Number.isFinite(value) || Math.abs(value) > 1e7) throw new Error("Invalid surface coordinate");
  if (indices) for (const value of indices) if (value >= positions.length / 3) throw new Error("Surface index is outside its vertices");
  const data = { positions: positions.slice(), indices: indices?.slice() ?? null, cellSize, cells: new Map(), large: [], boxes: [] };
  const count = indices ? indices.length / 3 : positions.length / 9;
  let records = 0;
  for (let id = 0; id < count; id++) {
    const box = xzBounds(projected(triangle(data, id))); data.boxes.push(box);
    const minX = Math.floor(box[0] / cellSize), minZ = Math.floor(box[1] / cellSize), maxX = Math.floor(box[2] / cellSize), maxZ = Math.floor(box[3] / cellSize);
    const cells = (maxX - minX + 1) * (maxZ - minZ + 1);
    if (cells > 4096 || records + cells > 1000000) {
      data.large.push(id);
      if (data.large.length > 10000) throw new Error("Surface exceeds spatial index complexity limits");
    } else {
      records += cells;
      for (let x = minX; x <= maxX; x++) for (let z = minZ; z <= maxZ; z++) {
        const key = `${x},${z}`, list = data.cells.get(key) ?? [];
        if (!data.cells.has(key)) data.cells.set(key, list);
        list.push(id);
      }
    }
  }
  const index = Object.freeze({ triangles: count, cellSize }); indexes.set(index, data); return index;
}
function getIndex(index) { const data = indexes.get(index); if (!data) throw new Error("A trusted surface index is required"); return data; }
function query(data, box, budget) {
  const minX = Math.floor(box[0] / data.cellSize), minZ = Math.floor(box[1] / data.cellSize), maxX = Math.floor(box[2] / data.cellSize), maxZ = Math.floor(box[3] / data.cellSize);
  if ((maxX - minX + 1) * (maxZ - minZ + 1) > MAX_QUERY_CELLS) throw new Error("Placement spatial query is too large");
  const candidates = new Set(data.large);
  for (let x = minX; x <= maxX; x++) for (let z = minZ; z <= maxZ; z++) {
    for (const id of data.cells.get(`${x},${z}`) ?? []) { if (++budget.checks > MAX_CHECKS) throw new Error("Placement geometry is too complex"); candidates.add(id); }
  }
  const result = [];
  for (const id of candidates) { if (++budget.checks > MAX_CHECKS) throw new Error("Placement geometry is too complex"); if (overlap(data.boxes[id], box)) result.push(id); }
  return result;
}
function triangleTouchesRectangle(points, box) {
  if (!overlap(xzBounds(points), box)) return false;
  const rectangle = [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]];
  // SAT works for roofs, vertical wall projections (line segments), and points.
  for (let i = 0; i < 3; i++) {
    const a = points[i], b = points[(i + 1) % 3], axis = [-(b[1] - a[1]), b[0] - a[0]];
    if (!axis.some((value) => value !== 0)) continue;
    const p = points.map((v) => v[0] * axis[0] + v[1] * axis[1]);
    const r = rectangle.map((v) => v[0] * axis[0] + v[1] * axis[1]);
    if (Math.max(...p) < Math.min(...r) - EPSILON || Math.max(...r) < Math.min(...p) - EPSILON) return false;
  }
  return true;
}
function transformedPositions(source, rotation, scale, position) {
  const [rx, ry, rz] = rotation, a = Math.cos(rx), b = Math.sin(rx), c = Math.cos(ry), d = Math.sin(ry), e = Math.cos(rz), f = Math.sin(rz);
  // Same intrinsic Euler XYZ convention as THREE.Euler(..., 'XYZ').
  const matrix = [c * e, -c * f, d, a * f + b * d * e, a * e - b * d * f, -b * c, b * f - a * d * e, b * e + a * d * f, a * c];
  const result = new Float64Array(source.length), min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < source.length; i += 3) {
    const x = source[i] * scale[0], y = source[i + 1] * scale[1], z = source[i + 2] * scale[2];
    const values = [matrix[0] * x + matrix[1] * y + matrix[2] * z + position[0], matrix[3] * x + matrix[4] * y + matrix[5] * z, matrix[6] * x + matrix[7] * y + matrix[8] * z + position[2]];
    for (let axis = 0; axis < 3; axis++) { result[i + axis] = values[axis]; min[axis] = Math.min(min[axis], values[axis]); max[axis] = Math.max(max[axis], values[axis]); }
  }
  return { positions: result, bounds: { min, max } };
}

/**
 * Validate real transformed triangles. Returns {valid, position, bounds, error}.
 * Candidate XYZ rotation is radians; positive XYZ scale is 1e-6..100. Y is
 * snapped, not trusted. A conservative XZ bounding rectangle must be entirely
 * covered by terrain and must not touch any projected obstacle, even walls.
 * Unknown ground, excessive complexity, out-of-region geometry fail closed.
 */
export function validatePlacement(candidate, { terrain, obstacles = [], bounds } = {}) {
  try {
    const source = candidate?.positions;
    if (!(source instanceof Float32Array) || !source.length || source.length % 9 || source.length > 20000 * 9) throw new Error("Invalid object triangles");
    for (const value of source) if (!Number.isFinite(value) || Math.abs(value) > 1e9) throw new Error("Invalid object coordinate");
    for (let i = 0; i < source.length; i += 9) {
      const ax = source[i + 3] - source[i], ay = source[i + 4] - source[i + 1], az = source[i + 5] - source[i + 2];
      const bx = source[i + 6] - source[i], by = source[i + 7] - source[i + 1], bz = source[i + 8] - source[i + 2];
      if (![ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx].some((value) => value !== 0)) throw new Error("Object contains a degenerate triangle");
    }
    const position = vector(candidate.position, "position"), rotation = vector(candidate.rotation, "rotation"), scale = vector(candidate.scale, "scale");
    if (scale.some((value) => value < 1e-6 || value > 100)) throw new Error("Scale must be positive and between 0.000001 and 100");
    if (position.some((value) => Math.abs(value) > 1e7) || rotation.some((value) => Math.abs(value) > Math.PI * 100)) throw new Error("Position or rotation is too large");
    if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite) || bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) throw new Error("Valid placement region bounds are required");
    const transformed = transformedPositions(source, rotation, scale, position), worldBounds = transformed.bounds;
    if (worldBounds.max.some((value, axis) => value - worldBounds.min[axis] > 100 + EPSILON)) throw new Error("Object dimensions must not exceed 100 metres");
    const box = [worldBounds.min[0], worldBounds.min[2], worldBounds.max[0], worldBounds.max[2]];
    if (box[0] < bounds[0] || box[1] < bounds[1] || box[2] > bounds[2] || box[3] > bounds[3]) throw new Error("Object is outside the editable region");
    const budget = { checks: 0 }, ground = getIndex(terrain);
    const obstacleIndexes = Array.isArray(obstacles) ? obstacles : [obstacles];
    for (const obstacle of obstacleIndexes) {
      const data = getIndex(obstacle);
      for (const id of query(data, box, budget)) if (triangleTouchesRectangle(projected(triangle(data, id)), box)) throw new Error("Object overlaps an existing building or occupied space");
    }
    const groundIds = query(ground, box, budget).filter((id) => {
      const points = projected(triangle(ground, id)); return Math.abs(cross(...points)) > EPSILON;
    });
    if (!groundIds.length) throw new Error("Verified terrain is unavailable at this location");
    // Exact polygon subtraction catches holes even when all four corners have
    // valid elevation. This is deliberately stricter than sampling a fake plane.
    const coverageBox = [...box];
    if (coverageBox[2] - coverageBox[0] < 1e-5) { coverageBox[0] -= 5e-6; coverageBox[2] += 5e-6; }
    if (coverageBox[3] - coverageBox[1] < 1e-5) { coverageBox[1] -= 5e-6; coverageBox[3] += 5e-6; }
    let uncovered = [[[coverageBox[0], coverageBox[1]], [coverageBox[2], coverageBox[1]], [coverageBox[2], coverageBox[3]], [coverageBox[0], coverageBox[3]]]];
    for (const id of groundIds) {
      const groundProjection = projected(triangle(ground, id)), next = [];
      for (const polygon of uncovered) {
        if (++budget.checks > MAX_CHECKS) throw new Error("Placement geometry is too complex");
        next.push(...subtractTriangle(polygon, groundProjection));
        if (next.length > MAX_PIECES) throw new Error("Terrain coverage is too complex to verify");
      }
      uncovered = next;
      if (!uncovered.length) break;
    }
    if (uncovered.reduce((sum, polygon) => sum + polygonArea(polygon), 0) > EPSILON) throw new Error("Object footprint includes unknown terrain");
    let snappedY = -Infinity;
    const p = transformed.positions;
    for (let i = 0; i < p.length; i += 9) {
      const objectPoints = [[p[i], p[i + 1], p[i + 2]], [p[i + 3], p[i + 4], p[i + 5]], [p[i + 6], p[i + 7], p[i + 8]]];
      const objectProjection = projected(objectPoints), objectBox = xzBounds(objectProjection);
      for (const id of query(ground, objectBox, budget)) {
        if (++budget.checks > MAX_CHECKS) throw new Error("Placement geometry is too complex");
        const groundPoints = triangle(ground, id), groundProjection = projected(groundPoints);
        if (Math.abs(cross(...groundProjection)) <= EPSILON) continue;
        const intersection = clipTriangle(objectProjection, groundProjection);
        for (const [x, z] of intersection) {
          const terrainY = height(groundPoints, x, z);
          const relativeY = lowerProjectedHeight(objectPoints, x, z);
          if (Number.isFinite(terrainY) && Number.isFinite(relativeY)) snappedY = Math.max(snappedY, terrainY - relativeY);
        }
      }
    }
    if (!Number.isFinite(snappedY)) throw new Error("Cannot determine a valid terrain contact");
    worldBounds.min[1] += snappedY; worldBounds.max[1] += snappedY;
    return { valid: true, position: [position[0], snappedY, position[2]], bounds: worldBounds, error: null };
  } catch (error) {
    return { valid: false, position: null, bounds: null, error: error instanceof Error ? error.message : "Invalid placement" };
  }
}
