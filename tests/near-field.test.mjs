import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {createHash} from 'node:crypto';
import {clipTerrainUV,chooseNearField,createNearField} from '../src/near-field.js';
import {textureMemoryBytes} from '../src/quality.js';

function source(id='g0',x=0){
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute([x,10,10,x+10,20,10,x+10,30,0,x,20,0],3));
  geometry.setAttribute('normal',new THREE.Float32BufferAttribute([0,1,0,0,1,0,0,1,0,0,1,0],3));
  geometry.setAttribute('uv',new THREE.Float32BufferAttribute([0,0,1,0,1,1,0,1],2));geometry.setIndex([0,1,2,0,2,3]);
  const mesh=new THREE.Mesh(geometry,new THREE.MeshStandardMaterial());mesh.userData.regionTileId=id;return mesh;
}
const content=new TextEncoder().encode('fixture bytes'),sha=createHash('sha256').update(content).digest('hex');
const entry=(id='g0')=>({file:'near-'+id+'.webp',width:2048,height:2048,bytes:content.length,sha256:sha});
const manifest={near:{core:[],region:{g0:entry(),g1:entry('g1')}}};
const settle=async()=>{for(let i=0;i<15;i++)await new Promise(r=>setTimeout(r,2));};
test('UV clipping follows existing slope, covers exact rectangle and preserves source data',()=>{
  const mesh=source(),g=mesh.geometry,a=g.attributes,before=[...a.position.array];
  const clipped=clipTerrainUV(a.position.array,a.normal.array,a.uv.array,g.index.array,[.25,.25,.75,.75]);
  assert.deepEqual([...a.position.array],before);assert.deepEqual(clipped.bounds,[2.5,2.5,7.5,7.5]);
  assert.ok(clipped.uv.every(v=>v>=0&&v<=1));
  for(let i=0;i<clipped.positions.length;i+=3){const [x,y,z]=clipped.positions.slice(i,i+3);assert.ok(Math.abs(y-(20+x-z))<1e-6);}
});
test('far and performance disable detail; core patch and spatial seam selection are deterministic',()=>{
  const a={id:'a',positions:[1],bounds:[0,0,10,10],heightRange:[0,0]},b={...a,id:'b',bounds:[10,0,20,10]};
  assert.equal(chooseNearField([a,b],[5,20,5]).id,'a');
  assert.equal(chooseNearField([a,b],[15,20,5]).id,'b');
  assert.equal(chooseNearField([a,b],[5,700,5]),null);assert.equal(chooseNearField([a],[5,20,5],'performance'),null);
});
test('near GPU reservation plus eight far textures stays below the existing regional32MiB cap',()=>{
  assert.ok(textureMemoryBytes(2048,2048)+8*textureMemoryBytes(512,512)<=32*1024*1024);
});
test('real Three geometry overlay loads, downsamples balanced, swaps and disposes without touching ground',async()=>{
  const old=globalThis.createImageBitmap,bitmaps=[];
  globalThis.createImageBitmap=async(blob,options)=>{const b={width:options.resizeWidth,height:options.resizeHeight,closed:false,close(){this.closed=true;}};bitmaps.push(b);return b;};
  const near=createNearField(THREE,{fetchImpl:async()=>({ok:true,arrayBuffer:async()=>content.buffer})}),ground=source();
  try{
    near.update({position:[5,30,5],manifest,terrain:[ground],time:0});await settle();
    assert.equal(near.getState().resident,1);assert.equal(near.getState().source,'g0');
    assert.equal(ground.children[0].material.map.image.width,2048);assert.equal(ground.children[0].geometry.index,null);
    near.update({position:[5,30,5],quality:'balanced',manifest,terrain:[ground],time:700});await settle();
    assert.equal(bitmaps[0].closed,true);assert.equal(ground.children[0].material.map.image.width,1024);
    near.update({position:[5,30,5],enabled:false,manifest,terrain:[ground],time:1400});
    assert.equal(ground.children.length,0);assert.ok(bitmaps.every(b=>b.closed));assert.equal(ground.geometry.attributes.position.count,4);
  }finally{near.dispose();globalThis.createImageBitmap=old;}
});
test('image hash failure preserves original ground and backs off requests',async()=>{
  const near=createNearField(THREE,{fetchImpl:async()=>({ok:true,arrayBuffer:async()=>new Uint8Array([1]).buffer})}),ground=source();
  near.update({position:[5,30,5],manifest,terrain:[ground],time:0});await settle();
  assert.equal(near.getState().resident,0);assert.equal(near.getState().errors,1);assert.equal(ground.children.length,0);
  near.update({position:[5,30,5],manifest,terrain:[ground],time:700});await settle();assert.equal(near.getState().requested,1);near.dispose();
});
test('late decode after teleport or mode switch is closed; requests remain serialized',async()=>{
  const old=globalThis.createImageBitmap;let resolveDecode,closed=false,calls=0;
  globalThis.createImageBitmap=async()=>{calls++;return new Promise(resolve=>{resolveDecode=()=>resolve({width:2048,height:2048,close(){closed=true;}});});};
  const near=createNearField(THREE,{fetchImpl:async()=>({ok:true,arrayBuffer:async()=>content.buffer})}),ground=source();
  try{
    near.update({position:[5,30,5],manifest,terrain:[ground],time:0});await settle();assert.equal(calls,1);
    near.update({position:[5000,800,5000],manifest,terrain:[],time:700});resolveDecode();await settle();
    assert.equal(closed,true);assert.equal(near.getState().resident,0);assert.equal(ground.children.length,0);
  }finally{near.dispose();globalThis.createImageBitmap=old;}
});
