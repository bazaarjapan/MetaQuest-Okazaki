import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createCreativeControls, creativeConfig, constrainCreativeFeet, readControlMode, controlPreferenceKey, sampleGroundFootprint } from "../src/creative-controls.js";
import { createBlockAvatar } from "../src/block-avatar.js";
import { clampPosition, viewpoints } from "../src/motion.js";
import { clampToRegion } from "../src/region-plan.js";
import { wingTravel } from "../src/avatar-motion.js";

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
    now: () => time, initialView: "first", ...options });
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

test('work locator can choose first person without an avatar obscuring its target',()=>{
  const f=fixture({initialView:"back"});f.enable();
  f.camera.position.set(20,50,20); f.camera.lookAt(19,20,19);
  f.control.syncFromCamera({firstPerson:true});
  assert.equal(f.control.getState().viewMode,"first"); assert.equal(f.avatar.group.visible,false);
  assert.deepEqual(f.control.getState().pressedKeys,[]); f.control.dispose();
});

test('creative Shift descent cannot penetrate known terrain',()=>{
  const f=fixture({groundHeight:()=>30});f.enable();f.key('ShiftLeft');
  for(let i=0;i<40;i++)f.control.step(.1,{enabled:true});
  close(f.control.getState().anchor[1],30);assert.equal(f.control.getState().flying,true);f.control.dispose();
});
test('loaded DEM corrects feet while paused, but never while login-locked or in XR',()=>{
  let floor=null;const f=fixture({groundHeight:()=>floor});f.enable();floor=40;
  f.control.step(.1,{enabled:false});close(f.control.getState().anchor[1],30);
  f.control.step(.1,{enabled:false,grounding:true});close(f.control.getState().anchor[1],40);
  assert.equal(f.control.getState().enabled,false);assert.equal(f.control.getState().moving,false);
  floor=50;f.control.step(.1,{enabled:false,grounding:true,xr:true});close(f.control.getState().anchor[1],40);f.control.dispose();
});
test('ground is resampled at constrained XZ, not at the discarded proposed position',()=>{
  const f=fixture({groundHeight:(x)=>x<5?60:30,constrainPosition:feet=>{feet.x=0;return feet;}});
  f.enable();f.key('KeyW');f.control.step(.1,{enabled:true});close(f.control.getState().anchor[1],60);f.control.dispose();
});
test('footprint supports slope corners and does not fabricate missing ground',()=>{
  close(sampleGroundFootprint((x,z)=>x+z,10,20),30.585);
  assert.equal(sampleGroundFootprint(()=>null,0,0),null);
  close(sampleGroundFootprint((x,z)=>x===0&&z===0?4:null,0,0),4.025);
});
test('unchanged proposed XZ reuses the first ground sample',()=>{
  let calls=0;const f=fixture({groundHeight:()=>{calls++;return 30;}});f.enable();calls=0;
  f.control.step(.1,{enabled:true});assert.equal(calls,1);f.control.dispose();
});

test("Z launches, held Z boosts, release glides, X brakes and input loss never resumes flight", () => {
  const f=fixture(); f.enable(); const start=f.control.getState().anchor;
  f.key("KeyZ"); f.control.step(.1,{enabled:true});
  assert.equal(f.control.getState().animation,"boost");
  assert.ok(f.control.getState().anchor[2]<start[2]);
  assert.ok(f.control.getState().wingSpeed>12);
  f.release("KeyZ"); f.control.step(.1,{enabled:true});
  assert.equal(f.control.getState().animation,"glide");
  f.key("KeyX"); const stop=f.control.getState().anchor; f.control.step(.1,{enabled:true});
  assert.deepEqual(f.control.getState().anchor,stop); assert.equal(f.control.getState().animation,"idle");
  for(const interrupt of [()=>f.win.emit("blur"),()=>f.control.step(.1,{enabled:false}),
    ()=>f.control.step(.1,{enabled:true,blocked:true}),()=>f.control.captureForXR()]) {
    f.key("KeyZ"); f.control.step(.1,{enabled:true}); interrupt();
    const stopped=f.control.getState(); assert.equal(stopped.wingFlight,false); assert.equal(stopped.wingSpeed,0);
    f.control.step(.1,{enabled:true}); assert.deepEqual(f.control.getState().anchor,stopped.anchor);
  }
  f.control.dispose();
});

test("wing travel is bounded and frame-rate independent", () => {
  const results=[30,60,90].map(fps=>{ let speed=12,distance=0;
    for(let i=0;i<fps*3;i++){const r=wingTravel(speed,true,1/fps);speed=r.speed;distance+=r.distance;}
    assert.ok(speed<=80 && speed>79); return distance; });
  close(results[0],results[1]);close(results[1],results[2]);
  assert.ok(Number.isFinite(wingTravel(NaN,true,Infinity).distance));
});

test("unknown terrain holds glide altitude while preserving forward motion and explicit Space climb", () => {
  const f=fixture({groundHeight:()=>null});f.enable();f.key("KeyZ");f.control.step(.1,{enabled:true});f.release("KeyZ");
  const before=f.control.getState().anchor;for(let i=0;i<20;i++)f.control.step(.1,{enabled:true});
  assert.equal(f.control.getState().anchor[1],before[1]);assert.ok(f.control.getState().anchor[2]<before[2]);
  f.key("Space");f.control.step(.1,{enabled:true});assert.ok(f.control.getState().anchor[1]>before[1]);f.control.dispose();
});

test("unlocked flight mouse drag steers yaw/pitch without placing STL or retrying failed pointer lock", () => {
  const f=fixture(); f.enable();f.key("KeyZ");f.control.step(.1,{enabled:true});
  let prevented=false,consumed=false;
  f.canvas.emit("pointerdown",{pointerType:"mouse",button:2,pointerId:9,clientX:100,clientY:100,
    preventDefault(){prevented=true;},stopImmediatePropagation(){consumed=true;}});
  assert.equal(prevented,true);assert.equal(consumed,true);assert.equal(f.control.getState().mouseSteering,true);
  f.canvas.emit("pointermove",{pointerId:9,buttons:2,clientX:200,clientY:50});
  close(f.control.getState().yaw,-.2);close(f.control.getState().pitch,.1);
  f.win.emit("pointerup",{pointerId:9,button:2,clientX:200,clientY:50});const yaw=f.control.getState().yaw;
  f.canvas.emit("pointermove",{pointerId:9,buttons:0,clientX:300,clientY:50});
  close(f.control.getState().yaw,yaw);
  assert.equal(f.doc.pointerLockElement,null);
  assert.equal(f.control.getState().wingFlight,true);f.control.dispose();
});

test("right drag also works outside flight and clears on blur/modal/XR", () => {
  const f=fixture();f.enable();
  const down=()=>f.canvas.emit("pointerdown",{pointerType:"mouse",button:2,pointerId:1,clientX:10,clientY:10});
  down();assert.equal(f.control.getState().mouseSteering,true);f.win.emit("blur");
  f.key("KeyZ");down();assert.equal(f.control.getState().mouseSteering,true);
  f.win.emit("blur");assert.equal(f.control.getState().mouseSteering,false);
  f.key("KeyZ");f.control.step(.1,{enabled:true});down();f.control.step(.1,{enabled:true,blocked:true});
  assert.equal(f.control.getState().mouseSteering,false);
  f.control.step(.1,{enabled:true});f.key("KeyZ");down();f.control.captureForXR();
  assert.equal(f.control.getState().mouseSteering,false);f.control.dispose();
});

test("held STL right click places, right drag looks, and left input is reserved for retrieval", () => {
  let context={mode:"place",token:"draft1"}, placements=0;
  const f=fixture({getPointerContext:()=>context,onFlightClick:()=>placements++});f.enable();
  const down=(button=2)=>f.canvas.emit("pointerdown",{pointerType:"mouse",button,pointerId:7,clientX:100,clientY:100});
  const move=(x,buttons=2)=>f.canvas.emit("pointermove",{pointerId:7,buttons,clientX:x,clientY:100});
  const up=(x=100,button=2)=>f.win.emit("pointerup",{pointerId:7,button,clientX:x,clientY:100});
  down(0);up(100,0);assert.equal(placements,0);assert.equal(f.control.getState().mouseSteering,false);
  down();assert.equal(placements,0);up();assert.equal(placements,1);
  f.canvas.emit("click");assert.equal(f.doc.pointerLockElement,null);
  down();move(150);up(150);assert.ok(f.control.getState().yaw<0);assert.equal(placements,1);
  context={mode:"place",token:"draft1"};down(2);move(150,2);
  context={mode:"look",token:"draft1"};move(200,2);up(200,2);
  assert.ok(f.control.getState().yaw<0);assert.equal(placements,1);
  context={mode:"look",token:"draft1"};down(2);context={mode:"place",token:"draft1"};up(100,2);
  assert.equal(placements,1);f.control.dispose();
});

test("held STL gestures reject changed draft, cancelled input, blocked UI and pointer lock", () => {
  let context={mode:"place",token:"draft1"}, placements=0;
  const f=fixture({getPointerContext:()=>context,onFlightClick:()=>placements++});f.enable();
  const down=()=>f.canvas.emit("pointerdown",{pointerType:"mouse",button:2,pointerId:7,clientX:100,clientY:100});
  const up=()=>f.win.emit("pointerup",{pointerId:7,button:2,clientX:100,clientY:100});
  down();context={mode:"place",token:"draft2"};up();assert.equal(placements,0);
  for(const cancel of [()=>f.win.emit("blur"),()=>f.canvas.emit("pointercancel"),
    ()=>f.control.step(0,{enabled:true,blocked:true})]) {
    f.control.step(0,{enabled:true});down();cancel();up();assert.equal(placements,0);
  }
  f.control.step(0,{enabled:true});context={mode:"blocked",token:"draft2"};down();
  assert.equal(f.control.getState().mouseSteering,false);f.canvas.emit("click");assert.equal(f.doc.pointerLockElement,null);
  f.control.dispose();
});

test("held STL flight defers a click for placement but never places a drag or cancelled gesture", () => {
  let placements=0; const f=fixture({getPointerContext:()=>({mode:"place",token:"draft"}),onFlightClick:()=>placements++});f.enable();f.key("KeyZ");
  const down=()=>f.canvas.emit("pointerdown",{pointerType:"mouse",button:2,pointerId:7,clientX:100,clientY:100});
  const up=(x=102)=>f.win.emit("pointerup",{pointerId:7,button:2,clientX:x,clientY:100});
  down();assert.equal(placements,0);
  f.canvas.emit("pointermove",{pointerId:7,buttons:2,clientX:102,clientY:100});
  close(f.control.getState().yaw,0);up();assert.equal(placements,1);
  down();f.canvas.emit("pointermove",{pointerId:7,buttons:2,clientX:130,clientY:100});up(130);
  assert.equal(placements,1);
  down();f.canvas.emit("pointercancel");up();assert.equal(placements,1);
  down();f.win.emit("blur");up();assert.equal(placements,1);f.control.dispose();
});

test("cancelled placement gestures never swallow a subsequent ordinary click",()=>{
  for(const cancel of ['pointercancel','lostpointercapture','released-buttons']) {
    let context={mode:'place',token:'draft'};
    const f=fixture({getPointerContext:()=>context});f.enable();
    f.canvas.emit('pointerdown',{pointerType:'mouse',button:0,pointerId:7,clientX:100,clientY:100});
    if(cancel==='released-buttons') f.canvas.emit('pointermove',{pointerId:7,buttons:0,clientX:110,clientY:100});
    else f.canvas.emit(cancel);
    context=null;f.canvas.emit('click');assert.equal(f.doc.pointerLockElement,f.canvas);f.control.dispose();
  }
});

test("Space climbs while gliding or boosting, including downward gaze; double Space never cancels wings", () => {
  const f=fixture(); f.enable(); f.doc.pointerLockElement=f.canvas;
  f.control.handleMouseMove({movementX:0,movementY:450});
  f.key("KeyZ");f.control.step(.1,{enabled:true});f.release("KeyZ");
  const before=f.control.getState().anchor[1]; f.key("Space");f.control.step(.1,{enabled:true});
  assert.ok(f.control.getState().anchor[1]>=before+1.19);
  assert.equal(f.control.getState().animation,"glide");
  f.release("Space");f.advance(80);f.key("Space");
  assert.equal(f.control.getState().wingFlight,true); assert.equal(f.control.getState().flying,true);
  f.key("KeyZ");const boosting=f.control.getState().anchor[1]; f.control.step(.1,{enabled:true});
  assert.ok(f.control.getState().anchor[1]>=boosting+1.19);assert.equal(f.control.getState().animation,"boost");
  f.key("KeyX");const stopped=f.control.getState().anchor;f.control.step(.1,{enabled:true});
  assert.deepEqual(f.control.getState().anchor,stopped); f.control.dispose();
});

test("ground launch, landing and exact stationary/walk/run animation", () => {
  const f=fixture({groundHeight:()=>30}); f.enable();
  f.key("KeyZ"); f.control.step(.1,{enabled:true}); assert.ok(f.control.getState().anchor[1]>30);
  f.release("KeyZ"); for(let i=0;i<10;i++)f.control.step(.1,{enabled:true});
  assert.equal(f.control.getState().wingFlight,false); assert.equal(f.control.getState().flying,false);
  close(f.control.getState().anchor[1],30); assert.equal(f.control.getState().animation,"idle");
  f.key("KeyW");f.control.step(.1,{enabled:true});assert.equal(f.control.getState().animation,"walk");
  f.key("ControlLeft");f.control.step(.1,{enabled:true});assert.equal(f.control.getState().animation,"run");
  f.key("KeyS");f.control.step(.1,{enabled:true});assert.equal(f.control.getState().animation,"idle");
  f.control.dispose();
});

test("double Space held climbs three times faster in both glide and rocket flight", () => {
  for (const boost of [false,true]) {
    const f=fixture();f.enable();f.key("KeyZ");if(!boost)f.release("KeyZ");
    let y=f.control.getState().anchor[1];f.key("Space");f.control.step(.1,{enabled:true});
    close(f.control.getState().anchor[1]-y,1.2);
    f.release("Space");f.advance(100);f.key("Space");
    assert.equal(f.control.getState().fastClimb,true);
    y=f.control.getState().anchor[1];f.control.step(.1,{enabled:true});
    close(f.control.getState().anchor[1]-y,3.6);
    f.release("Space");assert.equal(f.control.getState().fastClimb,false);
    f.advance(400);f.key("Space");y=f.control.getState().anchor[1];f.control.step(.1,{enabled:true});
    close(f.control.getState().anchor[1]-y,1.2);f.control.dispose();
  }
});

test("fast climb requires a real double tap within350ms and never stacks", () => {
  const f=fixture();f.enable();f.key("KeyZ");f.key("Space");
  f.advance(80);f.key("Space",{repeat:true});f.key("Space");
  assert.equal(f.control.getState().fastClimb,false);
  f.release("Space");f.advance(400);f.key("Space");
  assert.equal(f.control.getState().fastClimb,false);
  f.release("Space");f.advance(100);f.key("Space");
  assert.equal(f.control.getState().fastClimb,true);
  const y=f.control.getState().anchor[1];f.key("ControlLeft");
  f.control.step(.1,{enabled:true});close(f.control.getState().anchor[1]-y,3.6);
  f.control.dispose();
});

test("fast climb and tap history clear on safety stops and cannot cross into wing flight", () => {
  for(const stop of [f=>f.key("KeyX"),f=>f.win.emit("blur"),
    f=>f.control.step(0,{enabled:true,blocked:true}),f=>f.control.captureForXR(),
    f=>f.control.step(0,{enabled:false})]) {
    const f=fixture();f.enable();f.key("Space");f.release("Space");f.advance(80);f.key("KeyZ");f.key("Space");
    assert.equal(f.control.getState().fastClimb,false);
    f.release("Space");f.advance(80);f.key("Space");assert.equal(f.control.getState().fastClimb,true);
    stop(f);assert.equal(f.control.getState().fastClimb,false);assert.equal(f.control.getState().wingFlight,false);
    f.control.dispose();
  }
});

test("rear/front to drone round trips preserve the player eye, heading and anchor", () => {
  for (const initialView of ["back", "front"]) {
    const f = fixture({ initialView }); f.enable();
    const before = f.control.getState();
    for (let i = 0; i < 5; i++) {
      f.control.setMode("drone");
      assert.deepEqual(f.camera.getWorldPosition(new THREE.Vector3()).toArray(), before.eye);
      f.control.setMode("creative");
      assert.deepEqual(f.control.getState().anchor, before.anchor);
      close(f.control.getState().yaw, before.yaw);
    }
    f.control.dispose();
  }
});

test("failed XR entry retains rear/front view while real session exit stays first-person", () => {
  for (const initialView of ["back", "front"]) {
    const f = fixture({ initialView }); f.enable();
    const before = f.control.getState(), camera = f.camera.position.clone();
    const pending = f.control.captureForXR();
    f.control.restoreAfterXR(pending, { entryFailed: true });
    assert.equal(f.control.getState().viewMode, initialView);
    assert.deepEqual(f.control.getState().anchor, before.anchor);
    close(f.camera.position.distanceTo(camera), 0);
    assert.equal(f.control.getState().enabled, false);
    f.control.restoreAfterXR(f.control.captureForXR());
    assert.equal(f.control.getState().viewMode, "first");
    f.control.dispose();
  }
});

test("idle touch rotates and pinches the rear camera without moving player; modal/XR gates suppress it", () => {
  const f = fixture({ initialView: "back" }); f.enable();
  f.control.step(0, { enabled: false });
  const eye = f.control.getState().eye;
  const point = (type, id, x, y) => f.canvas.emit(type, {pointerType:"touch",pointerId:id,clientX:x,clientY:y,preventDefault(){}});
  point("pointerdown",1,100,100); point("pointermove",1,120,110);
  close(f.control.getState().yaw,-.1); close(f.control.getState().pitch,-.05);
  assert.deepEqual(f.control.getState().eye,eye);
  point("pointerdown",2,220,110); point("pointermove",2,320,110);
  close(f.control.getState().cameraDistance,2.5);
  point("pointerup",1,120,110); point("pointercancel",2,320,110);
  const yaw = f.control.getState().yaw;
  f.setDialog(true); point("pointerdown",1,100,100); point("pointermove",1,200,100);
  close(f.control.getState().yaw,yaw); f.setDialog(false);
  f.control.captureForXR(); point("pointerdown",1,100,100); point("pointermove",1,200,100);
  close(f.control.getState().yaw,yaw); assert.deepEqual(f.control.getState().eye,eye);
  f.control.dispose();
});

test("fresh creative controls default rear third person without shifting player; pose adoption retains choice", () => {
  const f = fixture({ initialView: undefined }); f.enable();
  assert.equal(f.control.getState().viewMode, "back");
  assert.equal(f.avatar.getState().visible, true);
  assert.deepEqual(f.control.getState().anchor, [10,30,20]);
  close(f.control.getState().cameraDistance,5);
  // A server pose supplies eye coordinates, not the detached camera position.
  f.camera.position.set(20,41.65,30); f.control.syncFromCamera();
  assert.equal(f.control.getState().viewMode,"back");
  assert.deepEqual(f.control.getState().anchor,[20,40,30]);
  f.key("F5"); assert.equal(f.control.getState().viewMode,"front");
  f.key("F5"); assert.equal(f.control.getState().viewMode,"first");
  f.key("F5"); assert.equal(f.control.getState().viewMode,"back");
  const eye = f.control.captureForXR(); assert.equal(f.avatar.getState().visible,false);
  f.control.restoreAfterXR(eye);
  assert.equal(f.control.getState().viewMode,"first");
  assert.deepEqual(f.control.getState().eye,eye.position);
});

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

test("initial ON preserves the overview from its first enabled frame while region bounds are pending", () => {
  let regionReady = false, constraintCalls = 0;
  const f = fixture({ groundHeight: () => null, constrainPosition: feet => {
    constraintCalls++;
    return constrainCreativeFeet(feet, eye => regionReady
      ? clampToRegion(eye, [-4000, -4000, 4000, 4000], 1200) : clampPosition(eye));
  } });
  f.camera.position.fromArray(viewpoints.overview.position);
  f.camera.lookAt(new THREE.Vector3().fromArray(viewpoints.overview.target));
  const before = f.camera.getWorldQuaternion(new THREE.Quaternion());
  f.enable(); // Includes the first actual enabled step, before region is ready.
  assert.deepEqual(f.control.getState().eye, viewpoints.overview.position);
  for (let i = 0; i < 30; i++) f.control.step(.1, { enabled: true });
  assert.deepEqual(f.control.getState().eye, viewpoints.overview.position);
  assert.equal(constraintCalls, 0);
  assert.ok(f.camera.getWorldQuaternion(new THREE.Quaternion()).angleTo(before) < 1e-7);
  regionReady = true; f.control.step(.1, { enabled: true });
  assert.deepEqual(f.control.getState().eye, viewpoints.overview.position);
  regionReady = false; f.key("KeyW"); f.control.step(.1, { enabled: true });
  assert.equal(constraintCalls, 1, "real input still applies existing fallback limits");
  assert.ok(f.control.getState().eye[0] <= 265 && f.control.getState().eye[2] <= 325 && f.control.getState().eye[1] <= 300);
  f.release("KeyW"); f.control.dispose();
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

test("UI view cycling is bounded and preserves eye pose through repeated switches and XR", () => {
  const f = fixture(); f.enable(); const eye = f.control.getState().eye;
  for (let i = 0; i < 30; i++) assert.equal(f.control.cycleView(), true);
  assert.deepEqual(f.control.getState().eye, eye); assert.equal(f.control.getState().viewMode, "first");
  f.control.captureForXR(); assert.equal(f.control.cycleView(), false); f.control.restoreAfterXR();
  assert.equal(f.control.getState().viewMode, "first"); assert.deepEqual(f.control.getState().eye, eye); f.control.dispose();
});

test("third-person camera stops before a nearby wall while the player stays still", () => {
  const wall = new THREE.Mesh(new THREE.BoxGeometry(10,10,.2), new THREE.MeshBasicMaterial());
  wall.position.set(10,31.65,22); wall.updateMatrixWorld(true);
  const f = fixture({ cameraObstacles: () => [wall] }); f.enable();
  const eye = f.control.getState().eye; f.control.cycleView();
  assert.ok(f.camera.position.z < 21.9); assert.ok(f.camera.position.z > 20);
  assert.deepEqual(f.control.getState().eye, eye); f.control.dispose();
});

test("touch axes move the player independently of third-person camera and stop when input is released", () => {
  const f = fixture(); f.enable(); f.control.cycleView();
  f.control.step(.1,{enabled:true,touchAxes:{left:[0,0],right:[0,-1]}});
  close(f.control.getState().anchor[2],18.8);
  f.control.step(.1,{enabled:true,touchAxes:{left:[0,0],right:[0,0]}});
  close(f.control.getState().anchor[2],18.8);
  f.control.step(.1,{enabled:true,blocked:true,touchAxes:{left:[1,-1],right:[1,-1]}});
  close(f.control.getState().anchor[2],18.8); f.control.dispose();
});

test("malformed touch axes never corrupt the finite player pose", () => {
  const f = fixture(); f.enable(); const before = f.control.getState().eye;
  for (const touchAxes of [{left:[],right:[0,0]},{left:[NaN,0],right:[0,0]}, {left:[0],right:[] }]) f.control.step(.1,{enabled:true,touchAxes});
  assert.deepEqual(f.control.getState().eye,before); f.control.dispose();
});

test("stationary third-person camera reacts to loaded and removed obstacles without moving the player", () => {
  let obstacles = [];
  const wall = new THREE.Mesh(new THREE.BoxGeometry(10,10,.2), new THREE.MeshBasicMaterial());
  wall.position.set(10,31.65,20.5);
  const f = fixture({ cameraObstacles: () => obstacles }); f.enable(); f.control.cycleView();
  f.control.step(0, { enabled: false });
  const eye = f.control.getState().eye;
  close(f.control.getState().cameraDistance, 5);
  obstacles = [wall]; f.control.step(.1, { enabled: false });
  assert.ok(f.control.getState().cameraDistance < .5);
  assert.equal(f.avatar.getState().visible, false);
  assert.deepEqual(f.control.getState().eye, eye);
  obstacles = []; f.control.step(.1, { enabled: false });
  close(f.control.getState().cameraDistance, 5);
  assert.equal(f.avatar.getState().visible, true);
  assert.deepEqual(f.control.getState().eye, eye); f.control.dispose();
});
