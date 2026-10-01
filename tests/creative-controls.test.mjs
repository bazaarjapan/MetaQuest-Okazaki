import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createCreativeControls, creativeConfig, constrainCreativeFeet, readControlMode, controlPreferenceKey } from "../src/creative-controls.js";
import { createBlockAvatar } from "../src/block-avatar.js";
import { clampPosition } from "../src/motion.js";
import { clampToRegion } from "../src/region-plan.js";

function emitter(extra = {}) {
  const handlers = new Map();
  return { ...extra,
    addEventListener(type, handler) { if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type).add(handler); },
    removeEventListener(type, handler) { handlers.get(type)?.delete(handler); },
    emit(type, event = {}) { for (const handler of [...(handlers.get(type) ?? [])]) handler(event); },
    count() { return [...handlers.values()].reduce((sum, set) => sum + set.size, 0); } };
}
function fixture(options = {}) {
  let time = 1000, dialog = false;
  const doc = emitter({ pointerLockElement: null, activeElement: null,
    querySelector: () => dialog ? {} : null,
    exitPointerLock() { this.pointerLockElement = null; this.emit("pointerlockchange"); } });
  const canvas = emitter({ requestPointerLock() { doc.pointerLockElement = canvas; doc.emit("pointerlockchange"); } });
  const win = emitter(), rig = new THREE.Group(), camera = new THREE.PerspectiveCamera();
  camera.position.set(10, 31.65, 20); rig.add(camera);
  const orbit = { enabled: true, target: new THREE.Vector3() };
  const avatar = createBlockAvatar(THREE);
  const control = createCreativeControls(THREE, { camera, rig, domElement: canvas,
    getControls: () => orbit, avatar, documentTarget: doc, windowTarget: win,
    now: () => time, ...options });
  const key = (code, extra = {}) => {
    const event = { code, repeat: false, prevented: false, preventDefault() { this.prevented = true; }, ...extra };
    control.handleKeyDown(event); return event;
  };
  return { control, camera, rig, orbit, avatar, doc, canvas, win, key,
    release: (code) => control.handleKeyUp({ code }),
    advance: (milliseconds) => { time += milliseconds; },
    setDialog: (value) => { dialog = value; },
    enable() { control.setMode("creative"); control.step(0, { enabled: true }); } };
}
function close(actual, expected, tolerance = 1e-8) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
}

test("PC preference defaults creative, remembers deliberate choices and never inherits old drone default", () => {
  assert.equal(readControlMode(), "creative");
  assert.equal(readControlMode({ getItem: () => { throw new Error("denied"); } }), "creative");
  for (const value of ["", "invalid", null]) assert.equal(readControlMode({ getItem: () => value }), "creative");
  for (const value of ["creative", "drone"]) assert.equal(readControlMode({ getItem: (key) => {
    assert.equal(key, controlPreferenceKey); return value;
  } }), value);
  assert.equal(readControlMode({ getItem: (key) => key === "okazaki-control-mode-v1" ? "drone" : null }), "creative");
});

test("double tap each WASD within 350ms sprints while second press held and release stops", () => {
  for (const code of ["KeyW", "KeyA", "KeyS", "KeyD"]) {
    const f = fixture(); f.enable();
    const initial = f.control.getState().anchor;
    f.key(code); f.release(code); f.advance(350); f.key(code);
    assert.equal(f.control.getState().sprinting, true, code);
    f.control.step(0.1, { enabled: true });
    close(new THREE.Vector3().fromArray(initial).distanceTo(new THREE.Vector3().fromArray(f.control.getState().anchor)), 1.8);
    f.release(code); assert.equal(f.control.getState().sprinting, false);
    const stopped = f.control.getState().anchor;
    f.control.step(0.1, { enabled: true }); assert.deepEqual(f.control.getState().anchor, stopped);
    f.control.dispose();
  }
});

test("different key, slow taps, repeats and input loss cannot accidentally activate double tap sprint", () => {
  for (const cause of ["different", "slow", "repeat", "blur", "modal", "XR", "mode", "visibility"]) {
    const f = fixture(); f.enable(); f.key("KeyW");
    if (cause === "repeat") { f.advance(100); f.key("KeyW", { repeat: true }); }
    else {
      f.release("KeyW"); f.advance(cause === "slow" ? 351 : 100);
      if (cause === "blur") f.win.emit("blur");
      if (cause === "visibility") { f.doc.hidden = true; f.doc.emit("visibilitychange"); f.doc.hidden = false; }
      if (cause === "modal") { f.setDialog(true); f.control.step(0, { enabled: true }); f.setDialog(false); f.control.step(0, { enabled: true }); }
      if (cause === "XR") { f.control.captureForXR(); f.control.restoreAfterXR(); f.control.step(0, { enabled: true }); }
      if (cause === "mode") { f.control.setMode("drone"); f.enable(); }
      f.key(cause === "different" ? "KeyA" : "KeyW");
    }
    assert.equal(f.control.getState().sprinting, false, cause); f.control.dispose();
  }
});

test("main's creative boundary allows low DEM walking/jump while preserving core and region limits", () => {
  for (const constrainEye of [clampPosition, (eye) => clampToRegion(eye, [-500, -600, 500, 600], 1200)]) {
    const f = fixture({ groundHeight: () => 16.5,
      constrainPosition: (feet) => constrainCreativeFeet(feet, constrainEye) });
    f.camera.position.set(10, 20, 20); f.enable();
    f.key("Space"); f.release("Space"); f.advance(100); f.key("Space"); f.release("Space");
    assert.equal(f.control.getState().flying, false);
    for (let i = 0; i < 30; i++) f.control.step(0.1, { enabled: true });
    close(f.control.getState().anchor[1], 16.5);
    f.advance(400); f.key("Space"); f.control.step(0.1, { enabled: true });
    assert.ok(f.control.getState().anchor[1] > 16.5, "jump must launch from real low ground");
    f.release("Space");
    const feet = new THREE.Vector3(9999, 2000, -9999);
    constrainCreativeFeet(feet, constrainEye);
    assert.ok(feet.x < 9999 && feet.z > -9999);
    assert.ok(feet.y <= 1200 - creativeConfig.eyeHeight);
    f.control.dispose();
  }
});

test("default drone mode does not capture keys or alter the existing camera", () => {
  const f = fixture(), before = f.camera.position.clone();
  f.control.step(0.1, { enabled: true });
  assert.equal(f.control.getState().mode, "drone");
  assert.equal(f.key("KeyW").prevented, false);
  assert.equal(f.key("F5").prevented, false);
  assert.equal(f.orbit.enabled, true);
  close(f.camera.position.distanceTo(before), 0);
});

test("entering creative preserves full world camera pose and derives feet anchor", () => {
  const f = fixture();
  f.rig.position.set(-20, 10, 5); f.rig.rotation.y = 0.5;
  f.camera.quaternion.setFromEuler(new THREE.Euler(0.2, -0.3, 0.1, "YXZ"));
  f.camera.updateWorldMatrix(true, false);
  const beforePosition = f.camera.getWorldPosition(new THREE.Vector3());
  const beforeOrientation = f.camera.getWorldQuaternion(new THREE.Quaternion());
  f.enable();
  close(f.camera.getWorldPosition(new THREE.Vector3()).distanceTo(beforePosition), 0);
  assert.ok(f.camera.getWorldQuaternion(new THREE.Quaternion()).angleTo(beforeOrientation) < 1e-7);
  close(f.control.getState().anchor[1], beforePosition.y - creativeConfig.eyeHeight);
  assert.equal(f.orbit.enabled, false);
  assert.equal(f.avatar.getState().visible, false);
});

test("WASD uses player heading and diagonal normalization; Ctrl sprints", () => {
  const straight = fixture(), diagonal = fixture(), sprint = fixture();
  for (const f of [straight, diagonal, sprint]) f.enable();
  straight.key("KeyW"); straight.control.step(0.1, { enabled: true });
  diagonal.key("KeyW"); diagonal.key("KeyD"); diagonal.control.step(0.1, { enabled: true });
  sprint.key("KeyW"); sprint.key("ControlLeft"); sprint.control.step(0.1, { enabled: true });
  close(20 - straight.control.getState().anchor[2], 1.2);
  close(Math.hypot(diagonal.control.getState().anchor[0] - 10, diagonal.control.getState().anchor[2] - 20), 1.2);
  close(20 - sprint.control.getState().anchor[2], 1.8);
});

test("Space and Shift move vertically; releasing controls immediately stops", () => {
  const f = fixture(); f.enable(); f.key("Space");
  f.control.step(0.1, { enabled: true }); close(f.control.getState().anchor[1], 31.2);
  f.release("Space"); f.key("ShiftLeft");
  f.control.step(0.1, { enabled: true }); close(f.control.getState().anchor[1], 30);
  f.release("ShiftLeft");
  f.control.step(0.1, { enabled: true }); close(f.control.getState().anchor[1], 30);
});

test("double-Space toggles flight once; repeats and held keys cannot toggle", () => {
  const f = fixture(); f.enable();
  f.key("Space"); f.advance(100); f.key("Space", { repeat: true });
  assert.equal(f.control.getState().flying, true);
  f.release("Space"); f.key("Space");
  assert.equal(f.control.getState().flying, false);
  f.key("Space"); assert.equal(f.control.getState().flying, false);
  f.release("Space"); f.advance(400); f.key("Space");
  f.release("Space"); f.advance(100); f.key("Space");
  assert.equal(f.control.getState().flying, true);
});

test("walking follows real supplied ground and never fabricates missing terrain", () => {
  const f = fixture({ groundHeight: () => 30 }); f.enable();
  f.key("Space"); f.release("Space"); f.advance(100); f.key("Space"); f.release("Space");
  f.control.step(0.1, { enabled: true }); close(f.control.getState().anchor[1], 30);
  f.advance(400); f.key("Space");
  f.control.step(0.1, { enabled: true }); assert.ok(f.control.getState().anchor[1] > 30);
  const missing = fixture({ groundHeight: () => null }); missing.enable();
  missing.key("Space"); missing.release("Space"); missing.advance(100); missing.key("Space"); missing.release("Space");
  for (let i = 0; i < 20; i++) missing.control.step(0.1, { enabled: true });
  close(missing.control.getState().anchor[1], 30);
  assert.equal(missing.control.getState().groundAvailable, false);
});

test("F5 cycles three views with stable player feet and a visible local avatar", () => {
  const f = fixture(); f.enable();
  const feet = f.control.getState().anchor;
  assert.equal(f.key("F5").prevented, true);
  assert.equal(f.control.getState().viewMode, "back");
  assert.equal(f.avatar.getState().visible, true);
  close(f.camera.position.z, 25);
  f.key("KeyW"); f.control.step(0.1, { enabled: true }); f.release("KeyW");
  close(f.control.getState().anchor[2], feet[2] - 1.2);
  close(f.camera.position.z, 23.8);
  f.key("F5"); assert.equal(f.control.getState().viewMode, "front");
  close(f.camera.position.z, 13.8);
  f.key("F5"); assert.equal(f.control.getState().viewMode, "first");
  assert.equal(f.avatar.getState().visible, false);
  assert.deepEqual(f.control.getState().anchor.slice(0, 2), feet.slice(0, 2));
});

test("form/dialog input is ignored and does not reload the page via F5", () => {
  const f = fixture(); f.enable();
  const input = { matches: () => true };
  assert.equal(f.key("KeyW", { target: input }).prevented, false);
  assert.equal(f.control.getState().pressedKeys.length, 0);
  const f5 = f.key("F5", { target: input });
  assert.equal(f5.prevented, true); assert.equal(f.control.getState().viewMode, "first");
  f.key("KeyW"); f.setDialog(true);
  f.control.step(0.1, { enabled: true });
  assert.deepEqual(f.control.getState().pressedKeys, []);
  close(f.control.getState().anchor[2], 20);
});

test("looking upward in rear view does not put the camera below real ground", async () => {
  const f = fixture({ groundHeight: () => 30 }); f.enable();
  f.canvas.emit("click"); await Promise.resolve();
  f.control.handleMouseMove({ movementX: 0, movementY: -500 });
  f.key("F5");
  close(f.camera.position.y, 30.25);
  close(f.control.getState().anchor[1], 30);
  close(f.control.getState().pitch, 1);
  assert.equal(f.avatar.getState().visible, true);
});

test("pointer lock is user-initiated, mouse look bounded, Esc/blur safely release", async () => {
  const f = fixture(); f.enable();
  f.control.handleMouseMove({ movementX: 100, movementY: 50 });
  close(f.control.getState().yaw, 0);
  f.canvas.emit("click"); await Promise.resolve();
  assert.equal(f.control.getState().pointerLocked, true);
  f.control.handleMouseMove({ movementX: 100, movementY: -50 });
  close(f.control.getState().yaw, -0.2); close(f.control.getState().pitch, 0.1);
  f.control.handleMouseMove({ movementX: Infinity, movementY: NaN });
  close(f.control.getState().yaw, -0.2);
  f.key("KeyW"); f.key("Escape");
  assert.equal(f.control.getState().pointerLocked, false);
  assert.deepEqual(f.control.getState().pressedKeys, []);
  f.canvas.emit("click"); await Promise.resolve(); f.key("KeyW"); f.win.emit("blur");
  assert.equal(f.control.getState().pointerLocked, false);
  assert.deepEqual(f.control.getState().pressedKeys, []);
});

test("lost pointer lock, visibility, input block and disabled movement stop held inputs", async () => {
  const f = fixture(); f.enable(); f.canvas.emit("click"); await Promise.resolve();
  f.key("KeyW"); f.doc.exitPointerLock();
  assert.deepEqual(f.control.getState().pressedKeys, []);
  f.key("KeyW"); f.control.step(0.1, { enabled: false });
  close(f.control.getState().anchor[2], 20);
  f.control.step(0, { enabled: true }); f.key("KeyW");
  f.control.step(0.1, { enabled: true, blocked: true });
  close(f.control.getState().anchor[2], 20);
  f.control.step(0, { enabled: true }); f.key("KeyW"); f.doc.hidden = true; f.doc.emit("visibilitychange");
  assert.deepEqual(f.control.getState().pressedKeys, []);
});

test("late pointer lock acquisition is released after switching away from creative", async () => {
  const f = fixture(); f.enable();
  let finish;
  f.canvas.requestPointerLock = () => new Promise((resolve) => { finish = () => {
    f.doc.pointerLockElement = f.canvas; f.doc.emit("pointerlockchange"); resolve(); }; });
  f.canvas.emit("click"); f.control.setMode("drone"); finish(); await Promise.resolve();
  assert.equal(f.control.getState().pointerLocked, false);
  assert.equal(f.orbit.enabled, true);
});

test("XR capture uses player eyes rather than rear camera; physical return is safe first-person", () => {
  const f = fixture(); f.enable(); f.key("F5"); f.key("KeyW");
  const view = f.control.captureForXR();
  assert.deepEqual(view.position, [10, 31.65, 20]);
  assert.equal(f.control.getState().suspendedXR, true);
  assert.equal(f.avatar.getState().visible, false);
  f.control.step(0.1, { enabled: true, xr: true });
  close(f.control.getState().anchor[2], 20);
  f.control.restoreAfterXR({ position: [100, 50, -20], quaternion: [0, 0, 0, 1] });
  assert.deepEqual(f.control.getState().anchor, [100, 48.35, -20]);
  assert.equal(f.control.getState().enabled, false);
  assert.equal(f.control.getState().viewMode, "first");
  assert.equal(f.avatar.getState().visible, false);
  assert.deepEqual(f.control.getState().pressedKeys, []);
  assert.deepEqual(f.camera.getWorldPosition(new THREE.Vector3()).toArray(), [100, 50, -20]);
});

test("camera teleport sync, constraints, immutable diagnostics and disposal are safe", () => {
  const f = fixture({ constrainPosition: (p) => { p.x = Math.min(p.x, 10.5); return p; } }); f.enable();
  f.key("KeyD"); f.control.step(0.1, { enabled: true }); close(f.control.getState().anchor[0], 10.5);
  f.camera.position.set(15, 40, 25); f.control.syncFromCamera();
  assert.deepEqual(f.control.getState().anchor, [15, 38.35, 25]);
  const state = f.control.getState(); state.anchor[0] = 999; state.pressedKeys.push("KeyW");
  assert.equal(f.control.getState().anchor[0], 15);
  assert.deepEqual(f.control.getState().pressedKeys, []);
  f.control.step(NaN, { enabled: true });
  assert.ok(f.control.getState().anchor.every(Number.isFinite));
  assert.throws(() => f.control.setMode("invalid"), RangeError);
  assert.throws(() => f.control.restoreAfterXR({ position: [NaN, 0, 0], quaternion: [0, 0, 0, 1] }), TypeError);
  f.control.dispose(); f.control.dispose();
  assert.equal(f.control.getState().disposed, true);
  assert.equal(f.win.count() + f.doc.count() + f.canvas.count(), 0);
  assert.equal(f.orbit.enabled, true);
});
