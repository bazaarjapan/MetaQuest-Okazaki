// Shared browser/Worker STL parsing. STL has no unit or up-axis metadata:
// parsing preserves coordinates; callers must explicitly normalize and scale.
export const STL_LIMITS = Object.freeze({ maxBytes: 6 * 1024 * 1024, maxTriangles: 20000, maxCoordinate: 1e9 });
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

function positionsBounds(positions) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i++) {
    const value = positions[i], axis = i % 3;
    if (!Number.isFinite(value) || Math.abs(value) > STL_LIMITS.maxCoordinate) throw new Error("STL coordinates are not finite or are too large");
    min[axis] = Math.min(min[axis], value); max[axis] = Math.max(max[axis], value);
  }
  return { min, max };
}

function validateTriangles(positions) {
  if (!positions.length || positions.length % 9 || positions.length / 9 > STL_LIMITS.maxTriangles) throw new Error("STL must contain 1 to 20000 triangles");
  const bounds = positionsBounds(positions);
  for (let i = 0; i < positions.length; i += 9) {
    const ax = positions[i + 3] - positions[i], ay = positions[i + 4] - positions[i + 1], az = positions[i + 5] - positions[i + 2];
    const bx = positions[i + 6] - positions[i], by = positions[i + 7] - positions[i + 1], bz = positions[i + 8] - positions[i + 2];
    const cross = [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
    if (!cross.every(Number.isFinite) || !cross.some((value) => value !== 0)) throw new Error("STL contains a degenerate triangle");
  }
  return bounds;
}

function readNumber(token) {
  if (!NUMBER.test(token ?? "")) throw new Error("STL contains an invalid number");
  const value = Number(token);
  if (!Number.isFinite(value) || Math.abs(value) > STL_LIMITS.maxCoordinate) throw new Error("STL contains an invalid number");
  return value;
}

// A single forward scan, not split/map/filter: a 6 MiB newline-only upload
// must not allocate millions of empty strings before the facet cap is checked.
function* meaningfulLines(text) {
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i !== text.length && text.charCodeAt(i) !== 10 && text.charCodeAt(i) !== 13) continue;
    if (i - start > 1024) throw new Error("STL ASCII line is too long");
    const line = text.slice(start, i).trim(); start = i + 1;
    if (line) yield line;
  }
}

/** Parse strict ASCII or exact-length binary STL, including binary 'solid' headers. */
export function parseSTL(input) {
  const bytes = input instanceof Uint8Array ? input : input instanceof ArrayBuffer ? new Uint8Array(input) : null;
  if (!bytes || !bytes.byteLength || bytes.byteLength > STL_LIMITS.maxBytes) throw new Error("STL must be a nonempty file of at most 6 MiB");
  let positions;
  if (bytes.byteLength >= 84) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const triangles = view.getUint32(80, true);
    if (84 + triangles * 50 === bytes.byteLength) {
      if (!triangles || triangles > STL_LIMITS.maxTriangles) throw new Error("STL must contain 1 to 20000 triangles");
      positions = new Float32Array(triangles * 9);
      for (let triangle = 0; triangle < triangles; triangle++) {
        const offset = 84 + triangle * 50;
        for (let j = 0; j < 3; j++) {
          const normal = view.getFloat32(offset + j * 4, true);
          if (!Number.isFinite(normal) || Math.abs(normal) > STL_LIMITS.maxCoordinate) throw new Error("STL contains an invalid normal");
        }
        for (let j = 0; j < 9; j++) positions[triangle * 9 + j] = view.getFloat32(offset + 12 + j * 4, true);
      }
    }
  }
  if (!positions) {
    // The ASCII grammar is deliberately bounded and rejects trailing payloads,
    // malformed facets, control bytes, arbitrary tokens and nonfinite numbers.
    if (bytes.some((value) => value > 126 || value < 32 && ![9, 10, 13].includes(value))) throw new Error("STL is neither valid ASCII nor exact-length binary");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const lines = meaningfulLines(text), nextLine = () => lines.next().value;
    const first = /^solid(?:[ \t]+(.*))?$/i.exec(nextLine() ?? "");
    if (!first) throw new Error("STL must start with a solid marker");
    const values = [];
    for (;;) {
      const line = nextLine();
      const last = /^endsolid(?:[ \t]+(.*))?$/i.exec(line ?? "");
      if (last) {
        if ((first[1] ?? "") !== (last[1] ?? "") || nextLine() !== undefined) throw new Error("STL must have matching solid and endsolid markers without trailing payload");
        break;
      }
      if (line === undefined) throw new Error("STL endsolid marker is missing");
      if (values.length / 9 >= STL_LIMITS.maxTriangles) throw new Error("STL has too many triangles");
      const normal = /^facet[ \t]+normal[ \t]+(\S+)[ \t]+(\S+)[ \t]+(\S+)$/i.exec(line);
      if (!normal) throw new Error("STL facet normal is malformed");
      normal.slice(1).forEach(readNumber);
      if (!/^outer[ \t]+loop$/i.test(nextLine() ?? "")) throw new Error("STL outer loop is malformed");
      for (let vertex = 0; vertex < 3; vertex++) {
        const match = /^vertex[ \t]+(\S+)[ \t]+(\S+)[ \t]+(\S+)$/i.exec(nextLine() ?? "");
        if (!match) throw new Error("STL must have exactly three vertices per facet");
        values.push(...match.slice(1).map(readNumber));
      }
      if (!/^endloop$/i.test(nextLine() ?? "") || !/^endfacet$/i.test(nextLine() ?? "")) throw new Error("STL facet end is malformed");
    }
    positions = new Float32Array(values);
  }
  return { positions, triangles: positions.length / 9, bounds: validateTriangles(positions) };
}

/** Explicit CAD axis conversion, then XZ-center/Y-bottom normalization. No unit conversion. */
export function normalizeSTLPositions(source, up = "z") {
  if (!(source instanceof Float32Array) || !["z", "y"].includes(up)) throw new Error("Invalid STL positions or up axis");
  validateTriangles(source);
  const positions = new Float32Array(source.length);
  for (let i = 0; i < source.length; i += 3) {
    positions[i] = source[i];
    positions[i + 1] = up === "z" ? source[i + 2] : source[i + 1];
    positions[i + 2] = up === "z" ? -source[i + 1] : source[i + 2];
  }
  const bounds = positionsBounds(positions);
  const offset = [(bounds.min[0] + bounds.max[0]) / 2, bounds.min[1], (bounds.min[2] + bounds.max[2]) / 2];
  for (let i = 0; i < positions.length; i++) positions[i] -= offset[i % 3];
  return { positions, bounds: validateTriangles(positions) };
}
