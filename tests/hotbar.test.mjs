import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import * as THREE from "three";
const source=(await readFile(new URL("../src/hotbar.js",import.meta.url),"utf8")).replace(/^import .*;\r?\n/gm,"").replace(/^export /gm,"");
const api=vm.runInNewContext(source+"\n({hotbarSlot,placementScaleFactor})");
test("number row 1 through 0 maps exactly to ten distinct slots",()=>{
  assert.deepEqual([1,2,3,4,5,6,7,8,9,0].map(n=>api.hotbarSlot(`Digit${n}`)),[0,1,2,3,4,5,6,7,8,9]);
  for(const key of ["KeyW","Escape","Digit10","Numpad1","F5",""]) assert.equal(api.hotbarSlot(key),-1);
});
test("wheel normalizes devices, scales proportionally, and clamps transform bounds",()=>{
  const factor=(deltaY,deltaMode=0,scale=[1,1,1])=>api.placementScaleFactor({deltaY,deltaMode},scale);
  assert.ok(Math.abs(factor(-100)-1.1)<1e-12);
  assert.ok(Math.abs(factor(100)*factor(-100)-1)<1e-12);
  assert.equal(factor(-100),factor(-6.25,1));assert.equal(factor(-100),factor(-.125,2));
  assert.equal(factor(-100,0,[100,50,25]),1);assert.equal(factor(100,0,[1e-6,2e-6,4e-6]),1);
  assert.equal(factor(100,0,[1000,1000,1000]),.1);assert.equal(factor(-100,0,[1000,1000,1000]),1);
  assert.equal(factor(-100,0,[1e-7,1e-7,1e-7]),10);assert.equal(factor(100,0,[1e-7,1e-7,1e-7]),1);
  assert.ok(factor(1e9)>.7);
  for(const event of [{deltaY:NaN},{deltaY:Infinity},{deltaY:100,ctrlKey:true},{deltaY:100,metaKey:true},{deltaY:100,deltaMode:3}])
    assert.equal(api.placementScaleFactor(event,[1,1,1]),1);
});

function harness() {
  class Node {
    constructor() { this.children=[]; this.events={}; this.classList={toggle(){}}; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children=nodes; }
    setAttribute() {}
    addEventListener(type,fn) { this.events[type]=fn; }
    getBoundingClientRect() { return {left:0,top:0,width:800,height:600}; }
  }
  const canvas=new Node(); canvas.parentElement=new Node();
  const document=Object.assign(new Node(),{createElement:()=>new Node(),querySelector:()=>null,pointerLockElement:null});
  const window=new Node();
  let xr=false, xrPending=false, picking=false, calls=0, now=0, removals=0, commits=0, current=null, canEdit=true, ground=[], obstacles=[], menuOpen=false, looking=false, adjustments=0, moves=0;
  const object={id:"object",assetId:"asset",editable:true,committed:true};
  const workshop={group:{children:[{userData:{creationId:"object"}}]},
    getState(){calls++;return {userId:"student",worldId:"world",canEdit,picking,ownAssets:[{id:"new-asset",name:"test.stl"}],objects:[object],current};},
    async useAsset(){current={id:"draft",assetId:"new-asset",committed:false,editable:true,scale:[1,1,1]};return true;},
    adjustSelected({scaleFactor,position}){adjustments++;current.scale=current.scale.map(v=>v*scaleFactor);if(position)current.position=position;return {valid:true};},
    moveSelected(){moves++;return {valid:true};},
    async commitSelected(){commits++;return true;},
    selectObject(){},async removeSelected(){removals++;return true;}};
  class Raycaster extends THREE.Raycaster {
    intersectObjects(objects) { return objects.length ? [{object:objects[0],distance:objects[0].distance??1,point:new THREE.Vector3()}] : []; }
  }
  const context=vm.createContext({THREE:{...THREE,Raycaster},document,window,performance:{now:()=>now}});
  const factory=vm.runInContext(source+"\ncreateHotbar",context);
  const hotbar=factory({workshop,client:{getState(){calls++;return {user:null};}},camera:new THREE.PerspectiveCamera(),canvas,
    scene:new THREE.Scene(),getEnvironment:()=>({terrainMeshes:ground}),getObstacles:()=>obstacles,isXR:()=>xr,isXRPending:()=>xrPending,isLooking:()=>looking,menu:{getState:()=>({open:menuOpen})}});
  return {hotbar,canvas,window,workshop,document,setGround:value=>{ground=value;},setObstacles:value=>{obstacles=value;},setEditable:value=>{canEdit=value;},
    async selectDraft(){hotbar.update(0);canvas.parentElement.children[0].children[1].onclick();await new Promise(setImmediate);},
    setMenu:value=>{menuOpen=value;},setPicking:value=>{picking=value;},setXRPending:value=>{xrPending=value;},setLooking:value=>{looking=value;},get adjustments(){return adjustments;},get moves(){return moves;},get commits(){return commits;},
    setXR:value=>{xr=value;},setTime:value=>{now=value;},get calls(){return calls;},get removals(){return removals;}};
}
test("hidden VR hotbar performs no school or workshop snapshot allocations",()=>{
  const h=harness(); h.setXR(true);
  for(let frame=0;frame<100;frame++) h.hotbar.update(frame*16);
  assert.equal(h.calls,0); assert.equal(h.hotbar.getState().aiming,false);
});
test("right click never retrieves; R requires an owned visible target and rejects repeated keys",async()=>{
  const h=harness();h.hotbar.update(0);
  h.canvas.events.pointerdown({button:2,pointerType:"mouse",clientX:400,clientY:300,preventDefault(){}});
  h.setTime(1000);h.hotbar.update(1000);assert.equal(h.removals,0);
  h.canvas.events.pointermove({clientX:400,clientY:300});
  h.window.events.keydown({code:"KeyR",repeat:true});assert.equal(h.removals,0);
  h.window.events.keydown({code:"KeyR",preventDefault(){}});await new Promise(setImmediate);assert.equal(h.removals,1);
});
test("R cannot retrieve through a wall, after pointer loss, or without ownership",()=>{
  for(const event of ["pointerleave","pointercancel"]) {
    const h=harness(); h.hotbar.update(0);
    h.canvas.events.pointermove({clientX:400,clientY:300});
    h.canvas.events[event](); h.setTime(1000); h.hotbar.update(1000);
    h.window.events.keydown({code:"KeyR",preventDefault(){}});assert.equal(h.removals,0);
  }
  const h=harness();h.hotbar.update(0);h.canvas.events.pointermove({clientX:400,clientY:300});
  h.setObstacles([{distance:.1}]);h.window.events.keydown({code:"KeyR",preventDefault(){}});assert.equal(h.removals,0);
  h.setObstacles([]);h.workshop.getState().objects[0].editable=false;
  h.window.events.keydown({code:"KeyR",preventDefault(){}});assert.equal(h.removals,0);
});

test("wheel affects only an editable held draft; UI, XR, committed and camera gestures are safe",async()=>{
  const h=harness();await h.selectDraft();h.workshop.group.children=[];h.setGround([{}]);
  let prevented=0,stopped=0;const wheel={deltaY:-100,deltaMode:0,clientX:400,clientY:300,preventDefault(){prevented++;},stopImmediatePropagation(){stopped++;}};
  h.canvas.events.wheel(wheel);assert.equal(h.adjustments,0);h.hotbar.update(16);assert.equal(h.adjustments,1);assert.equal(prevented,1);assert.equal(stopped,1);
  assert.ok(Math.abs(h.workshop.getState().current.scale[0]-1.1)<1e-12);
  for(const set of [v=>h.setMenu(v),v=>h.setXR(v),v=>h.setXRPending(v),v=>h.setPicking(v),v=>h.setLooking(v),v=>{h.workshop.getState().current.committed=v;},v=>{h.setEditable(!v);}]) {
    set(true);h.canvas.events.wheel(wheel);set(false);assert.equal(h.adjustments,1);
  }
  h.canvas.events.wheel({...wheel,ctrlKey:true});assert.equal(h.adjustments,1);assert.equal(prevented,1);
});

test("trackpad bursts perform one combined scale and position validation per frame",async()=>{
  const h=harness();await h.selectDraft();h.workshop.group.children=[];h.setGround([{}]);
  const wheel={deltaY:-10,clientX:400,clientY:300,preventDefault(){},stopImmediatePropagation(){}};
  for(let i=0;i<10;i++)h.canvas.events.wheel(wheel);
  assert.equal(h.adjustments,0);h.hotbar.update(16);assert.equal(h.adjustments,1);assert.equal(h.moves,0);
  assert.ok(Math.abs(h.workshop.getState().current.scale[0]-1.1)<1e-12);
  assert.deepEqual([...h.workshop.getState().current.position],[0,0,0]);
  h.canvas.events.wheel(wheel);h.window.events.blur();h.hotbar.update(32);assert.equal(h.adjustments,1);
  h.canvas.events.wheel(wheel);h.document.hidden=true;h.document.events.visibilitychange();h.document.hidden=false;
  h.hotbar.update(40);assert.equal(h.adjustments,1);
  h.canvas.events.wheel(wheel);h.workshop.getState().current.id='different-draft';h.hotbar.update(48);assert.equal(h.adjustments,1);
});

test("detailed picking and pending XR own input and discard queued wheel changes",async()=>{
  for(const setGate of ['setPicking','setXRPending']) {
    const h=harness();await h.selectDraft();h.setGround([{distance:10}]);
    h.canvas.events.pointermove({clientX:400,clientY:300});
    h.canvas.events.wheel({deltaY:-100,clientX:400,clientY:300,preventDefault(){},stopImmediatePropagation(){}});
    h[setGate](true);assert.equal(h.hotbar.pointerContext().mode,'blocked');
    h.canvas.events.pointerdown({button:0,pointerType:'mouse',clientX:400,clientY:300});
    await h.hotbar.place({clientX:400,clientY:300});h.window.events.keydown({code:'KeyR',preventDefault(){}});
    h.hotbar.update(16);h[setGate](false);h.hotbar.update(32);
    assert.equal(h.adjustments,0);assert.equal(h.commits,0);assert.equal(h.removals,0);
  }
});
test("browser number shortcuts with Ctrl, Meta or Alt are not captured",()=>{
  const h=harness(); let prevented=0;
  for(const modifier of ["ctrlKey","metaKey","altKey"]) {
    h.window.events.keydown({code:"Digit0",[modifier]:true,preventDefault(){prevented++;}});
  }
  assert.equal(prevented,0); assert.equal(h.calls,0);
});

test("held STL places on visible terrain only, never sky or occluded ground",async()=>{
  const h=harness(), event={clientX:400,clientY:300};await h.selectDraft();
  // Ignore existing fixture object for the unoccluded terrain case.
  h.workshop.group.children=[];
  await h.hotbar.place(event);assert.equal(h.commits,0);
  h.setGround([{distance:10}]);assert.equal(h.hotbar.pointerContext(event).mode,"place");
  h.setObstacles([{distance:5}]);await h.hotbar.place(event);assert.equal(h.commits,0);
  h.setObstacles([]);h.workshop.group.children=[{userData:{},distance:4}];
  await h.hotbar.place(event);assert.equal(h.commits,0);
  h.workshop.group.children=[{userData:{isDraft:true},distance:4}];
  assert.equal(h.hotbar.pointerContext(event).mode,"place");
  for(const invalid of [{clientX:NaN,clientY:100},{clientX:900,clientY:100}]) {await h.hotbar.place(invalid);assert.equal(h.commits,0);}
  h.setXR(true);assert.equal(h.hotbar.pointerContext(event).mode,"blocked");
  h.setXR(false);h.setEditable(false);assert.equal(h.hotbar.pointerContext(event),null);
  h.setEditable(true);h.workshop.group.children=[];await h.hotbar.place(event);assert.equal(h.commits,1);
});
