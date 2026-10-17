import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createHeldSTL } from "../src/held-stl.js";
import { createBlockAvatar } from "../src/block-avatar.js";

function fixture() {
  const avatar=createBlockAvatar(THREE), camera=new THREE.PerspectiveCamera(), scene=new THREE.Scene();
  scene.add(avatar.group,camera);
  const draft=new THREE.Mesh(new THREE.BoxGeometry(1000,2000,500),new THREE.MeshStandardMaterial({transparent:true,opacity:.8}));
  draft.geometry.translate(100,1000,50);
  draft.userData={isDraft:true,creationId:"local-draft"}; scene.add(draft);
  const held=createHeldSTL({avatar,camera});
  return {avatar,camera,scene,draft,held};
}
test("hand copy is normalized, follows avatar, and leaves source transforms/material/geometry unchanged",()=>{
  const f=fixture(), original=f.draft.geometry.attributes.position.array.slice();
  const before=f.draft.matrix.clone();
  f.draft.rotation.set(.3,.8,1.1);
  f.held.update({draft:f.draft,canEdit:true,thirdPerson:true});
  assert.equal(f.held.getState().parent,"held-stl-hand");
  assert.equal(f.avatar.getState().holding,true);
  const copy=f.avatar.hand.getObjectByName("held-stl-model");
  assert.equal(copy.geometry,f.draft.geometry); assert.notEqual(copy.material,f.draft.material);
  assert.equal(copy.material.transparent,false); assert.equal(f.draft.material.opacity,.8);
  assert.deepEqual(f.draft.geometry.attributes.position.array,original); assert.deepEqual(f.draft.matrix,before);
  const size=new THREE.Box3().setFromObject(copy).getSize(new THREE.Vector3());
  assert.ok(Math.abs(Math.max(...size.toArray())-.65)<1e-6);
  f.avatar.update({position:[12,3,5],yaw:1,moving:true,time:2});
  assert.equal(f.avatar.group.getObjectByName("right-arm").rotation.x,Math.PI/3);
  assert.ok(copy.getWorldPosition(new THREE.Vector3()).distanceTo(new THREE.Vector3(12,4,5))<1);
});
test("first-person reparenting, selection change and repeated cleanup preserve cache geometry",()=>{
  const f=fixture(); let disposedGeometry=0;
  f.draft.geometry.addEventListener("dispose",()=>disposedGeometry++);
  f.held.update({draft:f.draft,canEdit:true,thirdPerson:true});
  const first=f.avatar.hand.getObjectByName("held-stl-model"); let disposedMaterial=0;
  first.material.addEventListener("dispose",()=>disposedMaterial++);
  f.held.update({draft:f.draft,canEdit:true,thirdPerson:false});
  assert.equal(f.camera.getObjectByName("held-stl-model"),first);
  assert.equal(f.avatar.getState().holding,false);
  const other=f.draft.clone(); other.userData.creationId="other";
  f.held.update({draft:other,canEdit:true,thirdPerson:true});
  assert.equal(disposedMaterial,1); assert.equal(f.held.getState().sourceId,"other");
  f.held.clear(); f.held.clear(); assert.equal(disposedGeometry,0);
});
test("placement, cancel, logout, hidden tab and XR all remove the hand copy",()=>{
  for (const change of [{draft:null},{canEdit:false},{xr:true},{hidden:true}]) {
    const f=fixture(); f.held.update({draft:f.draft,canEdit:true,thirdPerson:true});
    f.held.update({draft:f.draft,canEdit:true,thirdPerson:true,...change});
    assert.equal(f.held.getState().visible,false); assert.equal(f.avatar.getState().holding,false);
    assert.equal(f.avatar.hand.children.length,0);
  }
});
test("committed meshes cannot become held items and disposed view cannot revive",()=>{
  const f=fixture(); f.draft.userData.isDraft=false;
  f.held.update({draft:f.draft,canEdit:true}); assert.equal(f.held.getState().visible,false);
  f.held.dispose(); f.draft.userData.isDraft=true;
  f.held.update({draft:f.draft,canEdit:true}); assert.equal(f.held.getState().visible,false);
});
