import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import * as THREE from 'three';
import {createSurfaceIndex,validatePlacement,placementFootprint} from '../src/placement.js';
import {createRegionalPlacementEnvironment} from '../src/placement-region.js';
import {REGION_SOURCE_HASHES,REGION_PLACEMENT_BOUNDS,parseDemText,applyDemTextHeight,decodeRegionMesh,createRegionPlacementLoader} from '../worker/regional-placement.mjs';
const source=new Float32Array([0,0,0,1,0,0,0,0,1]);
const candidate={positions:source,position:[1000,999,1000],rotation:[0,0,0],scale:[1,1,1]};
const plane=(x,z,w=2,y=15)=>new Float32Array([x,y,z,x,y,z+w,x+w,y,z,x+w,y,z,x,y,z+w,x+w,y,z+w]);

test('pinned regional manifests and global placement bounds match distributed source bytes',async()=>{
  for(const [file,hash] of Object.entries(REGION_SOURCE_HASHES)){
    const bytes=await readFile(new URL(`../public/region/${file}`,import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'),hash);
    const manifest=JSON.parse(bytes);if(file==='buildings.json')assert.deepEqual(manifest.bounds,REGION_PLACEMENT_BOUNDS);
    for(const tile of manifest.tiles)assert.ok(tile.bytes<2*1024*1024);
  }
});
test('multiple terrain tiles cover a footprint across a seam; holes still fail',()=>{
  const left=createSurfaceIndex(plane(999,999)),right=createSurfaceIndex(plane(1001,999));
  const c={...candidate,scale:[2,1,1]};
  const env={terrain:[left,right],obstacles:[],bounds:[990,990,1010,1010]};
  assert.equal(validatePlacement(c,env).valid,true);assert.equal(validatePlacement(c,env).position[1],15);
  assert.equal(validatePlacement(c,{...env,terrain:[left]}).valid,false);
  assert.throws(()=>placementFootprint({...c,scale:[200,1,1]}));
});
test('regional preview rejects unloaded buildings and uses actual terrain once all needed chunks exist',()=>{
  const core={terrain:createSurfaceIndex(plane(0,0)),obstacles:[],bounds:[0,0,2,2],terrainMeshes:[]};
  const geom=new THREE.BufferGeometry().setAttribute('position',new THREE.BufferAttribute(plane(999,999),3));
  const mesh=new THREE.Mesh(geom);mesh.userData={regionType:'terrain',regionTileId:'ground'};
  const building=new THREE.Mesh(new THREE.BufferGeometry().setAttribute('position',new THREE.BufferAttribute(plane(1001.5,1001.5,.2,20),3)));
  building.userData={regionType:'building',regionTileId:'buildings'};
  let meshes=[mesh];
  const manifest={bounds:[990,990,1010,1010],tiles:[{id:'ground',type:'terrain',bounds:[999,999,1002,1002]},{id:'buildings',type:'building',bounds:[999,999,1002,1002]}]};
  const env=createRegionalPlacementEnvironment({getCore:()=>core,getManifest:()=>manifest,getMeshes:()=>meshes});
  assert.match(validatePlacement(candidate,env(candidate)).error,/still loading/);
  meshes=[mesh,building];assert.equal(validatePlacement(candidate,env(candidate)).valid,true);
  meshes=[mesh];assert.equal(validatePlacement(candidate,env(candidate)).valid,false);
});
test('DEM text strictly parses missing values, dimensions and rejects blank/fabricated samples',()=>{
  const row=Array(256).fill('12.34');row[0]='e';
  const text=Array(256).fill(row.join(',')).join('\n'),parsed=parseDemText(text);
  assert.ok(Number.isNaN(parsed[0]));assert.equal(parsed[1],12.34);
  assert.throws(()=>parseDemText('1,2'));assert.throws(()=>parseDemText(text.replace('12.34','')));
});
test('text DEM interpolation shares adjacent border samples and fails closed on missing height',async()=>{
  const tile={zoom:14,x:14435,y:6493,heightMode:'live-gsi-dem',demUrl:'https://cyberjapandata.gsi.go.jp/xyz/dem_png/14/14435/6493.png'};
  const mesh={positions:new Float32Array(9),uv:new Float32Array([1,0,0,1,.5,.5])};
  const getDem=async(x,y)=>new Float64Array(65536).fill(x-14435+(y-6493)*10+25);
  await applyDemTextHeight(mesh,tile,getDem);assert.deepEqual([mesh.positions[1],mesh.positions[4],mesh.positions[7]],[36,25,25]);
  await assert.rejects(applyDemTextHeight(mesh,tile,async()=>new Float64Array(65536).fill(NaN)),/unavailable/);
});
test('authoritative region loader loads verified geometry, validates real buildings and refuses DEM failure',async()=>{
  const binding={async fetch(request){
    const url=new URL(request.url);try{return new Response(await readFile(new URL(`../public${url.pathname}`,import.meta.url)));}catch{return new Response('',{status:404});}
  }};
  const text=Array(256).fill(Array(256).fill('25').join(',')).join('\n');let calls=0;
  const loader=createRegionPlacementLoader(binding,{fetchImpl:async url=>{calls++;assert.match(url,/^https:\/\/cyberjapandata.gsi.go.jp\/xyz\/dem\/14\/\d+\/\d+\.txt$/);return new Response(text);}});
  const env=await loader(candidate);assert.ok(Array.isArray(env.terrain));assert.ok(calls>0);
  const result=validatePlacement(candidate,env);assert.ok(result.valid||/overlaps/.test(result.error));
  if(result.valid)assert.equal(result.position[1],25);
  const failLoader=createRegionPlacementLoader(binding,{fetchImpl:async()=>new Response('',{status:503})});
  await assert.rejects(failLoader(candidate),error=>error.code==='placement_source_unavailable');
  const badBinding={fetch:async req=>new URL(req.url).pathname.startsWith('/region/')?new Response('corrupt'):binding.fetch(req)};
  await assert.rejects(createRegionPlacementLoader(badBinding)(candidate),error=>error.code==='placement_source_unavailable');
});
