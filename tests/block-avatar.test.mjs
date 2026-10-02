import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createBlockAvatar } from "../src/block-avatar.js";

test("original block avatar is a small asset-free group anchored at its feet", () => {
  const avatar = createBlockAvatar(THREE);
  const meshes = [];
  avatar.group.traverse((object) => { if (object.isMesh) meshes.push(object); });
  assert.equal(meshes.length, 9);
  assert.equal(new Set(meshes.map((mesh) => mesh.geometry)).size, 1);
  assert.ok(meshes.every((mesh) => !mesh.material.map));
  assert.equal(avatar.getState().visible, false);
  const bounds = new THREE.Box3().setFromObject(avatar.group);
  assert.ok(Math.abs(bounds.min.y) < 1e-9);
  assert.ok(bounds.max.y > 1.8 && bounds.max.y < 1.9);
  assert.equal(avatar.getState().materialCount, 5);
});

test("avatar pose handles independent head pitch and block-limb movement", () => {
  const avatar = createBlockAvatar(THREE, { color: 0xaa3344 });
  avatar.update({ position: [10, 20, -30], yaw: 0.4, pitch: 0.5, moving: true, time: 0.1 });
  assert.deepEqual(avatar.getState().position, [10, 20, -30]);
  assert.equal(avatar.getState().yaw, 0.4);
  assert.equal(avatar.getState().pitch, 0.5);
  assert.equal(avatar.getState().visible, true);
  const left = avatar.group.getObjectByName("left-leg"), right = avatar.group.getObjectByName("right-leg");
  assert.notEqual(left.rotation.x, 0);
  assert.equal(left.rotation.x, -right.rotation.x);
  avatar.update({ moving: false, visible: false });
  assert.equal(left.rotation.x, 0);
  assert.equal(avatar.getState().visible, false);
});

test("invalid avatar coordinates do not corrupt pose; getState is an independent snapshot", () => {
  const avatar = createBlockAvatar(THREE);
  avatar.update({ position: new THREE.Vector3(1, 2, 3), yaw: 0.2 });
  avatar.update({ position: [NaN, Infinity, 0], yaw: NaN, pitch: 100 });
  const state = avatar.getState();
  assert.deepEqual(state.position, [1, 2, 3]);
  assert.equal(state.yaw, 0.2);
  assert.equal(state.pitch, 1.4);
  state.position[0] = 999;
  assert.equal(avatar.getState().position[0], 1);
});

test("avatar disposes shared resources exactly once and removes its own group", () => {
  const avatar = createBlockAvatar(THREE), scene = new THREE.Scene();
  scene.add(avatar.group);
  let geometryDisposals = 0, materialDisposals = 0;
  const geometry = avatar.group.getObjectByName("torso").geometry;
  geometry.addEventListener("dispose", () => geometryDisposals++);
  const materials = new Set();
  avatar.group.traverse((object) => { if (object.isMesh) materials.add(object.material); });
  for (const material of materials) material.addEventListener("dispose", () => materialDisposals++);
  avatar.dispose(); avatar.dispose(); avatar.update({ visible: true });
  assert.equal(geometryDisposals, 1);
  assert.equal(materialDisposals, 5);
  assert.equal(avatar.group.parent, null);
  assert.equal(avatar.getState().disposed, true);
  assert.equal(avatar.getState().visible, false);
});

test("opaque identity generates stable original appearance, without changing the shared cube budget", () => {
  const first = createBlockAvatar(THREE, { identity: "user-one" });
  const again = createBlockAvatar(THREE, { identity: "user-one" });
  const other = createBlockAvatar(THREE, { identity: "user-two" });
  assert.deepEqual(first.getState().appearance, again.getState().appearance);
  assert.notDeepEqual(first.getState().appearance, other.getState().appearance);
  first.setIdentity("user-two"); assert.deepEqual(first.getState().appearance, other.getState().appearance);
  first.setColor("#112233"); assert.equal(first.group.getObjectByName("torso").material.color.getHexString(), "112233");
  assert.equal(first.getState().materialCount, 5); first.dispose(); again.dispose(); other.dispose();
});

test("a shirt matching the old skin color never recolors face or arms", () => {
  const avatar = createBlockAvatar(THREE, { color: 0xeac198, identity: "user-one" });
  const face = avatar.group.getObjectByName("face");
  const skin = face.material.color.getHex();
  avatar.setColor("#112233");
  assert.equal(face.material.color.getHex(), skin);
  assert.equal(avatar.group.getObjectByName("left-arm").material, face.material);
  assert.notEqual(avatar.group.getObjectByName("torso").material, face.material); avatar.dispose();
});
