import test from 'node:test';
import assert from 'node:assert/strict';
import {radarPoint,radarPeople} from '../src/world-radar.js';
import {sceneryCandidates,sceneryLimits,createStreetScenery} from '../src/street-scenery.js';
import {validExhibitText} from '../src/workshop-presentation.js';
import * as THREE from 'three';
import {createSurfaceIndex} from '../src/placement.js';
import {exhibitLabelWidth,exhibitDescriptionLines,createExhibitLabels} from '../src/exhibit-labels.js';
import {cityFogRange} from '../src/city-atmosphere.js';

test('near exhibit descriptions wrap unicode safely and keep plates bounded',()=>{
 assert.deepEqual(exhibitDescriptionLines('駅の作品です'),['駅の作品です']);
 assert.equal(exhibitDescriptionLines('😀'.repeat(100)).length,4);
 assert.ok(exhibitDescriptionLines('あ'.repeat(240)).at(-1).endsWith('…'));
 assert.deepEqual(exhibitDescriptionLines(null),[]);
});
test('day and evening haze keep nearby work clear and hide the streaming edge',()=>{
 for(const r of [1800,2400,3200]){
  const day=cityFogRange(r),evening=cityFogRange(r,true);assert.ok(day.near>=500&&day.near<=900);assert.ok(evening.near<day.near);assert.equal(day.far,r+500);
 }
});
test('near plates expand safely and dispose the resized texture when moving away',()=>{
 const previous=globalThis.document,ctx={clearRect(){},fillRect(){},fillText(){}};
 globalThis.document={createElement:()=>({getContext:()=>ctx})};
 const scene=new THREE.Scene(),labels=createExhibitLabels(scene),camera=new THREE.PerspectiveCamera(55,1,.1,1000);
 camera.position.set(0,5,10);camera.lookAt(0,1,0);camera.updateMatrixWorld();
 const object={id:'work',title:'光の駅',authorName:'作者',description:'みんなが集まる駅です。',position:[0,0,0],bounds:{min:[-1,0,-1],max:[1,2,1]}};
 try{
  labels.update({objects:[object],position:{x:0,z:3},time:0,camera,viewportHeight:800,maxPixels:300});
  const sprite=scene.children[0],projected=sprite.position.clone().project(camera),depth=sprite.position.clone().sub(camera.position).dot(camera.getWorldDirection(new THREE.Vector3())),halfHeight=sprite.scale.y*camera.projectionMatrix.elements[5]/(2*depth);
  assert.ok(projected.y+halfHeight<=1-280/800+1e-6,'near plate is below the top HUD');
  assert.ok(projected.y-halfHeight>=-1+260/800-1e-6,'near plate stays above the hotbar');
  assert.equal(sprite.material.depthTest,false,'near information card stays readable over its model');
  assert.equal(labels.getState().expanded,1);const texture=scene.children[0].material.map;let disposed=false;texture.addEventListener('dispose',()=>disposed=true);
  labels.update({objects:[object],position:{x:0,z:30},time:500,camera,viewportHeight:800,maxPixels:300});
  assert.equal(labels.getState().expanded,0);assert.ok(disposed);assert.notEqual(scene.children[0].material.map,texture);assert.ok(labels.getState().maxScreenWidth<=220.001);
  labels.update({objects:[object],position:{x:0,z:3},time:1000,camera:null});
  assert.equal(scene.children[0].material.depthTest,true,'VR retains real-world occlusion');assert.equal(scene.children[0].renderOrder,0);
 }finally{labels.dispose();globalThis.document=previous;}assert.equal(scene.children.length,0);
});
test('exhibit labels cap their projected width at close range and preserve the world size limit',()=>{
 for(const height of [320,720,1400])for(const fov of [35,60,90])for(const depth of [.05,1,4,20,100]){
  const camera=new THREE.PerspectiveCamera(fov,1,0.01,1000),projectionY=camera.projectionMatrix.elements[5];
  const width=exhibitLabelWidth(depth,projectionY,height,220);
  const projected=width*projectionY*height/(2*depth);
  assert.ok(projected<=220+1e-8);assert.ok(width<=6&&width>0);
 }
 assert.equal(exhibitLabelWidth(-1,1,720),0);assert.equal(exhibitLabelWidth(1,1,0),0);
});
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
 const update=(time,changes={})=>scenery.update({position:{x:0,z:0},quality:'high',enabled:true,time,terrainVersion:environment,...changes});
 update(0);assert.equal(scenery.getState().trees,0);
 const terrain=createSurfaceIndex(new Float32Array([-50,0,-50,50,0,50,50,0,-50,-50,0,-50,-50,0,50,50,0,50]));
 environment={terrain,obstacles:[],bounds:[-50,-50,50,50]};update(2000);
 assert.equal(scenery.getState().trees,1);assert.equal(scenery.getState().signals,1);
 update(4000,{objects:[{id:'work',bounds:{min:[-2,0,-2],max:[2,0,2]}}]});assert.equal(scenery.getState().trees,0);
 update(5000,{enabled:false});assert.equal(scenery.getState().visible,false);
 update(6000,{quality:'performance'});assert.equal(scenery.getState().visible,false);assert.deepEqual(sceneryLimits.performance,[0,0]);
 scenery.dispose();assert.equal(scene.children.length,0);
});
