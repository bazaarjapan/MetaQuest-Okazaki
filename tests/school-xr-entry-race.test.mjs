import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, Script } from "node:vm";
import * as THREE from "three";
import { alignRigToView, captureXRView } from "../src/vr-view.js";

// Execute the actual integration function, not a duplicate implementation or
// a production test hook. All external state below is an explicit unit fixture;
// this is not evidence from a browser or physical headset.
const mainSource = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const start = mainSource.indexOf("function adoptSchoolPose() {");
const end = mainSource.indexOf("\nschoolClient.subscribe", start);
assert.ok(start >= 0 && end > start, "actual main integration function is available");
const adoptScript = new Script(`${mainSource.slice(start, end)}\nadoptSchoolPose();`,
  { filename: "actual-main-adoptSchoolPose.js" });

const copy = (value) => structuredClone(value);
const previousView = { position: [1, 2, 3], quaternion: [0, 0, 0, 1] };
const checkpointPosition = [100, 20, 30];

function fixture({ xr = false, entering = false } = {}) {
  const calls = { desktop: 0, sync: 0, stop: 0, cancel: 0, label: null };
  const context = createContext({ THREE,
    state: { ready: true, xr }, xrEntering: entering,
    lastSchoolSnapshot: 1, restoredWorld: "world", pendingXRView: copy(previousView),
    desktopView: copy(previousView),
    schoolState: { world: { id: "world" }, connection: "connected", snapshotSeq: 2,
      user: { id: "student" },
      participants: [{ id: "student", position: [...checkpointPosition], yaw: 0.7 }] },
    setFree(value) { assert.equal(value, false); calls.stop++; },
    vrWorkshop: { cancelPicking() { calls.cancel++; } },
    creative: { syncFromCamera() { calls.sync++; } },
    updateLabels(value) { calls.label = value; },
  });
  context.restoreDesktopView = (view) => { context.desktopView = copy(view); calls.desktop++; };
  return { context, calls, run: () => adoptScript.runInContext(context, { timeout: 1000 }) };
}

function checkpointQueued(context) {
  assert.deepEqual(Array.from(context.pendingXRView.position), checkpointPosition);
  assert.equal(context.lastSchoolSnapshot, 2);
  assert.equal(context.restoredWorld, "world");
}

test("teacher checkpoint while XR entry waits replaces old pending view and successful entry aligns to it", () => {
  const f = fixture({ entering: true }); f.run();
  checkpointQueued(f.context);
  assert.deepEqual(f.context.desktopView.position, checkpointPosition);
  assert.equal(f.calls.desktop, 1); assert.equal(f.calls.sync, 1);
  assert.equal(f.calls.stop, 1); assert.equal(f.calls.cancel, 1); assert.equal(f.calls.label, "school");
  // The real entry alignment consumes the queued checkpoint after a request
  // succeeds; the session's usual default rig cannot overwrite it.
  f.context.state.xr = true;
  const rig = new THREE.Group(); rig.position.set(195, 74.4, 105); rig.rotation.y = 0.95;
  const transform = { position: { x: 0, y: 1.6, z: 0 },
    orientation: { x: 0, y: 0, z: 0, w: 1 } };
  alignRigToView(rig, f.context.pendingXRView, transform);
  const actual = captureXRView(rig, transform);
  assert.ok(actual.position.every((value, axis) => Math.abs(value - checkpointPosition[axis]) < 1e-9));
  const yaw = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().fromArray(actual.quaternion), "YXZ").y;
  assert.ok(Math.abs(yaw - 0.7) < 1e-9);
});

test("teacher checkpoint while permission waits also restores desktop so rejected entry retains new position", () => {
  const f = fixture({ entering: true }); f.run(); checkpointQueued(f.context);
  assert.deepEqual(f.context.desktopView.position, checkpointPosition);
  // Drone permission failure clears the pending entry without restoring a
  // creative camera. The desktop must already have the checkpoint at this point.
  f.context.pendingXRView = null; f.context.xrEntering = false;
  f.run();
  assert.deepEqual(f.context.desktopView.position, checkpointPosition);
  assert.equal(f.calls.desktop, 1); assert.equal(f.context.pendingXRView, null);
  assert.equal(f.context.lastSchoolSnapshot, 2);
});

test("an already immersive checkpoint queues new XR view without moving the desktop camera", () => {
  const f = fixture({ xr: true }); f.run(); checkpointQueued(f.context);
  assert.deepEqual(f.context.desktopView, previousView);
  assert.equal(f.calls.desktop, 0); assert.equal(f.calls.sync, 0);
});

test("an idle desktop checkpoint restores the new view without inventing an XR entry", () => {
  const f = fixture(); f.run();
  assert.deepEqual(f.context.desktopView.position, checkpointPosition);
  assert.deepEqual(f.context.pendingXRView, previousView);
  assert.equal(f.calls.desktop, 1); assert.equal(f.calls.sync, 1);
  assert.equal(f.context.lastSchoolSnapshot, 2);
});

test("a consumed checkpoint cannot reset later movement or recreate pending XR alignment", () => {
  const f = fixture({ entering: true }); f.run();
  const movedView = { position: [200, 50, 60], quaternion: [0, 0, 0, 1] };
  f.context.pendingXRView = null; f.context.xrEntering = false;
  f.context.desktopView = copy(movedView); f.run();
  assert.deepEqual(f.context.desktopView, movedView);
  assert.equal(f.context.pendingXRView, null);
  assert.equal(f.calls.desktop, 1); assert.equal(f.calls.stop, 1);
});
