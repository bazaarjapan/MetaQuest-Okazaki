import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import * as THREE from "three";
import { viewpoints, clampPosition, createFlightState, resetFlight, updateFlight, stickAxes } from "../src/motion.js";
import { initialPCMovement, readControlMode, controlPreferenceKey } from "../src/creative-controls.js";

test("fresh loaded desktop enables free input without overriding remembered mode", () => {
  assert.equal(initialPCMovement(), false);
  assert.equal(initialPCMovement({ ready: true }), true);
  assert.equal(readControlMode(), "creative");
  for (const mode of ["creative", "drone"]) {
    assert.equal(readControlMode({ getItem: key => key === controlPreferenceKey ? mode : null }), mode);
    assert.equal(initialPCMovement({ ready: true }), true);
  }
});

test("startup cannot enable input on mobile or override interruption, modal, school or XR stops", () => {
  for (const stop of ["mobile", "hidden", "interrupted", "dialogOpen", "xr", "xrEntering", "restoredWorld"]) {
    assert.equal(initialPCMovement({ ready: true, [stop]: true }), false, stop);
  }
  assert.equal(initialPCMovement({ ready: false }), false);
});

test("movement controls have one source in the observe tab, never duplicate settings/footer IDs", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const observe = html.slice(html.indexOf('<section id="panel-observe"'), html.indexOf('<section id="panel-region"'));
  for (const id of ["movement-controls", "control-mode", "free-move", "free-move-state", "creative-help", "move-help"]) {
    assert.equal(html.split(`id="${id}"`).length - 1, 1, id);
    assert.ok(observe.includes(`id="${id}"`), `${id} belongs to observe`);
  }
  assert.match(observe, /<label for="control-mode">/);
  assert.match(observe, /aria-describedby="creative-help move-help"/);
});

test("main enables startup once without teleport/pointer lock, and all free writes use the UI setter", async () => {
  const source = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
  assert.match(source, /if \(initialPCMovement\(/);
  assert.match(source, /setFree\(true, \{ preserveView: true \}\)/);
  assert.equal((source.match(/state\.free\s*=/g) ?? []).length, 1, "authoritative setter only");
  assert.match(source, /\$\("#free-move-state"\)\.textContent = state\.free \? "ON" : "OFF"/);
  assert.match(source, /attributeFilter: \["open"\]/);
});

for (const branch of ["keyboard", "touch"]) {
  test(`remembered drone initial ON preserves no-input overview in actual main ${branch} path`, async () => {
    const source = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
    const start = source.indexOf("function desktopMove(dt) {");
    const end = source.indexOf("renderer.setAnimationLoop(", start);
    assert.ok(start >= 0 && end > start);
    const camera = new THREE.PerspectiveCamera();
    camera.position.fromArray(viewpoints.overview.position);
    camera.lookAt(new THREE.Vector3().fromArray(viewpoints.overview.target));
    const controls = { target: new THREE.Vector3().fromArray(viewpoints.overview.target) };
    const keys = new Set(), axes = { left: [0, 0], right: [0, 0] };
    let constraintCalls = 0;
    const context = { THREE, camera, controls, keys, temp: new THREE.Vector3(),
      state: { free: true }, flight: createFlightState(), resetFlight, updateFlight, stickAxes,
      document: { querySelector: () => null }, workshop: { getState: () => ({ picking: false }) },
      adaptiveUi: { getState: () => ({ mobile: branch === "touch", open: false }) },
      touchControls: { getState: () => ({ enabled: branch === "touch", activePointers: 0 }), getAxes: () => axes },
      constrainPosition(position) { constraintCalls++; return clampPosition(position); } };
    const step = vm.runInNewContext(`${source.slice(start, end)}; desktopMove`, context);
    step(.05); // First enabled frame occurs while region bounds are still pending.
    assert.deepEqual(camera.position.toArray(), viewpoints.overview.position);
    for (let frame = 0; frame < 30; frame++) step(.05);
    assert.deepEqual(camera.position.toArray(), viewpoints.overview.position);
    assert.deepEqual(controls.target.toArray(), viewpoints.overview.target);
    assert.equal(constraintCalls, 0, "input enable alone must not clamp or teleport");
    if (branch === "touch") axes.right[1] = -1; else keys.add("KeyW");
    step(.05);
    assert.equal(constraintCalls, 1, "actual movement retains existing finite fallback limits");
    assert.ok(camera.position.x <= 265 && camera.position.z <= 325 && camera.position.y <= 300);
  });
}
