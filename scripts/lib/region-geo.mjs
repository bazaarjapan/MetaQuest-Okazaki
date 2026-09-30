import proj4 from "proj4";

// Same JGD2011 / Japan Plane Rectangular CS VII and reference point as the
// existing PLATEAU Unity export. Verified JR station alignment < 0.001 m.
export const geographic = "+proj=longlat +ellps=GRS80 +no_defs";
export const geocentric = "+proj=geocent +ellps=GRS80 +units=m +no_defs";
export const plane = "+proj=tmerc +lat_0=36 +lon_0=137.166666666667 +k=0.9999 +ellps=GRS80 +units=m +no_defs";
const project = proj4(geographic, plane);
const ecef = proj4(geocentric, geographic);
export const origin = Object.freeze([137.15625, 34.926041667]);
const reference = project.forward([...origin]);
export function lonLatToWorld(lon, lat, altitude = 0) {
  const [east, north] = project.forward([lon, lat]);
  return [east - reference[0], altitude, reference[1] - north];
}
export function worldToLonLat(x, z) {
  return project.inverse([x + reference[0], reference[1] - z]);
}
export function ecefToWorld(x, y, z) {
  const [lon, lat, altitude] = ecef.forward([x, y, z]);
  return lonLatToWorld(lon, lat, altitude);
}
export function tileToLonLat(x, y, zoom) {
  const n = 2 ** zoom;
  return [x / n * 360 - 180,
    Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI];
}
export function lonLatToTile(lon, lat, zoom) {
  const n = 2 ** zoom, rad = lat * Math.PI / 180;
  return [(lon + 180) / 360 * n,
    (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * n];
}
// These six quarter meshes form the exact rectangle selected in the original
// Unity import. Wide LOD1 building centroids in it are omitted to avoid overlap.
export const coreGeographicBounds = Object.freeze([137.153125, 34.92291666666667, 137.159375, 34.92916666666667]);
export function withinCore(x, z) {
  const [lon, lat] = worldToLonLat(x, z), b = coreGeographicBounds;
  return lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3];
}
