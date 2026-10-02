import { createBlockAvatar } from "./block-avatar.js";
import { creativeConfig } from "./creative-controls.js";

export const presenceLimits = Object.freeze({ remoteParticipants: 30, labelWidth: 256,
  labelHeight: 64, labelCharacters: 20, teleportDistance: 25, smoothing: 12 });

// Labels use the explicitly selected avatar nickname, never Google profile
// names, pictures or email addresses. Canvas text cannot become HTML markup.
export function presenceLabel(value) {
  if (typeof value !== "string" || value.includes("@")) return "参加者";
  const text = value.replace(/[\u0000-\u001f\u007f<>]/gu, "").trim();
  return [...text].slice(0, presenceLimits.labelCharacters).join("") || "参加者";
}

export function presenceColor(value) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/iu.test(value) ? value : "#4a90e2";
}

export function eyeToFeet(position) {
  if (!Array.isArray(position) || position.length !== 3 ||
    !position.every((value) => Number.isFinite(value) && Math.abs(value) <= 1e7)) return null;
  return [position[0], position[1] - creativeConfig.eyeHeight, position[2]];
}

export function interpolateYaw(from, to, amount) {
  if (![from, to, amount].every(Number.isFinite)) return 0;
  const difference = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  const result = from + difference * Math.max(0, Math.min(1, amount));
  return Math.atan2(Math.sin(result), Math.cos(result));
}

export function remoteParticipants(state) {
  if (!state?.user?.id || !state.world?.id || state.connection !== "connected") return [];
  const found = new Set(), result = [];
  for (const value of Array.isArray(state.participants) ? state.participants : []) {
    if (result.length >= presenceLimits.remoteParticipants) break;
    if (!value || typeof value.id !== "string" || !value.id || value.id.length > 80 ||
      value.id === state.user.id || found.has(value.id) || !Number.isFinite(value.yaw)) continue;
    const feet = eyeToFeet(value.position);
    if (!feet) continue;
    found.add(value.id);
    result.push({ id: value.id, name: presenceLabel(value.name), color: presenceColor(value.color),
      role: value.role === "teacher" ? "teacher" : "student", feet, yaw: value.yaw });
  }
  return result;
}

// Thirty original nine-cube avatars; no imported character or texture assets.
// Identity changes clear the old room before any new room can be rendered.
export function createSchoolPresence(THREE, { scene, client,
  documentTarget = globalThis.document } = {}) {
  const group = new THREE.Group(); group.name = "school-presence";
  scene.add(group);
  const actors = new Map();
  let context = null, disposed = false, time = 0;

  function labelFor(actor, name) {
    if (!documentTarget?.createElement) return;
    if (!actor.label) {
      const canvas = documentTarget.createElement("canvas");
      canvas.width = presenceLimits.labelWidth; canvas.height = presenceLimits.labelHeight;
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.generateMipmaps = false; texture.minFilter = THREE.LinearFilter;
      const material = new THREE.SpriteMaterial({ map: texture, transparent: true,
        depthWrite: false, toneMapped: false });
      const sprite = new THREE.Sprite(material);
      sprite.name = "school-avatar-nickname";
      sprite.position.set(0, 2.1, 0); sprite.scale.set(1.2, 0.3, 1);
      actor.avatar.group.add(sprite);
      actor.label = { canvas, texture, material, sprite };
    }
    const c = actor.label.canvas.getContext("2d");
    if (!c) return;
    c.clearRect(0, 0, presenceLimits.labelWidth, presenceLimits.labelHeight);
    c.fillStyle = "rgba(8,20,35,.85)"; c.fillRect(0, 0, 256, 64);
    c.font = "bold 28px sans-serif"; c.fillStyle = "white";
    c.textAlign = "center"; c.textBaseline = "middle";
    c.fillText(name, 128, 32, 240); actor.label.texture.needsUpdate = true;
  }

  function remove(id) {
    const actor = actors.get(id); if (!actor) return;
    actor.label?.texture.dispose(); actor.label?.material.dispose();
    actor.avatar.dispose(); actors.delete(id);
  }

  function clear() { for (const id of [...actors.keys()]) remove(id); }

  function receive(snapshot) {
    if (disposed) return;
    const state = snapshot ?? client.getState();
    const nextContext = state?.user?.id && state.world?.id && state.connection === "connected" ?
      `${state.user.id}:${state.world.id}` : null;
    if (nextContext !== context) { clear(); context = nextContext; }
    const next = remoteParticipants(state), remaining = new Set(next.map((entry) => entry.id));
    for (const id of [...actors.keys()]) if (!remaining.has(id)) remove(id);
    for (const participant of next) {
      let actor = actors.get(participant.id);
      if (actor && actor.color !== participant.color) { remove(participant.id); actor = null; }
      if (!actor) {
        const avatar = createBlockAvatar(THREE, { color: participant.color, identity: participant.id });
        group.add(avatar.group);
        actor = { id: participant.id, avatar, color: participant.color, name: null,
          position: new THREE.Vector3(...participant.feet), target: new THREE.Vector3(...participant.feet),
          yaw: participant.yaw, targetYaw: participant.yaw, motionTime: -Infinity };
        actors.set(participant.id, actor);
      }
      const position = new THREE.Vector3(...participant.feet);
      if (actor.target.distanceToSquared(position) > 0.0001) actor.motionTime = time;
      if (actor.position.distanceTo(position) > presenceLimits.teleportDistance) {
        actor.position.copy(position); actor.yaw = participant.yaw;
      }
      actor.target.copy(position); actor.targetYaw = participant.yaw;
      if (actor.name !== participant.name) { actor.name = participant.name; labelFor(actor, participant.name); }
      actor.avatar.update({ position: actor.position, yaw: actor.yaw, time, visible: true });
    }
    group.visible = Boolean(context);
  }
  receive(client.getState());
  const unsubscribe = client.subscribe((state) => receive(state));

  return { group,
    update(dt = 0) {
      if (disposed) return;
      const delta = Number.isFinite(dt) ? Math.max(0, Math.min(0.1, dt)) : 0;
      time += delta;
      const alpha = 1 - Math.exp(-presenceLimits.smoothing * delta);
      for (const actor of actors.values()) {
        actor.position.lerp(actor.target, alpha);
        actor.yaw = interpolateYaw(actor.yaw, actor.targetYaw, alpha);
        actor.avatar.update({ position: actor.position, yaw: actor.yaw,
          moving: time - actor.motionTime < 0.3, time, visible: true });
      }
    },
    getState: () => ({ visible: group.visible, count: actors.size, disposed,
      actors: [...actors.values()].map((actor) => ({ id: actor.id, name: actor.name,
        color: actor.color, position: actor.position.toArray(), target: actor.target.toArray(),
        yaw: actor.yaw, meshes: 9, appearance: actor.avatar.getState().appearance })) }),
    dispose() {
      if (disposed) return;
      disposed = true; unsubscribe?.(); clear(); group.removeFromParent(); group.visible = false;
    } };
}
