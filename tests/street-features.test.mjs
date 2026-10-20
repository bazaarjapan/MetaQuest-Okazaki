import test from 'node:test';
import assert from 'node:assert/strict';
import {radarPoint} from '../src/world-radar.js';
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
