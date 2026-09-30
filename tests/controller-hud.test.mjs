import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeControllerInput, hudLayout, createControllerHud } from "../src/controller-hud.js";

function source(axes = [], buttons = [], extras = {}) {
  return { handedness: "left", gamepad: { axes, buttons, ...extras } };
}

test("HUD uses Quest xr-standard thumbstick axes 2 and 3", () => {
  const result = normalizeControllerInput(source([0.9, -0.9, 0.59, -1]));
  assert.equal(result.connected, true);
  assert.deepEqual(result.rawAxes, [0.59, -1]);
  assert.ok(Math.abs(result.normalizedStick[0] - 0.5) < 1e-9);
  assert.equal(result.normalizedStick[1], -1);
  assert.equal(result.stickPercent, 100);
});

test("HUD supports two-axis gamepads and reports partial physical deflection", () => {
  const result = normalizeControllerInput(source([0, -0.5]));
  assert.deepEqual(result.rawAxes, [0, -0.5]);
  assert.equal(result.stickPercent, 50);
  assert.ok(Math.abs(result.normalizedStick[1] + (0.5 - 0.18) / 0.82) < 1e-9);
});

test("HUD shows small raw drift but matches movement deadzone", () => {
  const result = normalizeControllerInput(source([0, 0, 0.05, -0.1]));
  assert.deepEqual(result.rawAxes, [0.05, -0.1]);
  assert.deepEqual(result.normalizedStick, [0, 0]);
  assert.equal(result.stickPercent, 11);
});

test("HUD sanitizes invalid and out-of-range axes", () => {
  assert.deepEqual(normalizeControllerInput(source([NaN, Infinity])).rawAxes, [0, 0]);
  assert.deepEqual(normalizeControllerInput(source([-9, 9])).rawAxes, [-1, 1]);
  assert.deepEqual(normalizeControllerInput(source([0, 0, undefined, -Infinity])).normalizedStick, [0, 0]);
});

test("missing XR input sources always have neutral fresh state", () => {
  for (const input of [null, undefined, {}, { gamepad: null }]) {
    const result = normalizeControllerInput(input);
    assert.equal(result.connected, false);
    assert.deepEqual(result.rawAxes, [0, 0]);
    assert.deepEqual(result.normalizedStick, [0, 0]);
    assert.equal(result.pressedButtonBits, 0);
    assert.equal(result.touchedButtonBits, 0);
    assert.equal(result.stickPercent, 0);
    assert.ok(result.buttons.every((button) => button.value === 0 && !button.pressed && !button.touched));
  }
});

test("active XR input source presence wins over an inconsistent emulator connected flag", () => {
  const result = normalizeControllerInput(source([0, -0.59], [], { connected: false }));
  assert.equal(result.connected, true);
  assert.deepEqual(result.rawAxes, [0, -0.59]);
  assert.equal(result.stickPercent, 59);
});

test("trigger and grip preserve partial values, touched state and button bit indices", () => {
  const result = normalizeControllerInput(source([0, 0], [
    { value: 0.27, touched: true },
    { value: 0.83, pressed: true },
    {},
    { pressed: true },
    { value: 1, pressed: true },
    { value: 0, touched: true },
  ]));
  assert.equal(result.buttons[0].value, 0.27);
  assert.equal(result.buttons[1].value, 0.83);
  assert.equal(result.buttons[3].value, 1);
  assert.equal(result.pressedButtonBits, (1 << 1) | (1 << 3) | (1 << 4));
  assert.equal(result.touchedButtonBits, (1 << 0) | (1 << 1) | (1 << 3) | (1 << 4) | (1 << 5));
});

test("invalid button progress is finite and clamped", () => {
  const result = normalizeControllerInput(source([], [
    { value: Infinity }, { value: -3 }, { value: 7 }, { value: NaN, pressed: true },
  ]));
  assert.deepEqual(result.buttons.map((button) => button.value), [0, 0, 1, 1, 0, 0]);
});

test("normalization returns detached arrays and button objects", () => {
  const input = source([0, 0, 0.5, -0.5], [{ value: 0.5 }]);
  const result = normalizeControllerInput(input);
  result.rawAxes[0] = 8;
  result.normalizedStick[1] = 8;
  result.buttons[0].value = 8;
  assert.equal(input.gamepad.axes[2], 0.5);
  assert.equal(input.gamepad.buttons[0].value, 0.5);
  assert.deepEqual(normalizeControllerInput(input).rawAxes, [0.5, -0.5]);
});

test("HUD panels occupy lower corners and preserve the city centre corridor", () => {
  const { left, right } = hudLayout;
  assert.ok(left.position[0] < 0 && right.position[0] > 0);
  assert.equal(left.position[1], right.position[1]);
  assert.ok(left.position[1] + left.size[1] / 2 < 0);
  assert.ok(right.position[1] + right.size[1] / 2 < 0);
  assert.ok(left.position[0] + left.size[0] / 2 < -0.3);
  assert.ok(right.position[0] - right.size[0] / 2 > 0.3);
  for (const panel of [left, right]) {
    assert.ok(panel.position[2] < -1);
    assert.ok(Math.abs(Math.atan((Math.abs(panel.position[0]) + panel.size[0] / 2) / -panel.position[2])) < Math.PI / 6);
  }
  assert.equal(hudLayout.maxRefreshHz, 15);
  assert.equal(Object.isFrozen(left.position), true);
});

test("HUD uses only two unlit planes, throttles dirty drawing and clears session state", () => {
  const originalDocument = globalThis.document;
  const context = new Proxy({}, { get: (_target, key) => key === "measureText" ? () => ({ width: 0 }) : () => {}, set: () => true });
  globalThis.document = {
    createElement: (tag) => ({
      tag,
      style: {},
      hidden: false,
      children: [],
      attributes: {},
      setAttribute(name, value) { this.attributes[name] = value; },
      append(child) { this.children.push(child); },
      getContext: () => context,
    }),
  };
  class CanvasTexture {
    constructor(canvas) { this.image = canvas; }
  }
  class PlaneGeometry {
    constructor(...size) { this.size = size; }
  }
  class MeshBasicMaterial {
    constructor(options) { Object.assign(this, options); }
  }
  class Mesh {
    constructor(geometry, material) {
      this.geometry = geometry;
      this.material = material;
      this.position = { fromArray: (value) => { this.location = [...value]; } };
    }
  }
  const camera = { children: [], add(mesh) { this.children.push(mesh); } };
  const viewport = { children: [], append(child) { this.children.push(child); } };
  try {
    const hud = createControllerHud({ CanvasTexture, PlaneGeometry, MeshBasicMaterial, Mesh, SRGBColorSpace: "srgb", LinearFilter: "linear" }, camera, viewport);
    assert.equal(camera.children.length, 2);
    assert.equal(viewport.children.length, 2);
    for (const mesh of camera.children) {
      assert.equal(mesh.material.depthTest, false);
      assert.equal(mesh.material.depthWrite, false);
      assert.equal(mesh.material.toneMapped, false);
      assert.equal(mesh.material.transparent, true);
      assert.equal(mesh.renderOrder, 1001);
      assert.equal(mesh.visible, false);
    }
    assert.equal(hud.getState().hands.left.previewVisible, true);
    assert.equal(hud.getState().hands.left.active, false);
    hud.setXR(true);
    assert.ok(camera.children.every((mesh) => mesh.visible));
    assert.ok(viewport.children.every((overlay) => overlay.hidden));
    const base = performance.now() + 100;
    const input = source([0, 0, 0.5, -0.5], [{ value: 0.5, touched: true }]);
    hud.update([input], { free: true, flight: { verticalSpeed: 3 } }, base);
    const first = hud.getState();
    assert.equal(first.hands.left.connected, true);
    assert.equal(first.hands.left.active, true);
    assert.equal(first.hands.right.connected, false);
    assert.equal(first.hands.left.spatialVisible, true);
    hud.update([input], { free: true, flight: { verticalSpeed: 3 } }, base + 80);
    assert.equal(hud.getState().renderCount, first.renderCount, "identical frames must not redraw or upload textures");
    const changed = source([0, 0, 0.6, -0.5]);
    hud.update([changed], { free: true }, base + 81);
    const dirtyCount = hud.getState().renderCount;
    hud.update([input], { free: true }, base + 82);
    assert.equal(hud.getState().renderCount, dirtyCount, "dirty changes are limited to 15 Hz");
    assert.deepEqual(hud.getState().hands.left.rawAxes, [0.5, -0.5], "input diagnostics update even between texture refreshes");
    hud.update([], { free: true }, base + 160);
    assert.equal(hud.getState().hands.left.connected, false);
    assert.deepEqual(hud.getState().hands.left.rawAxes, [0, 0]);
    assert.equal(hud.getState().hands.left.buttons[0].value, 0);
    hud.update([input], { free: true }, base + 240);
    const detached = hud.getState();
    detached.hands.left.rawAxes[0] = 100;
    detached.hands.left.buttons[0].value = 100;
    detached.layout.left.position[0] = 100;
    assert.equal(hud.getState().hands.left.rawAxes[0], 0.5);
    assert.equal(hud.getState().hands.left.buttons[0].value, 0.5);
    assert.equal(hud.getState().layout.left.position[0], -0.6);
    hud.setXR(false);
    assert.ok(camera.children.every((mesh) => !mesh.visible));
    assert.ok(viewport.children.every((overlay) => !overlay.hidden));
    assert.equal(hud.getState().hands.left.connected, false);
    assert.equal(hud.getState().free, false);
    hud.update([input], { free: true }, base + 320);
    assert.equal(hud.getState().hands.left.connected, false, "desktop preview must not claim active Quest controls");
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});
