// Classify joined surveyed walls and find a rectangle fully inside each wall.
// Layout uses the face plane, so the same design works on diagonal streets.
const centimetres = x => Math.round(x * 100);
const edgeKey = (a, b) => a < b ? `${a}:${b}` : `${b}:${a}`;
function root(wall) {
  while (wall.parent) { if (wall.parent.parent) wall.parent = wall.parent.parent; wall = wall.parent; }
  return wall;
}

function crossesInterior(a, b, low, high) {
  let first = 0, last = 1;
  for (let axis = 0; axis < 2; axis++) {
    const delta = b[axis] - a[axis];
    if (Math.abs(delta) < .00001) {
      if (a[axis] <= low[axis] || a[axis] >= high[axis]) return false;
    } else {
      const from = (low[axis] - a[axis]) / delta, to = (high[axis] - a[axis]) / delta;
      first = Math.max(first, Math.min(from, to)); last = Math.min(last, Math.max(from, to));
    }
  }
  return last - first > .00001;
}

export function facadeFamily({ height, area, aspect, seed }) {
  if (height >= 24 || (height >= 14 && area >= 345 && aspect < 2.3)) return 4;
  if (height >= 9 && (height >= 12 || aspect > 1.6 || area > 190)) return 3;
  if (height < 3.6 || area < 42 || (height < 7 && area >= 280)) return 5;
  if (area >= 105 && (height >= 7.5 || seed % 5 === 0)) return 2;
  return 1;
}

export function measureFacades(positions, indices, components, welded, centers) {
  const faces = new Array((indices?.length ?? positions.length / 3) / 3);
  const neighbors = new Map();
  for (let t = 0; t < faces.length; t++) {
    const ids = [0, 1, 2].map(i => indices ? indices[t * 3 + i] : t * 3 + i);
    const [a, b, c] = ids.map(i => i * 3);
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const horizontal = Math.hypot(nx, nz);
    if (horizontal < .004 || Math.abs(ny) > .18 * horizontal) continue;
    const face = { ids, component: components[ids[0]], axis: [-nz / horizontal, nx / horizontal], group: null };
    faces[t] = face;
    for (let i = 0; i < 3; i++) {
      const key = edgeKey(welded[ids[i]], welded[ids[(i + 1) % 3]]);
      const previous = neighbors.get(key);
      if (!previous) neighbors.set(key, face);
      else if (face.axis[0] * previous.axis[0] + face.axis[1] * previous.axis[1] > .9992) {
        const currentRoot = root(face), previousRoot = root(previous);
        if (currentRoot !== previousRoot) currentRoot.parent = previousRoot;
      }
    }
  }

  const groups = new Map();
  for (const face of faces) {
    if (!face) continue;
    const owner = root(face);
    if (!groups.has(owner)) groups.set(owner, { axis: owner.axis, component: owner.component, edges: new Map(), columns: new Map(), type: 0 });
    const group = face.group = groups.get(owner);
    for (let i = 0; i < 3; i++) {
      const p = face.ids[i], q = face.ids[(i + 1) % 3], j = p * 3;
      const along = positions[j] * group.axis[0] + positions[j + 2] * group.axis[1], y = positions[j + 1];
      const key = centimetres(along), column = group.columns.get(key) ?? [along, Infinity, -Infinity];
      column[1] = Math.min(column[1], y); column[2] = Math.max(column[2], y); group.columns.set(key, column);
      const edge = edgeKey(welded[p], welded[q]);
      if (group.edges.has(edge)) group.edges.delete(edge);
      else group.edges.set(edge, [p, q]);
    }
  }

  const fronts = new Map();
  const project = (i, axis) => [positions[i * 3] * axis[0] + positions[i * 3 + 2] * axis[1], positions[i * 3 + 1]];
  for (const group of groups.values()) {
    let left = Infinity, right = -Infinity, bottom = -Infinity, top = Infinity;
    for (const [along, floor, cap] of group.columns.values()) if (cap - floor > .55) {
      left = Math.min(left, along); right = Math.max(right, along);
      bottom = Math.max(bottom, floor); top = Math.min(top, cap);
    }
    const width = right - left;
    if (width < 1.25 || top - bottom < 2.1) continue;
    const low = [left + .28, bottom + .12], high = [right - .28, top - .27];
    // A wall with a cutout, stair-step or unmatched edge uses plain siding.
    // Internal triangle diagonals cancel above and never clip a window.
    if ([...group.edges.values()].some(([a, b]) => crossesInterior(project(a, group.axis), project(b, group.axis), low, high))) continue;
    group.left = left; group.width = width; group.top = top; group.base = bottom;
    const building = centers.get(group.component);
    const dx = building[6] - building[5], dz = building[8] - building[7];
    const area = dx * dz, seed = building[9];
    group.type = facadeFamily({ height: building[4] - building[3], area,
      aspect: Math.max(dx, dz) / Math.max(.01, Math.min(dx, dz)), seed }) * 2;
    const score = width * Math.min(1, (top - bottom) / 2.8);
    const front = fronts.get(group.component);
    if (!front || score > front.score) fronts.set(group.component, { group, score });
  }
  for (const { group } of fronts.values()) group.type++;
  return faces.map(face => face?.group.type ? face.group : null);
}
