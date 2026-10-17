import test from 'node:test';
import assert from 'node:assert/strict';
import {buildingColorBytes,readFieldStyle,gameTerrainFile} from '../src/field-style.js';
import {mapPoint,roadWidth,renderFieldSVG} from '../scripts/lib/field-map.mjs';
test('game atlas respects every quality profile with legacy manifest fallback',()=>{
  const manifest={core:{file:'station.webp'},profiles:{performance:{file:'station-performance.webp'},balanced:{file:'station-balanced.webp'},high:{file:'station.webp'}}};
  for(const id of ['performance','balanced','high'])assert.equal(gameTerrainFile(manifest,id),'../field/'+manifest.profiles[id].file);
  assert.equal(gameTerrainFile({core:manifest.core},'performance'),'../field/station.webp');
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
