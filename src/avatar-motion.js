// Small, validated wire vocabulary; never executable animation data.
export const avatarMotions = Object.freeze(["idle", "walk", "run", "glide", "boost"]);
export const validAvatarMotion = value => avatarMotions.includes(value);
export const wingConfig = Object.freeze({ launchSpeed: 20, glideSpeed: 12,
  boostSpeed: 80, response: 2.8, sink: 2, lift: 6 });
// Analytic speed response gives the same travel at 30/60/90 Hz.
export function wingTravel(speed, boosting, dt) {
  const delta = Number.isFinite(dt) ? Math.max(0, Math.min(.1, dt)) : 0;
  const initial = Number.isFinite(speed) ? Math.max(0, Math.min(wingConfig.boostSpeed, speed)) : wingConfig.launchSpeed;
  const target = boosting ? wingConfig.boostSpeed : wingConfig.glideSpeed;
  const decay = Math.exp(-wingConfig.response * delta);
  return { speed: target + (initial - target) * decay,
    distance: target * delta + (initial - target) * (1 - decay) / wingConfig.response };
}
