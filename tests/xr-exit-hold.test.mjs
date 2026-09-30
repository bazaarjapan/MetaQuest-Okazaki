import { test } from "node:test";
import assert from "node:assert/strict";
import {
  exitHoldDurationMs,
  createExitHold,
  updateExitHold,
  cancelExitHold,
} from "../src/xr-exit-hold.js";

const inactive = { toggleGuide: false, exit: false, progress: 0, holding: false };

function sample(state, pressed, now, available = true) {
  return updateExitHold(state, { pressed, available, now });
}

function ready() {
  const state = createExitHold();
  assert.deepEqual(sample(state, false, 0), inactive);
  assert.equal(state.armed, true);
  return state;
}

test("initially held X is ignored until a valid release arms a fresh press", () => {
  const state = createExitHold();
  assert.equal(state.durationMs, 1500);
  assert.equal(exitHoldDurationMs, 1500);
  assert.equal(state.armed, false);
  assert.deepEqual(sample(state, true, 0), inactive);
  assert.deepEqual(sample(state, true, 5000), inactive);
  assert.deepEqual(sample(state, false, 5001), inactive);
  assert.equal(state.armed, true);
  assert.equal(sample(state, true, 5010).holding, true);
  assert.equal(sample(state, false, 5100).toggleGuide, true);
});

test("short press toggles the guide only on release and only once", () => {
  const state = ready();
  assert.deepEqual(sample(state, true, 100), { ...inactive, holding: true });
  assert.deepEqual(sample(state, true, 400), {
    ...inactive,
    progress: 0.2,
    holding: true,
  });
  assert.deepEqual(sample(state, false, 500), { ...inactive, toggleGuide: true });
  assert.deepEqual(sample(state, false, 600), inactive);
  assert.deepEqual(sample(state, false, 700), inactive);
});

test("continuous 1500 ms hold exits once and clamps progress to one", () => {
  const state = ready();
  sample(state, true, 100);
  const halfway = sample(state, true, 850);
  assert.equal(halfway.progress, 0.5);
  assert.equal(halfway.exit, false);
  const nearly = sample(state, true, 1599);
  assert.equal(nearly.exit, false);
  assert.ok(nearly.progress < 1);
  assert.deepEqual(sample(state, true, 1600), {
    ...inactive,
    exit: true,
    progress: 1,
    holding: true,
  });
  assert.deepEqual(sample(state, true, 1600), {
    ...inactive,
    progress: 1,
    holding: true,
  });
  assert.deepEqual(sample(state, true, 30000), {
    ...inactive,
    progress: 1,
    holding: true,
  });
  assert.deepEqual(sample(state, false, 30001), inactive);
  assert.equal(state.progress, 0);
});

test("long release cannot fire a short action even with no threshold-time sample", () => {
  const state = ready();
  sample(state, true, 100);
  assert.deepEqual(sample(state, false, 1600), { ...inactive, exit: true });
  assert.deepEqual(sample(state, false, 1700), inactive);
});

test("release just below threshold toggles, not exits", () => {
  const state = ready();
  sample(state, true, 100);
  assert.deepEqual(sample(state, false, 1599), { ...inactive, toggleGuide: true });
});

test("new short or long actions can begin after a completed hold is released", () => {
  const state = ready();
  sample(state, true, 100);
  assert.equal(sample(state, true, 1600).exit, true);
  sample(state, false, 1700);
  sample(state, true, 1800);
  assert.equal(sample(state, false, 1850).toggleGuide, true);
  sample(state, true, 2000);
  assert.equal(sample(state, true, 3500).exit, true);
});

test("explicit cancellation suppresses release action and requires release to rearm", () => {
  const state = ready();
  sample(state, true, 100);
  sample(state, true, 1000);
  assert.equal(cancelExitHold(state), state);
  assert.equal(state.armed, false);
  assert.equal(state.progress, 0);
  assert.deepEqual(sample(state, true, 5000), inactive);
  assert.deepEqual(sample(state, true, 10000), inactive);
  assert.deepEqual(sample(state, false, 10001), inactive);
  sample(state, true, 10010);
  assert.equal(sample(state, false, 10020).toggleGuide, true);
});

test("lost input cancels progress and held X through reconnection cannot exit", () => {
  const state = ready();
  sample(state, true, 100);
  assert.ok(sample(state, true, 1000).progress > 0);
  assert.deepEqual(sample(state, true, 1100, false), inactive);
  assert.deepEqual(sample(state, true, 10000), inactive);
  assert.deepEqual(sample(state, false, 10001), inactive);
  sample(state, true, 10010);
  assert.equal(sample(state, true, 11510).exit, true);
});

test("releasing while unavailable cannot arm or toggle until input is valid", () => {
  const state = ready();
  sample(state, true, 100);
  assert.deepEqual(sample(state, false, 150, false), inactive);
  assert.equal(state.armed, false);
  assert.deepEqual(sample(state, true, 2000), inactive);
  assert.deepEqual(sample(state, false, 2100), inactive);
  assert.equal(state.armed, true);
});

test("nonfinite and missing timestamps cancel safely without accidental actions", () => {
  for (const now of [NaN, Infinity, -Infinity, undefined]) {
    const state = ready();
    sample(state, true, 100);
    assert.deepEqual(sample(state, true, now), inactive);
    assert.equal(state.armed, false);
    assert.deepEqual(sample(state, true, 10000), inactive);
    assert.deepEqual(sample(state, false, 10001), inactive);
    sample(state, true, 10010);
    assert.equal(sample(state, false, 10020).toggleGuide, true);
  }
});

test("time moving backwards cancels and never creates negative progress", () => {
  const state = ready();
  sample(state, true, 100);
  sample(state, true, 900);
  assert.deepEqual(sample(state, true, 800), inactive);
  assert.deepEqual(sample(state, true, 5000), inactive);
  assert.deepEqual(sample(state, false, 5001), inactive);
});

test("same timestamp samples do not manufacture elapsed hold time", () => {
  const state = ready();
  sample(state, true, 100);
  for (let i = 0; i < 100; i += 1) {
    assert.deepEqual(sample(state, true, 100), { ...inactive, holding: true });
  }
  assert.equal(sample(state, false, 100).toggleGuide, true);
});

test("malformed or missing button input is treated as lost input, not release", () => {
  for (const pressed of [undefined, null, 0, 1, "false", "true"]) {
    const state = ready();
    sample(state, true, 100);
    assert.deepEqual(updateExitHold(state, { pressed, now: 200 }), inactive);
    assert.equal(state.armed, false);
    assert.deepEqual(sample(state, false, 300), inactive);
  }
  const state = ready();
  sample(state, true, 100);
  assert.deepEqual(updateExitHold(state), inactive);
});
