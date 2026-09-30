export const viewpoints = {
  overview: {
    title: "駅と街を見渡す",
    description: "上空から、線路と道路のつながりを観察",
    position: [350, 340, 440],
    target: [20, 20, 0],
    question: "線路は街をどのように分けている？",
    detail: "線路を越えて東西を行き来できる場所を探してみよう。",
  },
  east: {
    title: "駅の東側から見る",
    description: "駅前の道路と建物の集まりを観察",
    position: [195, 76, 105],
    target: [95.92456, 20, 49.00273],
    question: "駅の近くには、どんな建物が集まっている？",
    detail:
      "建物の高さや大きさ、道路との位置関係に注目してみよう。用途は形だけで決めつけず、地図と比べよう。",
  },
  west: {
    title: "駅の西側から見る",
    description: "東側と見比べて、街の違いを探す",
    position: [-70, 76, 10],
    target: [95.92456, 20, 49.00273],
    question: "東側と西側で、街のつくりはどう違う？",
    detail:
      "道路の向きや建物の密度を比べよう。違いが生まれた理由も考えてみよう。",
  },
};
export function deadzone(value, threshold = 0.18) {
  const axis = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
  return Math.abs(axis) < threshold
    ? 0
    : (Math.sign(axis) * (Math.abs(axis) - threshold)) / (1 - threshold);
}
export function clampPosition(p) {
  p.x = Math.max(-265, Math.min(265, p.x));
  p.z = Math.max(-325, Math.min(325, p.z));
  p.y = Math.max(20, Math.min(300, p.y));
  return p;
}
export function stickAxes(gamepad) {
  const a = gamepad?.axes ?? [];
  return [
    deadzone(a.length >= 4 ? a[2] : (a[0] ?? 0)),
    deadzone(a.length >= 4 ? a[3] : (a[1] ?? 0)),
  ];
}

export const flightConfig = Object.freeze({
  horizontalMaxSpeed: 12,
  verticalMaxSpeed: 6,
  yawSpeed: Math.PI / 6,
});

export function createFlightState() {
  return resetFlight({});
}

export function resetFlight(state) {
  state.horizontalSpeed = 0;
  state.verticalSpeed = 0;
  return state;
}

function safeAxis(value) {
  return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
}

// Inputs are the already-deadzoned values returned by stickAxes(). Outputs are
// local linear velocities (m/s) and yaw angular velocity (rad/s), not distances.
// Speed depends only on current deflection, never on the duration of a hold.
export function updateFlight(state, input = {}, _dt = 0) {
  const leftX = safeAxis(input?.left?.[0]);
  const leftY = safeAxis(input?.left?.[1]);
  const rightX = safeAxis(input?.right?.[0]);
  const rightY = safeAxis(input?.right?.[1]);
  const horizontalLength = Math.hypot(rightX, rightY);
  const horizontalMagnitude = Math.min(1, horizontalLength);
  const horizontalDirection = horizontalLength
    ? [rightX / horizontalLength, rightY / horizontalLength]
    : null;

  state.horizontalSpeed = horizontalMagnitude * flightConfig.horizontalMaxSpeed;
  state.verticalSpeed = Math.abs(leftY) * flightConfig.verticalMaxSpeed;

  return {
    strafe: horizontalDirection
      ? horizontalDirection[0] * state.horizontalSpeed
      : 0,
    forward: rightY
      ? -horizontalDirection[1] * state.horizontalSpeed
      : 0,
    rise: leftY ? -leftY * flightConfig.verticalMaxSpeed : 0,
    yaw: leftX ? -leftX * flightConfig.yawSpeed : 0,
    horizontalSpeed: state.horizontalSpeed,
    verticalSpeed: state.verticalSpeed,
  };
}
