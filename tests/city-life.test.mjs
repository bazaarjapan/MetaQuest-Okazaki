import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {roadJunctions,crossingLayout,joinedRoutes} from '../scripts/lib/street-layout.mjs';
import {makeRoute,sampleRoute,routeTravel,nearestRoutePoint,createAmbientTraffic,trafficLimits} from '../src/ambient-traffic.js';
import {trafficSignalState,createStreetScenery} from '../src/street-scenery.js';
import {createSurfaceIndex} from '../src/placement.js';
import {readSoundSettings,movementSoundProfile,createMovementAudio} from '../src/movement-audio.js';

test('junctions require three distinct branches; duplicate roads and seams do not create signals',()=>{
  const road=(line,width=12)=>({line,width});
  const straight=[road([[-30,0],[0,0]]),road([[0,0],[30,0]]),road([[-30,0],[0,0]])];
  assert.equal(roadJunctions(straight).length,0);
  const junctions=roadJunctions([...straight,road([[0,0],[0,30]],6)]);assert.equal(junctions.length,1);assert.equal(junctions[0].branches.length,3);
  for(const crossing of crossingLayout(junctions[0]))assert.ok(Math.hypot(...crossing.center)>junctions[0].radius);
  assert.equal(roadJunctions(straight.map(r=>({...r,width:4})).concat(road([[0,0],[0,30]],4))).length,0);
});

test('routes join real shared endpoints and interpolate both directions without leaving the source line',()=>{
  const joined=joinedRoutes([[[0,0],[100,0]],[[100,0],[200,0]],[[900,0],[1000,0]]],{minimum:150,limit:10});
  assert.equal(joined.length,1);const route=makeRoute(joined[0]);assert.equal(route.length,200);
  assert.deepEqual(sampleRoute(route,75),{x:75,z:0,angle:Math.PI/2});
  assert.equal(sampleRoute(route,75,1.6).z,-1.6);
  assert.deepEqual(nearestRoutePoint(route,{x:75,z:20}),{distance:20,along:75});
  assert.deepEqual(routeTravel(route,0,10,10),{distance:10,reverse:false});
  assert.deepEqual(routeTravel(route,20,10,10),{distance:170,reverse:true});
  assert.equal(makeRoute([[0,0],[NaN,1]]),null);assert.equal(makeRoute([[0,0],[0,0]]),null);
});

test('a terrain replacement or new STL invalidates every vehicle before drawing a new position',()=>{
  const scene=new THREE.Scene();let env=environment();const traffic=createAmbientTraffic({scene,getEnvironment:()=>env});
  traffic.setData({roads:Array.from({length:10},(_,i)=>[[-30,i*5],[30,i*5]]),rails:[]});
  const update=(time,terrainVersion,objects=[])=>traffic.update({position:{x:0,z:20},quality:'high',active:true,time,terrainVersion,objects});
  for(let t=0;t<200;t+=10)update(t,'ready');assert.equal(traffic.getState().cars,10);
  env={error:'tile removed'};update(210,'missing');assert.equal(traffic.getState().cars,0);
  env=environment();for(let t=220;t<400;t+=10)update(t,'new');assert.equal(traffic.getState().cars,10);
  update(410,'new',[{id:'new-work',bounds:{min:[-100,-1,-100],max:[100,10,100]}}]);assert.equal(traffic.getState().cars,0);
  traffic.dispose();
});

test('perpendicular signals alternate with an all-red clearance interval',()=>{
  assert.equal(trafficSignalState(0,Math.PI/2),'green');assert.equal(trafficSignalState(0,0),'red');
  assert.equal(trafficSignalState(13000,Math.PI/2),'amber');
  assert.equal(trafficSignalState(15500,Math.PI/2),'red');assert.equal(trafficSignalState(15500,0),'red');
  assert.equal(trafficSignalState(17000,Math.PI/2),'red');assert.equal(trafficSignalState(17000,0),'green');
});

function environment(){return {terrain:createSurfaceIndex(new Float32Array([-100,0,-100,100,0,100,100,0,-100,-100,0,-100,-100,0,100,100,0,100])),obstacles:[],bounds:[-100,-100,100,100]};}
test('traffic refuses missing ground, remains bounded, avoids pupils work and pauses when disabled',()=>{
  const scene=new THREE.Scene();let env={error:'missing terrain'};
  const traffic=createAmbientTraffic({scene,getEnvironment:()=>env});traffic.setData({roads:[[[-20,0],[20,0]]],rails:[[[-20,10],[20,10]] ]});
  const update=(time,changes={})=>traffic.update({position:{x:0,z:0},quality:'high',active:true,time,terrainVersion:env.error?'missing':'ready',...changes});
  update(0);assert.equal(traffic.getState().cars,0);assert.equal(traffic.getState().trainCarriages,0);
  env=environment();for(let t=10;t<100;t+=10)update(t);
  assert.equal(traffic.getState().cars,1);assert.ok(traffic.getState().trainCarriages>0);assert.ok(traffic.getState().terrainChecks<=4);
  for(let t=100;t<200;t+=10)update(t,{objects:[{bounds:{min:[-100,-1,-100],max:[100,10,100]}}]});
  assert.equal(traffic.getState().cars,0);assert.equal(traffic.getState().trainCarriages,0);
  const clock=traffic.getState().clock;update(300,{active:false});update(400,{active:false});assert.equal(traffic.getState().clock,clock);
  update(500,{quality:'performance'});assert.equal(traffic.getState().enabled,false);assert.deepEqual(trafficLimits.performance,[0,0,0]);
  traffic.dispose();assert.equal(scene.children.length,0);
});

test('new grass and streetlights require real terrain and never overlap a placed STL',()=>{
  const scene=new THREE.Scene(),scenery=createStreetScenery({scene,getEnvironment:environment});scenery.setData({trees:[],signals:[],grass:[[0,0,0]],lights:[[10,0,0]]});
  const update=(time,objects=[])=>scenery.update({position:{x:0,z:0},quality:'high',enabled:true,time,objects});
  update(0);assert.equal(scenery.getState().grass,1);assert.equal(scenery.getState().lights,1);
  update(2000,[{id:'work',bounds:{min:[-3,0,-3],max:[3,10,3]}}]);assert.equal(scenery.getState().grass,0);assert.equal(scenery.getState().lights,1);scenery.dispose();
});

test('movement sound only plays on ground contact or moving flight, with bounded gain',()=>{
  assert.equal(movementSoundProfile({active:true,grounded:true,flying:false,speed:4}).mode,'steps');
  assert.equal(movementSoundProfile({active:true,grounded:false,flying:false,speed:4}).mode,'silent');
  assert.equal(movementSoundProfile({active:false,grounded:false,flying:true,boosting:true,speed:80}).jet,0);
  assert.equal(movementSoundProfile({active:true,grounded:false,flying:true,speed:0}).mode,'silent');
  assert.equal(movementSoundProfile({active:true,grounded:false,flying:true,boosting:true,speed:80}).mode,'jet');
  assert.ok(movementSoundProfile({active:true,flying:true,boosting:true,speed:1000}).jet<=.42);
  assert.deepEqual(readSoundSettings({getItem(){throw Error();}}),{enabled:true,volume:.35});
  assert.deepEqual(readSoundSettings({getItem:()=>'{"enabled":false,"volume":20}'}),{enabled:false,volume:1});
});

test('blocked localStorage never prevents audio or app creation',()=>{
  const original=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
  try{Object.defineProperty(globalThis,'localStorage',{configurable:true,get(){throw Error('denied');}});const audio=createMovementAudio({storage:undefined,eventTarget:new EventTarget()});assert.equal(audio.getState().unlocked,false);audio.dispose();}
  finally{if(original)Object.defineProperty(globalThis,'localStorage',original);else delete globalThis.localStorage;}
});

test('audio creates no context before a gesture, respects permission and mute, and resumes quietly',async()=>{
  let contexts=0,allowed=false;const nodes=[];
  const param=()=>({value:0,setValueAtTime(v){this.value=v;},setTargetAtTime(v){this.value=v;},linearRampToValueAtTime(v){this.value=v;},exponentialRampToValueAtTime(v){this.value=v;},cancelScheduledValues(){}});
  const node=()=>{const n={gain:param(),frequency:param(),playbackRate:param(),connect(){},disconnect(){},start(){},stop(){}};nodes.push(n);return n;};
  const context={state:'suspended',currentTime:0,sampleRate:8000,destination:{},createGain:node,createBufferSource:node,createBiquadFilter:node,createOscillator:node,createBuffer:(channels,size)=>({getChannelData:()=>new Float32Array(size)}),async resume(){this.state='running';},async close(){this.state='closed';}};
  const audio=createMovementAudio({storage:null,eventTarget:new EventTarget(),isAllowed:()=>allowed,contextFactory:()=>{contexts++;return context;}});
  audio.update({time:0,position:[0,0,0],active:true,grounded:true});assert.equal(contexts,0);assert.equal(await audio.unlock(),false);
  allowed=true;assert.equal(await audio.unlock(),true);assert.equal(contexts,1);
  audio.update({time:100,position:[.4,0,0],active:true,grounded:true});assert.equal(audio.getState().steps,1);
  audio.setSettings({enabled:false});assert.equal(nodes[0].gain.value,0);
  audio.update({time:200,position:[4,0,0],active:true,flying:true,boosting:true});assert.equal(audio.getState().jetGain,0);
  audio.setSettings({enabled:true});audio.update({time:300,position:[4,0,0],active:true,flying:true});assert.equal(audio.getState().jetGain,0);
  await audio.unlock();context.state='suspended';assert.equal(await audio.unlock(),true);assert.equal(context.state,'running');
  audio.dispose();assert.equal(context.state,'closed');
});
