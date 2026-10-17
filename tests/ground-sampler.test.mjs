import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as THREE from 'three';
import {createTerrainSampler} from '../src/ground-sampler.js';
function mesh(height=10){
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute([0,height,0,0,height,10,10,height,0],3));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array([0,1,2]),1));return new THREE.Mesh(g,new THREE.MeshStandardMaterial());
}
test('stationary height caches invalidate when missing DEM arrives, updates or evicts',()=>{
  let meshes=[];const sample=createTerrainSampler(()=>meshes);
  assert.equal(sample(1,1),null);const ground=mesh();meshes=[ground];assert.equal(sample(1,1),10);
  const queries=sample.getState().queries;for(let i=0;i<120;i++)assert.equal(sample(1,1),10);
  assert.equal(sample.getState().queries,queries);
  const p=ground.geometry.attributes.position;for(let i=0;i<p.count;i++)p.setY(i,20);p.needsUpdate=true;
  assert.equal(sample(1,1),20);assert.equal(sample(20,20),null);meshes=[];assert.equal(sample(1,1),null);
});
test('indexed sampler matches actual downward Three ray on distributed PLATEAU terrain',async()=>{
  const root=new URL('../public/city/',import.meta.url),manifest=JSON.parse(await readFile(new URL('manifest.json',root),'utf8'));
  const info=manifest.parts.find(p=>p.texture==='Texture-001.png'),bytes=await readFile(new URL(info.file,root));
  const buffer=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),n=info.vertices;
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(new Float32Array(buffer,0,n*3),3));
  geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(buffer,n*32,info.indices),1));
  const terrain=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial());terrain.updateMatrixWorld(true);
  const sampler=createTerrainSampler(()=>[terrain]),ray=new THREE.Raycaster();
  let hits=0;
  for(let z=-300;z<=300;z+=60)for(let x=-250;x<=250;x+=50){
    ray.set(new THREE.Vector3(x,2500,z),new THREE.Vector3(0,-1,0));const expected=ray.intersectObject(terrain,false)[0]?.point.y??null;
    const actual=sampler(x,z);if(expected===null)assert.equal(actual,null);else{hits++;assert.ok(Math.abs(actual-expected)<1e-5,`${x},${z}: ${actual} vs ${expected}`);}
  }
  assert.ok(hits>25);assert.equal(sampler.getState().builds,1);
});
