import { avatarNickname, createAvatarLabel } from "./avatar-label.js";
import { createBlockAvatar } from "./block-avatar.js";
import { creativeConfig } from "./creative-controls.js";
import { poseSendIntervalMs } from "./school-client.js";
import { validAvatarMotion } from "./avatar-motion.js";

export const presenceLimits = Object.freeze({ remoteParticipants: 33, labelWidth: 256,
  labelHeight: 64, labelCharacters: 20, teleportDistance: 25, smoothing: 12,
  simplifyDistance: 32, restoreDetailDistance: 26 });

// Labels use the explicitly selected avatar nickname, never Google profile
// names, pictures or email addresses. Canvas text cannot become HTML markup.
export const presenceLabel = avatarNickname;

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

function remoteFeet(value, ownId) {
  if (!value || typeof value.id !== "string" || !value.id || value.id.length > 80 ||
      value.id === ownId || !Number.isFinite(value.yaw)) return null;
  return eyeToFeet(value.position);
}

function visitRoster(state, visit) {
  const found = new Set();
  if (!state?.user?.id || !state.world?.id || state.connection !== "connected") return found;
  for (const value of Array.isArray(state.participants) ? state.participants : []) {
    if (found.size >= presenceLimits.remoteParticipants) break;
    const feet = remoteFeet(value, state.user.id);
    if (!feet || found.has(value.id)) continue;
    found.add(value.id);
    visit(value, feet);
  }
  return found;
}

export function remoteParticipants(state) {
  const result = [];
  visitRoster(state, (value, feet) => {
    result.push({ id: value.id, name: presenceLabel(value.name), color: presenceColor(value.color),
      role: value.role === "teacher" ? "teacher" : "student", feet, yaw: value.yaw,
      animation: validAvatarMotion(value.animation) ? value.animation : null });
  });
  return result;
}

// Original block avatars with low-poly beetle wings; no imported textures/assets.
// Identity changes clear the old room before any new room can be rendered.
export function createSchoolPresence(THREE, { scene, client,
  documentTarget = globalThis.document } = {}) {
  const group = new THREE.Group(); group.name = "school-presence";
  scene.add(group);
  const actors = new Map();
  let context = null, disposed = false, time = 0, motionGraceSeconds = 0;

  function remove(id) {
    const actor = actors.get(id); if (!actor) return;
    actor.label?.dispose();
    actor.avatar.dispose(); actors.delete(id);
  }

  function clear() { for (const id of [...actors.keys()]) remove(id); }

  const incoming = new THREE.Vector3();
  function accept(participant, feet) {
    const color = presenceColor(participant.color);
    let actor = actors.get(participant.id);
    incoming.fromArray(feet);
    if (!actor) {
      const avatar = createBlockAvatar(THREE, { color, identity: participant.id, batchBlocks: true });
      group.add(avatar.group);
      const label = createAvatarLabel(THREE, { parent: avatar.group, documentTarget });
      actor = { id: participant.id, avatar, label, color, name: null, distant: false,
        position: incoming.clone(), target: incoming.clone(), yaw: participant.yaw,
        targetYaw: participant.yaw, motionTime: -Infinity };
      actors.set(participant.id, actor);
    } else if (actor.color !== color) {
      actor.color = color;
      actor.avatar.setColor(color);
    }
    actor.avatar.setDesign(participant.design);
    if (actor.name === null || actor.rawName !== participant.name) {
      actor.rawName = participant.name;
      actor.label.setName(participant.name);
      actor.name = actor.label.getState().name;
    }
    if (actor.target.distanceToSquared(incoming) > 0.0001) actor.motionTime = time;
    actor.animation = validAvatarMotion(participant.animation) ? participant.animation : null;
    if (actor.position.distanceToSquared(incoming) > presenceLimits.teleportDistance ** 2) {
      actor.position.copy(incoming);
      actor.yaw = participant.yaw;
    }
    actor.target.copy(incoming);
    actor.targetYaw = participant.yaw;
  }

  function receive(state, event = "state", changedId) {
    if (disposed) return;
    const nextContext = state?.user?.id && state.world?.id && state.connection === "connected" ?
      `${state.user.id}:${state.world.id}` : null;
    const contextChanged = nextContext !== context;
    if (contextChanged) { clear(); context = nextContext; }
    group.visible = Boolean(context);
    if (!context) return;
    // Sparse updates from low-FPS peers can straddle multiple display frames.
    // Explicit idle still takes effect on receipt.
    motionGraceSeconds = 3 * poseSendIntervalMs(state.participants?.length) / 1000;
    if (!contextChanged && event === "pose" && changedId) {
      if (changedId === state.user.id) return;
      const value = state.participants.find((entry) => entry?.id === changedId);
      const feet = remoteFeet(value, state.user.id);
      if (!feet) remove(changedId);
      else if (actors.has(changedId) || actors.size < presenceLimits.remoteParticipants) accept(value, feet);
      return;
    }
    if (!contextChanged && !["state", "room", "participants", "pose", "auth", "connection"].includes(event)) return;
    const remaining = visitRoster(state, accept);
    for (const id of actors.keys()) if (!remaining.has(id)) remove(id);
  }
  receive(client.getState());
  const unsubscribe = client.subscribe(receive);

  return { group,
    update(dt = 0, viewerPosition) {
      if (disposed) return;
      const delta = Number.isFinite(dt) ? Math.max(0, Math.min(0.25, dt)) : 0;
      time += delta;
      const alpha = 1 - Math.exp(-presenceLimits.smoothing * delta);
      for (const actor of actors.values()) {
        actor.position.lerp(actor.target, alpha);
        if (actor.yaw !== actor.targetYaw) actor.yaw = interpolateYaw(actor.yaw, actor.targetYaw, alpha);
        if (viewerPosition) {
          const limit = actor.distant ? presenceLimits.restoreDetailDistance : presenceLimits.simplifyDistance;
          actor.distant = actor.position.distanceToSquared(viewerPosition) > limit ** 2;
        }
        actor.avatar.update({ position: actor.position, yaw: actor.yaw,
          animation: time - actor.motionTime < motionGraceSeconds ? actor.animation ?? "walk" : "idle", time, distant: actor.distant });
      }
    },
    getState: () => ({ visible: group.visible, count: actors.size, disposed,
      actors: [...actors.values()].map((actor) => {
        const avatar = actor.avatar.getState();
        return { id: actor.id, name: actor.name, distant: actor.distant,
        color: actor.color, position: actor.position.toArray(), target: actor.target.toArray(),
        yaw: actor.yaw, animation: avatar.animation, meshes: avatar.meshCount,
        label: actor.label.getState(), appearance: avatar.appearance, design: avatar.design };
      }) }),
    dispose() {
      if (disposed) return;
      disposed = true; unsubscribe?.(); clear(); group.removeFromParent(); group.visible = false;
    } };
}
