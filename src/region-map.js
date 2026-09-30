export function mapToWorld(u, v, bounds) {
  if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite)) return null;
  return {
    x: bounds[0] + Math.max(0, Math.min(1, Number.isFinite(u) ? u : 0.5)) * (bounds[2] - bounds[0]),
    z: bounds[1] + Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0.5)) * (bounds[3] - bounds[1]),
  };
}
export function worldToMap(position, bounds) {
  const width = bounds[2] - bounds[0], height = bounds[3] - bounds[1];
  return { u: width ? (position.x - bounds[0]) / width : 0.5,
    v: height ? (position.z - bounds[1]) / height : 0.5 };
}
export function drawRegionMap(context, rect, manifest, position, coreBounds) {
  const { x, y, w, h } = rect;
  const bounds = manifest.bounds;
  const plot = (px, pz) => {
    const { u, v } = worldToMap({ x: px, z: pz }, bounds);
    return [x + u * w, y + v * h];
  };
  context.fillStyle = "#e3edf0";
  context.fillRect(x, y, w, h);
  context.fillStyle = "#8ba8b4";
  for (const tile of manifest.buildings) {
    const a = plot(tile.bounds[0], tile.bounds[1]), b = plot(tile.bounds[2], tile.bounds[3]);
    context.fillRect(a[0], a[1], Math.max(1, b[0] - a[0]), Math.max(1, b[1] - a[1]));
  }
  if (coreBounds) {
    const a = plot(coreBounds[0], coreBounds[1]), b = plot(coreBounds[2], coreBounds[3]);
    context.fillStyle = "#087f71";
    context.fillRect(a[0], a[1], Math.max(5, b[0] - a[0]), Math.max(5, b[1] - a[1]));
  }
  const p = plot(position.x, position.z);
  context.fillStyle = "#ef8f25";
  context.strokeStyle = "white";
  context.lineWidth = 2;
  context.beginPath(); context.arc(p[0], p[1], 5, 0, Math.PI * 2); context.fill(); context.stroke();
  context.textAlign = "left";
  context.fillStyle = "#173447";
  context.font = `${Math.max(12, Math.round(w * 0.032))}px sans-serif`;
  context.fillText("N ↑", x + 8, y + 19);
}
