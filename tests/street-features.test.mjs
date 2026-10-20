import test from 'node:test';
import assert from 'node:assert/strict';
import {radarPoint,radarPeople} from '../src/world-radar.js';
import {sceneryCandidates,sceneryLimits,createStreetScenery} from '../src/street-scenery.js';
import {validExhibitText} from '../src/workshop-presentation.js';
import * as THREE from 'three';
import {createSurfaceIndex} from '../src/placement.js';
test('radar rotates relative to heading and clamps distant items without losing their distance',()=>{
 const origin={x:10,z:20};
 assert.deepEqual(radarPoint(origin,[10,999,-80],0,100),{x:0,y:-76,distance:100,edge:false});
 const west=radarPoint(origin,[-90,0,20],Math.PI/2,100);assert.ok(Math.abs(west.x)<1e-10);assert.equal(west.y,-76);
 const far=radarPoint(origin,[3010,0,4020],0,100);assert.equal(far.distance,5000);assert.equal(far.edge,true);assert.ok(Math.abs(Math.hypot(far.x,far.y)-76)<1e-8);
 assert.equal(radarPoint(origin,[10,0,20],0,100).distance,0);
});
test('radar uses participant roles, omits self and invalid poses, follows movement and departures',()=>{
 const origin={x:0,z:0},student={id:'student',role:'student',position:[100,0,0]},teacher={id:'teacher',role:'teacher',position:[0,10,-500]};
 const people=[student,teacher,{id:'self',role:'teacher',position:[0,0,0]},
  {id:'bad',role:'student',position:[NaN,0,0]},{id:'unknown',role:'admin',position:[0,0,0]}];
 const first=radarPeople(people,'self',origin,0,300);
 assert.deepEqual(first.map(p=>[p.id,p.color]),[['student','#70d6ff'],['teacher','#d9a1ff']]);
 assert.equal(first[1].edge,true);assert.equal(first[1].y,-76);assert.equal(first[1].distance,500);
 const moved=radarPeople([{...student,position:[-100,0,0]}],'self',origin,Math.PI/2,300);
 assert.equal(moved.length,1);assert.ok(Math.abs(moved[0].x)<1e-10);assert.ok(moved[0].y<0);
 assert.deepEqual(radarPeople([],'self',origin,0,300),[]);
});
test('exhibit metadata is bounded and accepts ordinary text as text',()=>{
 assert.equal(validExhibitText('私の駅','<script>text</script>'),true);
 for(const pair of [[null,''],['x'.repeat(41),''],['','x'.repeat(241)],['bad\u0000',''],['',{}]])assert.equal(validExhibitText(...pair),false);
});
test('scenery remains bounded, refuses unavailable terrain, and disappears in photo/performance modes',()=>{
 assert.equal(sceneryCandidates([[500,0,0],[30,0,0],[10,0,0]],{x:0,z:0},1).length,2);
 const scene=new THREE.Scene();let environment={error:'terrain unavailable'};
 const scenery=createStreetScenery({scene,getEnvironment:()=>environment});scenery.setData({trees:[[0,0,0]],signals:[[10,0,0]]});
 const update=(time,changes={})=>scenery.update({position:{x:0,z:0},quality:'high',enabled:true,time,...changes});
 update(0);assert.equal(scenery.getState().trees,0);
 const terrain=createSurfaceIndex(new Float32Array([-50,0,-50,50,0,50,50,0,-50,-50,0,-50,-50,0,50,50,0,50]));
 environment={terrain,obstacles:[],bounds:[-50,-50,50,50]};update(2000);
 assert.equal(scenery.getState().trees,1);assert.equal(scenery.getState().signals,1);
 update(4000,{objects:[{id:'work',bounds:{min:[-2,0,-2],max:[2,0,2]}}]});assert.equal(scenery.getState().trees,0);
 update(5000,{enabled:false});assert.equal(scenery.getState().visible,false);
 update(6000,{quality:'performance'});assert.equal(scenery.getState().visible,false);assert.deepEqual(sceneryLimits.performance,[0,0]);
 scenery.dispose();assert.equal(scene.children.length,0);
});
