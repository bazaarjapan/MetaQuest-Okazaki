import { test } from "node:test";
import assert from "node:assert/strict";
import {
  viewpoints,
  deadzone,
  clampPosition,
  stickAxes,
  flightConfig,
  createFlightState,
  resetFlight,
  updateFlight,
} from "../src/motion.js";
test("three teaching viewpoints include JR Okazaki station", () => {
  assert.deepEqual(Object.keys(viewpoints), ["overview", "east", "west"]);
  for (const v of Object.values(viewpoints)) {
    assert.equal(v.position.length, 3);
    assert.ok(v.position.every(Number.isFinite));
    assert.ok(v.question.length > 5);
  }
});
test("deadzone rejects drift, preserves signs and full travel", () => {
  assert.equal(deadzone(0.1), 0);
  assert.equal(deadzone(-0.1), 0);
  assert.equal(deadzone(1), 1);
  assert.equal(deadzone(-1), -1);
});
test("Quest thumbstick uses standard WebXR indices 2 and 3", () => {
  assert.deepEqual(stickAxes({ axes: [0, 0, 1, -1] }), [1, -1]);
  assert.deepEqual(stickAxes(null), [0, 0]);
});
test("free flight stays in supported local viewing area", () => {
  assert.deepEqual(clampPosition({ x: 999, y: -10, z: -999 }), {
    x: 265,
    y: 20,
    z: -325,
  });
});

function hold(state, input, seconds, dt = 0.02) {
  let result;
  for (let i = 0; i < Math.round(seconds / dt); i += 1) {
    result = updateFlight(state, input, dt);
  }
  return result;
}

function close(actual, expected, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}

test("Mode 2 maps right stick to forward/strafe and left stick to rise/yaw", () => {
  const result = updateFlight(
    createFlightState(),
    { left: [1, -1], right: [1, -1] },
    0.02,
  );
  close(result.strafe, 12 / Math.SQRT2);
  close(result.forward, 12 / Math.SQRT2);
  assert.equal(result.rise, 6);
  assert.equal(result.yaw, -Math.PI / 6);
  const reverse = updateFlight(
    createFlightState(),
    { left: [-1, 1], right: [-1, 1] },
    0.02,
  );
  close(reverse.strafe, -12 / Math.SQRT2);
  close(reverse.forward, -12 / Math.SQRT2);
  assert.equal(reverse.rise, -6);
  assert.equal(reverse.yaw, Math.PI / 6);
});

test("stick deflection alone determines speed and holding never accelerates", () => {
  const state = createFlightState();
  const input = { left: [0, -0.5], right: [0, -0.5] };
  const initial = updateFlight(state, input, 0.02);
  assert.equal(initial.horizontalSpeed, 6);
  assert.equal(initial.verticalSpeed, 3);
  assert.deepEqual(hold(state, input, 0.6), initial);
  assert.deepEqual(hold(state, input, 5), initial);
  assert.deepEqual(hold(state, input, 30), initial);
  const full = updateFlight(state, { left: [0, -1], right: [0, -1] }, 0.02);
  assert.equal(full.horizontalSpeed, flightConfig.horizontalMaxSpeed);
  assert.equal(full.verticalSpeed, flightConfig.verticalMaxSpeed);
  const halfAgain = updateFlight(state, input, 0.02);
  assert.deepEqual(halfAgain, initial);
});

test("release immediately stops movement and restarting has no hold history", () => {
  const state = createFlightState();
  hold(state, { left: [1, -1], right: [0, -1] }, 6);
  assert.deepEqual(updateFlight(state, { left: [0, 0], right: [0, 0] }, 0.02), {
    strafe: 0,
    forward: 0,
    rise: 0,
    yaw: 0,
    horizontalSpeed: 0,
    verticalSpeed: 0,
  });
  assert.deepEqual(state, { horizontalSpeed: 0, verticalSpeed: 0 });
  const restart = updateFlight(state, { left: [0, -1], right: [0, -1] }, 0.02);
  assert.equal(restart.forward, 12);
  assert.equal(restart.rise, 6);
});

test("reversing direction immediately reverses velocity with no carried momentum", () => {
  const state = createFlightState();
  hold(state, { left: [0, -1], right: [0, -1] }, 6);
  const reversed = updateFlight(state, { left: [0, 1], right: [0, 1] }, 0.02);
  assert.equal(reversed.forward, -12);
  assert.equal(reversed.rise, -6);
  assert.deepEqual(state, { horizontalSpeed: 12, verticalSpeed: 6 });
});

test("horizontal direction changes affect direction, not speed at equal magnitude", () => {
  const state = createFlightState();
  hold(state, { right: [0, -1] }, 6);
  const sixtyDegrees = updateFlight(state, { right: [Math.sqrt(3) / 2, -0.5] }, 0.02);
  close(sixtyDegrees.horizontalSpeed, 12);
  close(sixtyDegrees.strafe, Math.sqrt(3) * 6);
  close(sixtyDegrees.forward, 6);
  hold(state, { right: [0, -1] }, 1);
  const ninetyDegrees = updateFlight(state, { right: [1, 0] }, 0.02);
  assert.equal(ninetyDegrees.horizontalSpeed, 12);
  assert.equal(ninetyDegrees.strafe, 12);
  assert.equal(ninetyDegrees.forward, 0);
});

test("horizontal and vertical stick deflections determine speeds independently", () => {
  const state = createFlightState();
  const horizontalOnly = updateFlight(state, { right: [0, -0.75] }, 0.02);
  assert.equal(horizontalOnly.horizontalSpeed, 9);
  assert.equal(horizontalOnly.verticalSpeed, 0);
  const together = updateFlight(state, { left: [0, -0.25], right: [0, -0.75] }, 0.02);
  assert.equal(together.horizontalSpeed, 9);
  assert.equal(together.verticalSpeed, 1.5);
  const verticalOnly = updateFlight(state, { left: [0, -0.25] }, 0.02);
  assert.equal(verticalOnly.horizontalSpeed, 0);
  assert.equal(verticalOnly.verticalSpeed, 1.5);
});

test("small analog input gives proportionally slow movement without accumulating speed", () => {
  const state = createFlightState();
  const precision = hold(state, { left: [0.2, -0.2], right: [0.2, 0] }, 10);
  close(precision.strafe, 2.4);
  close(precision.rise, 1.2);
  close(precision.yaw, -0.2 * flightConfig.yawSpeed);
  close(state.horizontalSpeed, 2.4);
  close(state.verticalSpeed, 1.2);
  hold(state, { left: [0, -1], right: [1, 0] }, 6);
  const slower = updateFlight(state, { left: [0, -0.2], right: [0.2, 0] }, 0.02);
  close(slower.strafe, 2.4);
  close(slower.rise, 1.2);
  assert.deepEqual(slower, { ...precision, yaw: 0 });
});

test("horizontal diagonal speed cannot exceed configured maximum", () => {
  const result = hold(createFlightState(), { right: [1, -1] }, 6);
  close(Math.hypot(result.strafe, result.forward), 12);
  const precision = updateFlight(createFlightState(), { right: [0.2, -0.2] }, 0.02);
  close(precision.strafe, 2.4);
  close(precision.forward, 2.4);
});

test("yaw is continuous and fixed-rate even after a prolonged hold", () => {
  const state = createFlightState();
  const result = hold(state, { left: [1, 0] }, 10);
  assert.equal(result.yaw, -flightConfig.yawSpeed);
  assert.deepEqual(state, { horizontalSpeed: 0, verticalSpeed: 0 });
  const half = updateFlight(state, { left: [0.5, 0] }, 0.02);
  assert.equal(half.yaw, -flightConfig.yawSpeed / 2);
});

test("lost controllers and stick drift immediately stop all movement", () => {
  const state = createFlightState();
  hold(state, { left: [0, -1], right: [0, -1] }, 6);
  const drift = updateFlight(
    state,
    { left: stickAxes({ axes: [0, 0, 0.1, -0.1] }), right: stickAxes(null) },
    0.02,
  );
  assert.equal(drift.forward, 0);
  assert.equal(drift.rise, 0);
  assert.equal(drift.yaw, 0);
  assert.deepEqual(state, { horizontalSpeed: 0, verticalSpeed: 0 });
  hold(state, { left: [0, -1], right: [0, -1] }, 6);
  const disconnected = updateFlight(state, undefined, 0.02);
  assert.equal(disconnected.forward, 0);
  assert.equal(disconnected.rise, 0);
  assert.deepEqual(state, { horizontalSpeed: 0, verticalSpeed: 0 });
});

test("invalid axes cannot produce nonfinite or above-range velocities", () => {
  assert.deepEqual(stickAxes({ axes: [0, 0, NaN, Infinity] }), [0, 0]);
  assert.deepEqual(stickAxes({ axes: [0, 0, 3, -3] }), [1, -1]);
  const result = updateFlight(
    createFlightState(),
    { left: [NaN, Infinity], right: [-Infinity, undefined] },
    0.02,
  );
  assert.ok(Object.values(result).every(Number.isFinite));
  assert.equal(result.strafe, 0);
  assert.equal(result.forward, 0);
  assert.equal(result.rise, 0);
  assert.equal(result.yaw, 0);
});

test("velocity is independent of timestep and diagnostic speed is resettable", () => {
  const a = createFlightState();
  const b = createFlightState();
  const input = { left: [0, -1], right: [0, -1] };
  const fine = hold(a, input, 2.5, 0.01);
  const coarse = hold(b, input, 2.5, 0.05);
  close(fine.horizontalSpeed, coarse.horizontalSpeed);
  close(fine.verticalSpeed, coarse.verticalSpeed);
  assert.deepEqual(a, b);
  assert.deepEqual(updateFlight(a, input, 20), fine);
  assert.deepEqual(updateFlight(a, input, NaN), fine);
  assert.deepEqual(updateFlight(a, input, -1), fine);
  assert.deepEqual(updateFlight(a, input, 0), fine);
  assert.equal(resetFlight(a), a);
  assert.deepEqual(a, createFlightState());
});
