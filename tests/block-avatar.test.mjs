import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createBlockAvatar } from "../src/block-avatar.js";

test("original block avatar is a small asset-free group anchored at its feet", () => {
  const avatar = createBlockAvatar(THREE);
  const meshes = [];
  avatar.group.traverse((object) => { if (object.isMesh) meshes.push(object); });
  assert.equal(meshes.length, 20);
  assert.equal(new Set(meshes.map((mesh) => mesh.geometry)).size, 3);
  assert.ok(meshes.every((mesh) => !mesh.material.map));
  assert.equal(avatar.getState().visible, false);
  const bounds = new THREE.Box3().setFromObject(avatar.group);
  assert.ok(Math.abs(bounds.min.y) < 1e-9);
  assert.ok(bounds.max.y > 1.8 && bounds.max.y < 2);
  assert.equal(avatar.getState().materialCount, 10);
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
  let allGeometryDisposals = 0;
  const allGeometries = new Set();
  avatar.group.traverse(object => { if(object.geometry) allGeometries.add(object.geometry); });
  for(const entry of allGeometries) entry.addEventListener("dispose",()=>allGeometryDisposals++);
  const geometry = avatar.group.getObjectByName("torso").geometry;
  geometry.addEventListener("dispose", () => geometryDisposals++);
  const materials = new Set();
  avatar.group.traverse((object) => { if (object.material) materials.add(object.material); });
  for (const material of materials) material.addEventListener("dispose", () => materialDisposals++);
  avatar.dispose(); avatar.dispose(); avatar.update({ visible: true });
  assert.equal(geometryDisposals, 1);
  assert.equal(allGeometryDisposals, 4);
  assert.equal(materialDisposals, 10);
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
  assert.equal(first.getState().materialCount, 10); first.dispose(); again.dispose(); other.dispose();
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

test("idle is exact, running has stronger gait, and original wings/rockets follow flight state", () => {
  const avatar = createBlockAvatar(THREE), leg = avatar.group.getObjectByName("left-leg");
  avatar.update({ animation: "walk", time: .1 }); const walk = Math.abs(leg.rotation.x);
  const arm = avatar.group.getObjectByName("right-arm"), armSwing = arm.rotation.x;
  avatar.setHolding(false); assert.equal(arm.rotation.x, armSwing);
  avatar.update({ animation: "run", time: .1 }); assert.ok(Math.abs(leg.rotation.x) > walk);
  avatar.setHolding(true);
  avatar.update({ animation: "boost", time: .1 });
  assert.equal(avatar.getState().wingsOpen, true); assert.equal(avatar.getState().boosting, true);
  assert.equal(avatar.group.getObjectByName("flame-0").visible, true);
  assert.equal(avatar.group.getObjectByName("wing-inner-0").visible, true);
  assert.equal(avatar.group.getObjectByName("wing-membrane-0").material.transparent, true);
  for(const i of [0,1]) {
    const inner=avatar.group.getObjectByName(`wing-inner-${i}`);
    const tip=new THREE.Vector3(.1,-.94,0).applyMatrix4(inner.matrix).sub(inner.position);
    assert.ok(tip.y<0,"wing tips sweep towards tail, not head");
    assert.ok(i ? tip.x>0 : tip.x<0,"wings open outwards on both sides");
  }
  assert.equal(avatar.hand.parent, avatar.group.getObjectByName("avatar-body"));
  assert.equal(avatar.group.getObjectByName("right-arm").rotation.x, Math.PI / 3);
  avatar.update({ animation: "glide" }); assert.equal(avatar.getState().boosting, false);
  avatar.setHolding(false); avatar.update({ animation: "idle", time: 500 });
  assert.equal(leg.rotation.x, 0); assert.equal(avatar.group.getObjectByName("avatar-body").rotation.x, 0);
  assert.equal(avatar.getState().wingsOpen, false); assert.equal(avatar.group.getObjectByName("flame-0").visible, false);
  assert.equal(avatar.group.getObjectByName("wing-inner-0").visible, false);
  avatar.dispose();
});

test("stowed shield elytra meet at a straight central seam and hug the back",()=>{
  const avatar=createBlockAvatar(THREE);avatar.update({animation:"idle"});
  const left=avatar.group.getObjectByName("wing-shell-0"),right=avatar.group.getObjectByName("wing-shell-1");
  const a=new THREE.Box3().setFromObject(left),b=new THREE.Box3().setFromObject(right);
  assert.ok(a.max.x<0&&b.min.x>0);assert.ok(b.min.x-a.max.x<.01,"central seam <1cm");
  assert.ok(a.min.z>=.15&&a.max.z<.25,"thin cover sits immediately behind torso");
  assert.ok(b.min.z>=.15&&b.max.z<.25);
  assert.ok(a.min.x>-.35&&b.max.x<.35,"stowed covers fit body width");
  avatar.update({animation:"boost"});assert.ok(Math.abs(left.parent.rotation.z)>.5);
  avatar.update({animation:"idle"});assert.equal(left.parent.rotation.z,0);avatar.dispose();
});
