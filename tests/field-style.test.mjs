import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as THREE from 'three';
import {buildingColorBytes,buildingAttributes,readFieldStyle,gameTerrainFile,isCoreBuildingPart,createFieldBuildingMaterial,decorateBuildingGeometry} from '../src/field-style.js';
import {mapPoint,roadWidth,renderFieldSVG} from '../scripts/lib/field-map.mjs';

test('all four actual station building material groups are styled, never the terrain',async()=>{
  const manifest=JSON.parse(await readFile(new URL('../public/city/manifest.json',import.meta.url),'utf8'));
  assert.deepEqual(manifest.parts.filter(isCoreBuildingPart).map(p=>p.name),['Mesh-000','Mesh-001','Mesh-002','Mesh-003']);
  const main=await readFile(new URL('../src/main.js',import.meta.url),'utf8');
  assert.match(main,/const gameBuilding = isCoreBuildingPart\(p\)/);
});
test('small, black and photo-textured actual meshes gain colors without changing model arrays',async()=>{
  const root=new URL('../public/city/',import.meta.url),manifest=JSON.parse(await readFile(new URL('manifest.json',root),'utf8'));
  for(const p of manifest.parts.filter(isCoreBuildingPart)){
    const b=await readFile(new URL(p.file,root)),buffer=b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),g=new THREE.BufferGeometry();
    g.setAttribute('position',new THREE.BufferAttribute(new Float32Array(buffer,0,p.vertices*3),3));
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(buffer,p.vertices*32,p.indices),1));
    const before=Buffer.from(buffer).toString('base64');decorateBuildingGeometry(THREE,g);
    assert.equal(g.attributes.fieldColor.count,g.attributes.position.count,p.name);
    assert.equal(g.attributes.fieldSpan.count,g.attributes.position.count,p.name);
    assert.ok(g.attributes.fieldSpan.array.every(Number.isFinite),p.name);
    assert.ok(g.attributes.fieldColor.array.every(c=>c>0),p.name);
    assert.equal(Buffer.from(buffer).toString('base64'),before,p.name);g.dispose();
  }
});
test('shared shader bypasses original photos in game mode and retains photo/black source material',()=>{
  const map=new THREE.Texture(),uniform={value:1},material=createFieldBuildingMaterial(THREE,uniform,{map,color:0});
  const shader={uniforms:{},vertexShader:THREE.ShaderLib.standard.vertexShader,fragmentShader:THREE.ShaderLib.standard.fragmentShader};
  material.onBeforeCompile(shader);
  assert.match(shader.fragmentShader,/if\(fieldGame<\.5\)\{\s*#include <map_fragment>\s*\}/);
  assert.match(shader.fragmentShader,/if\(fieldGame>\.5\)/);
  assert.equal(shader.uniforms.fieldGame,uniform);assert.equal(material.map,map);assert.equal(material.color.getHex(),0);
  uniform.value=0;assert.equal(shader.uniforms.fieldGame.value,0);assert.equal(material.map,map);
  assert.equal(material.userData.fieldBuilding,true);assert.equal(material.customProgramCacheKey(),'okazaki-field-building-v4');material.dispose();map.dispose();
});

test('facades retain low-wing roof heights even when they connect to a taller building',()=>{
  const p=new Float32Array([0,20,0,4,20,0,0,24.1,0,4,20,0,4,24.1,0,0,24.1,0,4,20,0,8,20,0,4,28.7,0,8,20,0,8,28.7,0,4,28.7,0]);
  const before=[...p],result=buildingAttributes(p);
  assert.equal(result.spans[0],20);assert.ok(Math.abs(result.spans[1]-24.1)<.001);
  assert.ok(Math.abs(result.spans[15]-28.7)<.001);assert.deepEqual([...p],before);
  assert.ok(Math.abs(result.ceilings[0]-24.1)<.001);assert.ok(Math.abs(result.ceilings[2]-28.7)<.001);
  // Split wall/roof copies at the same vertical corner agree on the roof.
  assert.equal(result.spans[1],result.spans[5]);
});
test('game atlas respects every quality profile with legacy manifest fallback',()=>{
  const manifest={core:{file:'station.webp'},profiles:{performance:{file:'station-performance.webp'},balanced:{file:'station-balanced.webp'},high:{file:'station.webp'}}};
  for(const id of ['performance','balanced','high'])assert.equal(gameTerrainFile(manifest,id),'../field/'+manifest.profiles[id].file);
  assert.equal(gameTerrainFile({core:manifest.core},'performance'),'../field/station.webp');
});
test('facade vertex splitting preserves every indexed triangle and its source attributes',()=>{
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute([0,0,0,4,0,0,0,4,0,4,4,0,4,8,0,8,0,0],3));
  geometry.setAttribute('uv',new THREE.Float32BufferAttribute([0,0,1,0,0,1,1,1,1,2,2,0],2));
  geometry.setIndex([0,1,2,1,3,2,1,5,4]);
  const sourceIndex=[...geometry.index.array],sourcePosition=[...geometry.attributes.position.array],sourceUv=[...geometry.attributes.uv.array];
  decorateBuildingGeometry(THREE,geometry);
  for(let i=0;i<sourceIndex.length;i++){
    const old=sourceIndex[i],next=geometry.index.array[i];
    assert.deepEqual([...geometry.attributes.position.array.slice(next*3,next*3+3)],sourcePosition.slice(old*3,old*3+3));
    assert.deepEqual([...geometry.attributes.uv.array.slice(next*2,next*2+2)],sourceUv.slice(old*2,old*2+2));
  }
  assert.ok(geometry.attributes.position.count>sourcePosition.length/3);
  geometry.dispose();
});
test('game field defaults without writable storage; photo choice persists',()=>{
  assert.equal(readFieldStyle(), 'game');assert.equal(readFieldStyle({getItem(){throw Error();}}),'game');
  assert.equal(readFieldStyle({getItem:()=> 'photo'}),'photo');
});
test('building colors share split corners without changing positions or indices',()=>{
  const p=new Float32Array([0,0,0,1,0,0,0,1,0,0,1,0,1,0,0,1,1,0,20,0,0,21,0,0,20,1,0]);
  const i=new Uint32Array([0,1,2,3,4,5,6,7,8]),before=[...p],indices=[...i];
  const c=buildingColorBytes(p,i);
  for(let j=1;j<6;j++)assert.deepEqual([...c.slice(j*3,j*3+3)],[...c.slice(0,3)]);
  assert.deepEqual([...p],before);assert.deepEqual([...i],indices);assert.equal(c.length,p.length);
});
test('core atlas and neighboring tiles use identical global coordinates',()=>{
  const v={zoom:16,x:57735,y:25974,unit:1024};
  assert.deepEqual(mapPoint({x:3072,y:2048},{z:14,x:14433,y:6493},4096,v),[0,0]);
  const left=mapPoint({x:4096,y:1024},{z:14,x:14433,y:6493},4096,v);
  const right=mapPoint({x:0,y:1024},{z:14,x:14434,y:6493},4096,v);
  assert.deepEqual(left,right);
});
test('road widths use centimetres or documented width classes, not arbitrary pixel widths',()=>{
  assert.equal(roadWidth({vt_width:641}),6.41);assert.equal(roadWidth({vt_rnkwidth:'3m-5.5m未満'}),4.5);
  assert.equal(roadWidth({vt_width:Infinity}),4.5);assert.equal(roadWidth({vt_width:90000}),40);
});
test('water holes use evenodd and source strings cannot enter SVG',()=>{
  const feature={type:3,properties:{vt_code:5200,name:'<script>alert(1)</script>'},loadGeometry:()=>[[{x:0,y:0},{x:4096,y:0},{x:4096,y:4096}],[{x:100,y:100},{x:200,y:100},{x:200,y:200}]]};
  const {svg}=renderFieldSVG([{z:14,x:1,y:1,tile:{layers:{WA:{length:1,extent:4096,feature:()=>feature}}}}],{zoom:14,x:1,y:1,unit:512,width:512,height:512,latitude:35});
  assert.match(svg,/fill-rule="evenodd"/);assert.doesNotMatch(svg,/<script>/);assert.ok(!svg.includes('NaN'));
});

test('GSI surface variants retain ordinary roads and bridges but exclude tunnels and underground/dry water',()=>{
  const codes={RdCL:[2701,2703,2704,2711,2713,2714,2721,2723,2724,2731,2733,2734],RvrCL:[5301,5302,5321,5322,5331]};
  const layers=Object.fromEntries(Object.entries(codes).map(([name,items])=>[name,{length:items.length,extent:4096,
    feature:i=>({type:2,properties:{vt_code:items[i]},loadGeometry:()=>[[{x:items[i],y:1},{x:items[i],y:100}]]})}]));
  const {svg}=renderFieldSVG([{z:14,x:1,y:1,tile:{layers}}],{zoom:14,x:1,y:1,unit:4096,width:4096,height:4096,latitude:35});
  for(const code of [2701,2703,2711,2713,2721,2723,2731,2733,5301,5321,5331])assert.ok(svg.includes(`M${code.toFixed(2)},`),String(code));
  for(const code of [2704,2714,2724,2734,5302,5322])assert.ok(!svg.includes(`M${code.toFixed(2)},`),String(code));
});
