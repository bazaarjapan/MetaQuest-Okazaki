import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createHeldSTL } from "../src/held-stl.js";
import { createBlockAvatar } from "../src/block-avatar.js";

function fixture() {
  const avatar=createBlockAvatar(THREE), camera=new THREE.PerspectiveCamera(), scene=new THREE.Scene();
  scene.add(avatar.group,camera);
  avatar.update({visible:true}); camera.name="test-camera";
  const draft=new THREE.Mesh(new THREE.BoxGeometry(1000,2000,500),new THREE.MeshStandardMaterial({transparent:true,opacity:.8}));
  draft.geometry.translate(100,1000,50);
  draft.userData={isDraft:true,creationId:"local-draft"}; scene.add(draft);
  const held=createHeldSTL({avatar,camera});
  return {avatar,camera,scene,draft,held};
}

test("first-person arm is visible empty, matches avatar colors and supports rotated held STL",()=>{
  const f=fixture(); f.held.update({firstPerson:true});
  assert.equal(f.held.getState().armVisible,true); assert.equal(f.held.getState().visible,false);
  const forearm=f.camera.getObjectByName("first-person-forearm"), sleeve=f.camera.getObjectByName("first-person-sleeve");
  f.avatar.setIdentity("different-student"); f.avatar.setColor("#ff2244");
  f.draft.rotation.set(.4,.8,.3);
  f.held.update({draft:f.draft,canEdit:true,firstPerson:true});
  assert.equal(f.held.getState().armHolding,true);
  assert.equal(forearm.material.color.getHex(),f.avatar.getState().appearance.skin);
  assert.equal(sleeve.material.color.getHex(),0xff2244);
  const model=f.camera.getObjectByName("held-stl-model"),palm=f.camera.getObjectByName("first-person-palm");
  const modelBox=new THREE.Box3().setFromObject(model),palmBox=new THREE.Box3().setFromObject(palm);
  assert.ok(Math.abs(modelBox.min.y-palmBox.max.y)<1e-7,"palm touches model bottom");
  assert.equal(model.material.depthTest,false); assert.equal(forearm.material.depthWrite,false);
  assert.ok(model.renderOrder>forearm.renderOrder);
  f.held.update({firstPerson:true});
  assert.equal(f.held.getState().armVisible,true); assert.equal(f.held.getState().armHolding,false);
});

test("arm hides outside first person, on XR/hidden/clear, and disposes only its own resources once",()=>{
  const f=fixture(), arm=f.camera.getObjectByName("first-person-arm"),part=arm.children[0];
  let geometries=0,materials=0,sourceDisposed=0;
  part.geometry.addEventListener("dispose",()=>geometries++);
  part.material.addEventListener("dispose",()=>materials++);
  f.draft.geometry.addEventListener("dispose",()=>sourceDisposed++);
  for(const change of [{firstPerson:false},{xr:true},{hidden:true}]) {
    f.held.update({firstPerson:true});assert.equal(arm.visible,true);
    f.held.update({firstPerson:true,...change});assert.equal(arm.visible,false);
  }
  f.held.update({firstPerson:true});f.held.clear();assert.equal(arm.visible,false);
  f.held.dispose();f.held.dispose();f.held.update({firstPerson:true});
  assert.equal(geometries,1);assert.equal(materials,1);assert.equal(sourceDisposed,0);
  assert.equal(arm.parent,null);assert.equal(arm.visible,false);
});

test("portrait and landscape palms remain in view and selected models remain supported after resize",()=>{
  const f=fixture();f.camera.fov=55;
  for(const aspect of [16/9,390/844,.25]) for(const holding of [false,true]) {
    f.camera.aspect=aspect;f.camera.updateProjectionMatrix();
    f.held.update({firstPerson:true,draft:holding?f.draft:null,canEdit:holding});
    const palm=f.camera.getObjectByName("first-person-palm");
    const center=palm.getWorldPosition(new THREE.Vector3()).project(f.camera);
    assert.ok(center.x>0&&center.x<1&&center.y<0&&center.y>-1);
    assert.equal(f.held.getState().armHolding,holding);
  }
});
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
  assert.equal(copy.material.side,THREE.DoubleSide);
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

test("clipped third-person avatar falls back to camera and returns to hand when clear",()=>{
  const f=fixture(); f.held.update({draft:f.draft,canEdit:true,thirdPerson:true});
  f.avatar.group.visible=false;
  f.held.update({draft:f.draft,canEdit:true,thirdPerson:true});
  assert.equal(f.held.getState().visible,true); assert.equal(f.held.getState().parent,"test-camera");
  assert.equal(f.avatar.getState().holding,false);
  f.avatar.group.visible=true;f.held.update({draft:f.draft,canEdit:true,thirdPerson:true});
  assert.equal(f.held.getState().parent,"held-stl-hand");assert.equal(f.avatar.getState().holding,true);
});

test("all held-model bounds remain inside landscape and portrait frustums after resize",()=>{
  for(const aspect of [16/9,390/844,.25]) for(const rotation of [[0,0,0],[.3,.7,1.1]]) {
    const f=fixture();f.camera.fov=55;f.camera.aspect=aspect;f.camera.updateProjectionMatrix();
    f.draft.rotation.set(...rotation);f.held.update({draft:f.draft,canEdit:true});
    const mesh=f.camera.getObjectByName("held-stl-model"),box=new THREE.Box3().setFromObject(mesh);
    for(const x of [box.min.x,box.max.x])for(const y of [box.min.y,box.max.y])for(const z of [box.min.z,box.max.z]) {
      const ndc=new THREE.Vector3(x,y,z).project(f.camera);
      assert.ok(Math.abs(ndc.x)<1&&Math.abs(ndc.y)<1&&ndc.z>-1&&ndc.z<1,`aspect ${aspect}: ${ndc.toArray()}`);
    }
  }
});
