import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import * as THREE from "three";
const source=(await readFile(new URL("../src/hotbar.js",import.meta.url),"utf8")).replace(/^import .*;\r?\n/gm,"").replace(/^export /gm,"");
const api=vm.runInNewContext(source+"\n({hotbarSlot,retrievalHoldMs})");
test("number row 1 through 0 maps exactly to ten distinct slots",()=>{
  assert.deepEqual([1,2,3,4,5,6,7,8,9,0].map(n=>api.hotbarSlot(`Digit${n}`)),[0,1,2,3,4,5,6,7,8,9]);
  for(const key of ["KeyW","Escape","Digit10","Numpad1","F5",""]) assert.equal(api.hotbarSlot(key),-1);
});
test("retrieval requires a deliberate hold, not an ordinary right click",()=>{
  assert.equal(api.retrievalHoldMs,700);
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
  const document={createElement:()=>new Node(),querySelector:()=>null,pointerLockElement:null};
  const window=new Node();
  let xr=false, calls=0, now=0, removals=0;
  const object={id:"object",assetId:"asset",editable:true,committed:true};
  const workshop={group:{children:[{userData:{creationId:"object"}}]},
    getState(){calls++;return {userId:"student",worldId:"world",canEdit:true,ownAssets:[],objects:[object]};},
    selectObject(){},async removeSelected(){removals++;return true;}};
  class Raycaster extends THREE.Raycaster {
    intersectObjects(objects) { return objects.length ? [{object:objects[0],distance:1}] : []; }
  }
  const context=vm.createContext({THREE:{...THREE,Raycaster},document,window,performance:{now:()=>now}});
  const factory=vm.runInContext(source+"\ncreateHotbar",context);
  const hotbar=factory({workshop,client:{getState(){calls++;return {user:null};}},camera:new THREE.PerspectiveCamera(),canvas,
    scene:new THREE.Scene(),getEnvironment:()=>({terrainMeshes:[]}),isXR:()=>xr,menu:{getState:()=>({open:false})}});
  return {hotbar,canvas,window,setXR:value=>{xr=value;},setTime:value=>{now=value;},get calls(){return calls;},get removals(){return removals;}};
}
test("hidden VR hotbar performs no school or workshop snapshot allocations",()=>{
  const h=harness(); h.setXR(true);
  for(let frame=0;frame<100;frame++) h.hotbar.update(frame*16);
  assert.equal(h.calls,0); assert.equal(h.hotbar.getState().hold,null);
});
test("leaving canvas or losing pointer cancels a right-hold retrieval without deleting",()=>{
  for(const event of ["pointerleave","pointercancel"]) {
    const h=harness(); h.hotbar.update(0);
    h.canvas.events.pointerdown({button:2,pointerType:"mouse",clientX:400,clientY:300,preventDefault(){}});
    assert.equal(h.hotbar.getState().hold,"object");
    h.canvas.events[event](); h.setTime(1000); h.hotbar.update(1000);
    assert.equal(h.hotbar.getState().hold,null); assert.equal(h.removals,0);
  }
});
test("browser number shortcuts with Ctrl, Meta or Alt are not captured",()=>{
  const h=harness(); let prevented=0;
  for(const modifier of ["ctrlKey","metaKey","altKey"]) {
    h.window.events.keydown({code:"Digit0",[modifier]:true,preventDefault(){prevented++;}});
  }
  assert.equal(prevented,0); assert.equal(h.calls,0);
});
