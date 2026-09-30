import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { captureView, captureXRView, alignRigToView } from "../src/vr-view.js";

function close(actual, expected, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}

function closeVector(actual, expected) {
  close(actual.distanceTo(expected), 0);
}

function closeQuaternion(actual, expected) {
  assert.ok(actual.angleTo(expected) < 1e-7, "orientations must agree");
}

function orientation(pitch = 0, yaw = 0, roll = 0) {
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, roll, "YXZ"));
}

function transform(position, quaternion) {
  return {
    position: { x: position.x, y: position.y, z: position.z },
    orientation: { x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w },
  };
}

function cameraAtTransform(rig, pose) {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(pose.position.x, pose.position.y, pose.position.z);
  camera.quaternion.set(pose.orientation.x, pose.orientation.y, pose.orientation.z, pose.orientation.w);
  rig.add(camera);
  return camera;
}

test("captureView saves world position and orientation, including all parent transforms", () => {
  const parent = new THREE.Group();
  parent.position.set(-50, 20, 70);
  parent.quaternion.copy(orientation(0.1, -0.2, 0.05));
  const rig = new THREE.Group();
  rig.position.set(195, 74.4, 105);
  rig.rotation.y = 0.95;
  parent.add(rig);
  const localPosition = new THREE.Vector3(0.25, 1.6, -0.1);
  const localOrientation = orientation(-0.3, 0.15, 0.2);
  const camera = cameraAtTransform(rig, transform(localPosition, localOrientation));
  const view = captureView(camera);
  const expectedPosition = localPosition.clone()
    .applyQuaternion(rig.quaternion).add(rig.position)
    .applyQuaternion(parent.quaternion).add(parent.position);
  const expectedOrientation = parent.quaternion.clone()
    .multiply(rig.quaternion).multiply(localOrientation);
  closeVector(new THREE.Vector3().fromArray(view.position), expectedPosition);
  closeQuaternion(new THREE.Quaternion().fromArray(view.quaternion), expectedOrientation);
});

test("captureView refreshes dirty world matrices rather than saving an old rig pose", () => {
  const rig = new THREE.Group();
  const camera = cameraAtTransform(rig, transform(new THREE.Vector3(0, 1.6, 0), orientation()));
  rig.updateMatrixWorld(true);
  rig.position.set(120, 80, -40);
  rig.rotation.y = Math.PI / 2;
  camera.position.set(0.2, 1.7, -0.3);
  camera.quaternion.copy(orientation(0.1, -0.2, 0.3));
  const view = captureView(camera);
  const expected = camera.position.clone().applyQuaternion(rig.quaternion).add(rig.position);
  closeVector(new THREE.Vector3().fromArray(view.position), expected);
  closeQuaternion(new THREE.Quaternion().fromArray(view.quaternion),
    rig.quaternion.clone().multiply(camera.quaternion));
});

test("captured arrays are independent snapshots rather than live mutable camera state", () => {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(1, 2, 3);
  const view = captureView(camera);
  const snapshot = structuredClone(view);
  camera.position.set(4, 5, 6);
  camera.rotation.y = 1;
  captureView(camera);
  assert.deepEqual(view, snapshot);
  assert.notEqual(view.position, camera.position);
});

test("alignRigToView places the current physical head at saved world position and yaw", () => {
  const rig = new THREE.Group();
  rig.position.set(-70, 76, 10);
  rig.rotation.y = -0.9;
  const localPose = transform(new THREE.Vector3(0.35, 1.72, -0.24), orientation(0, -0.4, 0));
  const camera = cameraAtTransform(rig, localPose);
  const desired = orientation(0, 1.2, 0);
  const view = { position: [140, 86, -50], quaternion: desired.toArray() };
  alignRigToView(rig, view, localPose);
  const restored = captureView(camera);
  closeVector(new THREE.Vector3().fromArray(restored.position), new THREE.Vector3(...view.position));
  closeQuaternion(new THREE.Quaternion().fromArray(restored.quaternion), desired);
  close(rig.rotation.x, 0);
  close(rig.rotation.z, 0);
});

test("alignRigToView never forces saved pitch or roll onto the current physical head", () => {
  const rig = new THREE.Group();
  const physicalPitch = -0.35;
  const physicalYaw = -0.45;
  const physicalRoll = 0.22;
  const localPose = transform(new THREE.Vector3(-0.2, 1.5, 0.4),
    orientation(physicalPitch, physicalYaw, physicalRoll));
  const camera = cameraAtTransform(rig, localPose);
  const desiredYaw = 1.1;
  const view = {
    position: [10, 60, 120],
    quaternion: orientation(0.8, desiredYaw, -0.6).toArray(),
  };
  alignRigToView(rig, view, localPose);
  const restored = captureView(camera);
  const actual = new THREE.Quaternion().fromArray(restored.quaternion);
  closeQuaternion(actual, orientation(physicalPitch, desiredYaw, physicalRoll));
  closeVector(new THREE.Vector3().fromArray(restored.position), new THREE.Vector3(...view.position));
  const euler = new THREE.Euler().setFromQuaternion(actual, "YXZ");
  close(euler.x, physicalPitch);
  close(euler.z, physicalRoll);
  close(rig.rotation.x, 0);
  close(rig.rotation.z, 0);
});

test("alignRigToView discards old rig pitch/roll and handles yaw wrapping", () => {
  const rig = new THREE.Group();
  rig.rotation.set(0.8, 1, -0.6);
  const localPose = transform(new THREE.Vector3(0.5, 1.8, 0.2), orientation(0, Math.PI - 0.01, 0));
  const camera = cameraAtTransform(rig, localPose);
  const desired = orientation(0, -Math.PI + 0.02, 0);
  const view = { position: [200, 100, 300], quaternion: desired.toArray() };
  alignRigToView(rig, view, localPose);
  close(rig.rotation.x, 0);
  close(rig.rotation.z, 0);
  const restored = captureView(camera);
  closeVector(new THREE.Vector3().fromArray(restored.position), new THREE.Vector3(...view.position));
  closeQuaternion(new THREE.Quaternion().fromArray(restored.quaternion), desired);
});

test("alignRigToView does not mutate either saved view or current physical transform", () => {
  const view = { position: [190, 80, 115], quaternion: orientation(0.1, 0.95, 0.1).toArray() };
  const localPose = transform(new THREE.Vector3(0.1, 1.65, -0.2), orientation(-0.1, 0.2, 0));
  const expectedView = structuredClone(view);
  const expectedPose = structuredClone(localPose);
  alignRigToView(new THREE.Group(), view, localPose);
  assert.deepEqual(view, expectedView);
  assert.deepEqual(localPose, expectedPose);
});

test("saved forward and up reconstruct the complete tilted desktop view", () => {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(150, 80, -30);
  camera.quaternion.copy(orientation(-0.45, 1.1, 0.25));
  const view = captureView(camera);
  const savedOrientation = new THREE.Quaternion().fromArray(view.quaternion);
  const position = new THREE.Vector3().fromArray(view.position);
  const target = position.clone().add(new THREE.Vector3(0, 0, -60).applyQuaternion(savedOrientation));
  const restored = new THREE.PerspectiveCamera();
  restored.position.copy(position);
  restored.up.set(0, 1, 0).applyQuaternion(savedOrientation);
  restored.lookAt(target);
  closeVector(restored.position, position);
  closeQuaternion(restored.quaternion, savedOrientation);
});

test("captureXRView captures the physical viewer center, not a stereo culling-camera offset", () => {
  const rig = new THREE.Group();
  rig.position.set(195, 74.4, 105);
  rig.rotation.y = 0.95;
  const localPosition = new THREE.Vector3(0.2, 1.65, -0.3);
  const localOrientation = orientation(-0.3, 0.25, 0.1);
  const localPose = transform(localPosition, localOrientation);
  const camera = cameraAtTransform(rig, localPose);
  // Three.js may offset its stereo union/culling camera backwards from the
  // physical viewer. The saved resume pose must not inherit this offset.
  camera.position.add(new THREE.Vector3(0, 0, 0.035).applyQuaternion(localOrientation));
  const view = captureXRView(rig, localPose);
  const expectedPosition = localPosition.clone().applyQuaternion(rig.quaternion).add(rig.position);
  const expectedOrientation = rig.quaternion.clone().multiply(localOrientation);
  closeVector(new THREE.Vector3().fromArray(view.position), expectedPosition);
  closeQuaternion(new THREE.Quaternion().fromArray(view.quaternion), expectedOrientation);
  const cullingView = captureView(camera);
  close(new THREE.Vector3().fromArray(cullingView.position)
    .distanceTo(new THREE.Vector3().fromArray(view.position)), 0.035);
});

test("captureXRView refreshes world transforms and makes immutable snapshots", () => {
  const parent = new THREE.Group();
  parent.position.set(-25, 10, 60);
  parent.quaternion.copy(orientation(0.1, -0.3, 0.05));
  const rig = new THREE.Group();
  parent.add(rig);
  parent.updateMatrixWorld(true);
  rig.position.set(120, 80, -40);
  rig.rotation.y = 0.8;
  const localPosition = new THREE.Vector3(0.3, 1.6, -0.2);
  const localOrientation = orientation(-0.1, 0.4, 0.2);
  const localPose = transform(localPosition, localOrientation);
  const originalPose = structuredClone(localPose);
  const view = captureXRView(rig, localPose);
  const expectedPosition = localPosition.clone()
    .applyQuaternion(rig.quaternion).add(rig.position)
    .applyQuaternion(parent.quaternion).add(parent.position);
  const expectedOrientation = parent.quaternion.clone()
    .multiply(rig.quaternion).multiply(localOrientation);
  closeVector(new THREE.Vector3().fromArray(view.position), expectedPosition);
  closeQuaternion(new THREE.Quaternion().fromArray(view.quaternion), expectedOrientation);
  assert.deepEqual(localPose, originalPose);
  const snapshot = structuredClone(view);
  rig.position.set(999, 999, 999);
  localPose.position.x += 10;
  captureXRView(rig, localPose);
  assert.deepEqual(view, snapshot);
});

test("twenty physical-viewer capture/resume cycles have no accumulated stereo drift", () => {
  const rig = new THREE.Group();
  rig.position.set(195, 74.4, 105);
  rig.rotation.y = 0.95;
  const firstPose = transform(new THREE.Vector3(0.2, 1.65, -0.3), orientation(-0.3, 0.25, 0.1));
  let saved = captureXRView(rig, firstPose);
  const firstPosition = new THREE.Vector3().fromArray(saved.position);
  const firstYaw = new THREE.Euler().setFromQuaternion(
    new THREE.Quaternion().fromArray(saved.quaternion), "YXZ").y;

  for (let i = 0; i < 20; i += 1) {
    // Each re-entry may have a different physical room-scale position and
    // head tilt. The world location and yaw stay fixed; physical tilt is free.
    const pitch = -0.2 + (i % 5) * 0.08;
    const roll = -0.1 + (i % 3) * 0.09;
    const yaw = -0.6 + i * 0.04;
    const localPose = transform(new THREE.Vector3(-0.3 + i * 0.025,
      1.5 + (i % 4) * 0.05, 0.2 - i * 0.01), orientation(pitch, yaw, roll));
    alignRigToView(rig, saved, localPose);
    saved = captureXRView(rig, localPose);
    closeVector(new THREE.Vector3().fromArray(saved.position), firstPosition);
    closeQuaternion(new THREE.Quaternion().fromArray(saved.quaternion),
      orientation(pitch, firstYaw, roll));
    close(rig.rotation.x, 0);
    close(rig.rotation.z, 0);
  }
});
