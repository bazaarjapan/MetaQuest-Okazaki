import { stickAxes } from "./motion.js";

// Horizontal movement follows the centre-eye orientation, never its pitch.
// At a vertical gaze there is no horizontal forward; retain the last heading.
export function horizontalViewAxes(orientation, fallbackYaw = 0) {
  let yaw = Number.isFinite(fallbackYaw) ? fallbackYaw : 0;
  const { x, y, z, w } = orientation ?? {};
  const length = Math.hypot(x, y, z, w);
  if ([x, y, z, w].every(Number.isFinite) && length > 1e-8) {
    const qx = x / length, qy = y / length, qz = z / length, qw = w / length;
    const fx = -2 * (qx * qz + qw * qy), fz = -(1 - 2 * (qx * qx + qy * qy));
    if (Math.hypot(fx, fz) > 0.01) yaw = Math.atan2(-fx, -fz);
  }
  return { yaw, forward: [-Math.sin(yaw), 0, -Math.cos(yaw)], right: [Math.cos(yaw), 0, -Math.sin(yaw)] };
}

export function createXRFlightStart() { return { pending: false, seenPose: false }; }
export function armXRFlightStart(start) { start.pending = true; start.seenPose = false; }
export function cancelXRFlightStart(start) { start.pending = false; start.seenPose = false; }

// One default per deliberate session entry. Never re-arm after a safety stop.
// A stick held while entering VR must first return to its deadzone.
export function pollXRFlightStart(start, { allowed, ready, visible, poseReady, sources = [], trackedHands = [] }) {
  if (!start.pending) return false;
  if (!allowed || !visible) { cancelXRFlightStart(start); return false; }
  if (!ready) return false;
  if (!poseReady) {
    if (start.seenPose) cancelXRFlightStart(start);
    return false;
  }
  start.seenPose = true;
  const hands = ["left", "right"].map(hand => [...sources].find(source => source.handedness === hand && source.gamepad));
  if (hands.some(source => !source)) return false;
  if (["left", "right"].some(hand => !trackedHands.includes(hand))) {
    cancelXRFlightStart(start); return false;
  }
  if (hands.some(source => stickAxes(source.gamepad).some(axis => axis !== 0) ||
      [...(source.gamepad.buttons ?? [])].some(button => button?.pressed))) return false;
  cancelXRFlightStart(start);
  return true;
}
