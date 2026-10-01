// Convenience guards only: the Worker rechecks signed sessions and ownership.
export function workshopAccess(state) {
  const userId = typeof state?.user?.id === "string" ? state.user.id : null;
  const worldId = typeof state?.world?.id === "string" ? state.world.id : null;
  return { userId, worldId, canEdit: Boolean(userId && worldId && state.connection === "connected") };
}
export function canEditWorkshopObject(state, object) {
  const access = workshopAccess(state);
  return access.canEdit && Boolean(object && object.ownerId === access.userId);
}
// Disconnect/reconnect to the same IDs also invalidates pending async results.
export function createWorkshopScope() {
  let generation = 0, key = "";
  return {
    update(state) {
      const access = workshopAccess(state);
      const next = access.canEdit ? `${access.userId}\n${access.worldId}` : "";
      const changed = next !== key;
      if (changed) { key = next; generation++; }
      return { ...access, changed, generation };
    },
    capture() { return { generation, key }; },
    accepts(token) { return Boolean(key && token && token.generation === generation && token.key === key); },
  };
}
export function safeWorkshopTransform({ position, rotation, scale } = {}) {
  const vector = (value, check) => Array.isArray(value) && value.length === 3 && value.every(check);
  return vector(position, (v) => Number.isFinite(v) && Math.abs(v) <= 25000) &&
    vector(rotation, (v) => Number.isFinite(v) && Math.abs(v) <= Math.PI * 100) &&
    vector(scale, (v) => Number.isFinite(v) && v >= 1e-6 && v <= 100);
}
export function sharedObjectOverlap(bounds, object) {
  const a = bounds, b = object?.bounds;
  if (!a || !b || ![a.min, a.max, b.min, b.max].every((v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite))) return false;
  // Match the authoritative room's 5mm tolerance, including Y separation.
  return a.min.every((value, axis) => value < b.max[axis] - 0.005 && a.max[axis] > b.min[axis] + 0.005);
}
