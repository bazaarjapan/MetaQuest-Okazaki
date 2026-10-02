import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createVRControllerPointer, vrControllerPointerStyle } from "../src/vr-controller-pointer.js";

const near = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance,
  `${actual} should be within ${tolerance} of ${expected}`);
const nearVector = (actual, expected) => near(actual.distanceTo(expected), 0);
function fixture(handedness = "left", transformed = false) {
  const scene = new THREE.Scene(), parent = new THREE.Group();
  if (transformed) {
    parent.position.set(9, -4, 3); parent.rotation.set(.3, .7, -.2); parent.scale.set(2, 3, .5);
  }
  scene.add(parent);
  const pointer = createVRControllerPointer(THREE, { parent, handedness });
  const origin = new THREE.Vector3(3, 4, 5), direction = new THREE.Vector3(.3, -.2, -1).normalize();
  const point = origin.clone().addScaledVector(direction, 1.7);
  const options = { enabled: true, origin, direction, hit: { point, action: "east" }, time: 1000 };
  return { scene, parent, pointer, origin, direction, point, options,
    update(next = {}) { const accepted = pointer.update({ ...options, ...next }); scene.updateMatrixWorld(true); return accepted; } };
}

test("both hand palettes are distinct; a physical-width beam ends exactly at the actual panel intersection", () => {
  for (const hand of ["left", "right"]) {
    const f = fixture(hand); assert.equal(f.update(), true);
    const state = f.pointer.getState();
    assert.equal(state.visible, true); assert.equal(state.target, "east");
    assert.equal(state.reticleVisible, true); assert.equal(state.blocked, false);
    assert.equal(state.color, vrControllerPointerStyle.colors[hand]);
    near(state.distance, 1.7); near(state.beamWidth, .005);
    nearVector(new THREE.Vector3(0, -.5, 0).applyMatrix4(f.pointer.beam.matrixWorld), f.origin);
    nearVector(new THREE.Vector3(0, .5, 0).applyMatrix4(f.pointer.beam.matrixWorld), f.point);
    nearVector(f.pointer.ring.getWorldPosition(new THREE.Vector3()), f.point);
    nearVector(f.pointer.dot.getWorldPosition(new THREE.Vector3()), f.point);
    nearVector(new THREE.Vector3().fromArray(state.hitPoint), f.point);
    nearVector(new THREE.Vector3().fromArray(state.rayOrigin), f.origin);
    nearVector(new THREE.Vector3().fromArray(state.rayDirection), f.direction);
    f.pointer.dispose();
  }
  assert.notEqual(vrControllerPointerStyle.colors.left, vrControllerPointerStyle.colors.right);
});

test("parent translation, rotation and nonuniform scale do not shift the world-space endpoint or physical thickness", () => {
  const f = fixture("right", true); assert.equal(f.update(), true);
  const beam = f.pointer.beam;
  nearVector(new THREE.Vector3(0, -.5, 0).applyMatrix4(beam.matrixWorld), f.origin);
  nearVector(new THREE.Vector3(0, .5, 0).applyMatrix4(beam.matrixWorld), f.point);
  const middle = new THREE.Vector3().applyMatrix4(beam.matrixWorld);
  const radiusPoint = new THREE.Vector3(vrControllerPointerStyle.beamRadius, 0, 0).applyMatrix4(beam.matrixWorld);
  near(radiusPoint.distanceTo(middle), vrControllerPointerStyle.beamRadius);
  nearVector(f.pointer.ring.getWorldPosition(new THREE.Vector3()), f.point);
  nearVector(new THREE.Vector3(0, 0, 1).transformDirection(f.pointer.ring.matrixWorld), f.direction.clone().negate());
  f.pointer.dispose();
});

test("a blank or disabled panel surface clips the beam and shows a gray exact-intersection reticle, never a fake action", () => {
  const f = fixture(); f.update({ hit: { point: f.point, action: null }, pressed: true });
  const state = f.pointer.getState();
  assert.equal(state.target, null); assert.equal(state.blocked, true); assert.equal(state.pressed, true);
  assert.equal(state.reticleVisible, true); assert.equal(state.color, vrControllerPointerStyle.blocked);
  assert.equal(state.beamColor, vrControllerPointerStyle.colors.left);
  near(state.distance, 1.7); nearVector(f.pointer.ring.getWorldPosition(new THREE.Vector3()), f.point);
  f.pointer.dispose();
});

test("without a panel intersection the beam is three metres long and no target marker is fabricated", () => {
  const f = fixture(); f.update({ hit: null });
  const state = f.pointer.getState();
  near(state.distance, 3); assert.equal(state.target, null); assert.equal(state.hitPoint, null);
  assert.equal(state.blocked, false); assert.equal(state.reticleVisible, false);
  assert.equal(f.pointer.ring.visible, false); assert.equal(f.pointer.dot.visible, false);
  nearVector(new THREE.Vector3(0, .5, 0).applyMatrix4(f.pointer.beam.matrixWorld), f.origin.clone().addScaledVector(f.direction, 3));
  f.pointer.dispose();
});

test("selection feedback is brief, keeps the hand-colored beam, and hiding clears pending feedback and raw press state", () => {
  const f = fixture(); f.update(); assert.equal(f.pointer.flash(1000), true);
  f.update({ time: 1179, pressed: true });
  assert.equal(f.pointer.getState().color, vrControllerPointerStyle.success);
  assert.equal(f.pointer.getState().beamColor, vrControllerPointerStyle.colors.left);
  f.update({ time: 1180 }); assert.equal(f.pointer.getState().color, vrControllerPointerStyle.colors.left);
  f.pointer.flash(1180); assert.equal(f.update({ enabled: false, time: 1181 }), false);
  assert.equal(f.pointer.getState().visible, false); assert.equal(f.pointer.getState().pressed, false);
  assert.equal(f.pointer.getState().target, null); assert.equal(f.pointer.getState().hitPoint, null);
  assert.equal(f.pointer.flash(1181), false);
  f.update({ time: 1182 }); assert.equal(f.pointer.getState().color, vrControllerPointerStyle.colors.left);
  f.pointer.dispose();
});

test("unknown hands, invalid rays, backward/off-ray hits, invalid time and a singular parent all fail closed", () => {
  const f = fixture();
  assert.throws(() => createVRControllerPointer(THREE, { parent: f.parent, handedness: "none" }), TypeError);
  for (const next of [
    { origin: new THREE.Vector3(NaN, 0, 0) }, { direction: new THREE.Vector3(0, Infinity, 0) },
    { direction: new THREE.Vector3() }, { hit: { point: new THREE.Vector3(0, NaN, 0), action: "east" } },
    { hit: { point: f.origin.clone().addScaledVector(f.direction, -1), action: "east" } },
    { hit: { point: f.point.clone().add(new THREE.Vector3(1, 0, 0)), action: "east" } }, { time: NaN },
  ]) {
    f.update(); assert.equal(f.update(next), false);
    assert.equal(f.pointer.getState().visible, false); assert.equal(f.pointer.getState().reticleVisible, false);
  }
  f.parent.scale.y = 0; f.parent.updateMatrixWorld(true);
  assert.equal(f.update(), false); assert.equal(f.pointer.getState().visible, false);
  f.pointer.dispose();
});

test("repeated frames reuse three meshes, geometries and materials, while returned diagnostics are detached", () => {
  const f = fixture(), meshes = [...f.pointer.group.children];
  const geometries = meshes.map(mesh => mesh.geometry), materials = meshes.map(mesh => mesh.material);
  for (let index = 0; index < 100; index++) f.update({ time: 1000 + index });
  assert.deepEqual(f.pointer.group.children, meshes);
  assert.deepEqual(meshes.map(mesh => mesh.geometry), geometries); assert.deepEqual(meshes.map(mesh => mesh.material), materials);
  const snapshot = f.pointer.getState(); snapshot.hitPoint[0] += 100; snapshot.rayOrigin[0] += 100;
  nearVector(new THREE.Vector3().fromArray(f.pointer.getState().hitPoint), f.point);
  nearVector(new THREE.Vector3().fromArray(f.pointer.getState().rayOrigin), f.origin);
  f.pointer.dispose();
});

test("disposal releases every owned GPU resource exactly once and prevents all further visibility", () => {
  const f = fixture(); f.update(); let geometries = 0, materials = 0;
  for (const mesh of f.pointer.group.children) {
    mesh.geometry.addEventListener("dispose", () => geometries++);
    mesh.material.addEventListener("dispose", () => materials++);
  }
  f.pointer.dispose(); f.pointer.dispose();
  assert.equal(geometries, 3); assert.equal(materials, 3); assert.equal(f.parent.children.length, 0);
  assert.equal(f.update(), false); assert.equal(f.pointer.flash(1000), false);
  assert.equal(f.pointer.getState().visible, false); assert.equal(f.pointer.getState().reticleVisible, false);
});
