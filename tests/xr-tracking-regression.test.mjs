import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import * as THREE from "three";
import { stickAxes, updateFlight, resetFlight, createFlightState } from "../src/motion.js";
import * as navigation from "../src/xr-navigation.js";

// Exercise the actual main.js input/heading functions, not a duplicate model.
const main = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const functions = main.slice(main.indexOf("function syncButtons(session)"), main.indexOf("function desktopMove(dt)"));
function fixture() {
  const sources = ["left","right"].map(handedness => ({handedness,gamepad:{axes:[0,0,0,0],buttons:Array.from({length:6},()=>({pressed:false}))}}));
  const session = {visibilityState:"visible",inputSources:sources};
  const rig = new THREE.Group(), camera = new THREE.PerspectiveCamera(); rig.add(camera);
  const state = {free:true,ready:true};
  const controllers = sources.map(source=>({visible:true,source}));
  const scope = { THREE, state, controllers, rig, camera, activityAllowed:true, simulationSeconds:0, xrExitPending:false,
    pendingXRView:null, xrMoveYaw:0, xrViewOrientation:new THREE.Quaternion(), xrPhysicalOrientation:new THREE.Quaternion(),
    renderer:{xr:{getSession:()=>session}}, previousButtons:new Map(), flight:createFlightState(), xrFlightStart:navigation.createXRFlightStart(),
    temp:new THREE.Vector3(), ...navigation, stickAxes,updateFlight,resetFlight,
    trackedControllerSource:controller=>controller.visible?controller.source:null,
    setFree:value=>{state.free=value;navigation.cancelXRFlightStart(scope.xrFlightStart);resetFlight(scope.flight);},
    cancelExitHold:()=>{}, exitHold:{},updateExitHold:()=>({progress:0}),vrReturnButton:{update:()=>{}},
    vrFieldPanel:{toggleExpanded:()=>{}}, returnTo2D:()=>{},goTo:()=>{},viewpoints:{},constrainPosition:()=>{}
  };
  vm.createContext(scope);vm.runInContext(functions,scope); scope.syncButtons(session);
  const pose={orientation:{x:0,y:0,z:0,w:1}};
  return {scope,state,controllers,sources,session,rig,pose,step:(value=pose)=>scope.xrMove(.01,100,value)};
}
test("actual XR loop does not treat B held through tracking loss as a new resume press", () => {
  for (const loss of ["head","controller","visibility","alignment"]) {
    const f=fixture(); f.sources[1].gamepad.axes[3]=-1;
    if(loss==="controller") f.controllers[0].visible=false;
    if(loss==="visibility") f.session.visibilityState="visible-blurred";
    if(loss==="alignment") { f.scope.pendingXRView={}; f.state.free=false; }
    f.sources[1].gamepad.buttons[5].pressed=true;
    f.step(loss==="head"?null:f.pose);
    assert.equal(f.state.free,false,loss); assert.equal(f.rig.position.length(),0,loss);
    f.controllers[0].visible=true; f.session.visibilityState="visible"; f.scope.pendingXRView=null;
    f.step(); assert.equal(f.state.free,false,loss);assert.equal(f.rig.position.length(),0,loss);
    f.sources[1].gamepad.buttons[5].pressed=false;f.step();
    f.sources[1].gamepad.buttons[5].pressed=true;f.step();
    assert.equal(f.state.free,true,loss);assert.ok(f.rig.position.length()>.1,loss);
  }
});
test("actual XR loop records horizontal gaze while paused before resuming with vertical gaze", () => {
  const f=fixture();f.state.free=false;
  const yaw=.7;
  f.step({orientation:new THREE.Quaternion().setFromEuler(new THREE.Euler(0,yaw,0,"YXZ"))});
  assert.ok(Math.abs(f.scope.xrMoveYaw-yaw)<1e-8);
  f.sources[1].gamepad.buttons[5].pressed=true;f.sources[1].gamepad.axes[3]=-1;
  f.step({orientation:new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI/2,yaw,0,"YXZ"))});
  assert.equal(f.state.free,true);
  assert.ok(Math.abs(f.rig.position.x + Math.sin(yaw)*.12)<1e-8);
  assert.ok(Math.abs(f.rig.position.z + Math.cos(yaw)*.12)<1e-8);
  assert.equal(f.rig.position.y,0);
});
