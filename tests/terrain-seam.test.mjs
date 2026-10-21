import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {terrainBoundaryLoops,polygonAreaXZ,coreSeamWall} from '../src/terrain-boundary.js';
import {coreTerrainFootprint,clipSide,outsideFootprint} from '../scripts/build-region-terrain.mjs';
import {createSurfaceIndex,terrainCoversBox} from '../src/placement.js';
const decode=(buffer,tile)=>({p:new Float32Array(buffer.buffer,buffer.byteOffset,tile.vertices*3),uv:new Float32Array(buffer.buffer,buffer.byteOffset+tile.vertices*24,tile.vertices*2),i:new Uint32Array(buffer.buffer,buffer.byteOffset+tile.vertices*32,tile.indices)});
test('a core bounding box does not imply coverage of its missing corner',()=>{
  const terrain=createSurfaceIndex(new Float32Array([0,0,0,0,0,2,2,0,0]));
  assert.equal(terrainCoversBox(terrain,[.1,.1,.3,.3]),true);
  assert.equal(terrainCoversBox(terrain,[1.4,1.4,1.6,1.6]),false);
  assert.equal(terrainCoversBox(terrain,[.2,.2,.2,.4]),true,'vertical X plane');
  assert.equal(terrainCoversBox(terrain,[.2,.2,.4,.2]),true,'vertical Z plane');
});

test('actual core footprint and regenerated DEM templates cover the old bounding-box gap',async()=>{
  const {rectangle,loop}=await coreTerrainFootprint(),manifest=JSON.parse(await readFile(new URL('../public/region/terrain.json',import.meta.url)));
  let covered=0,wallLength=0;
  for(const tile of manifest.tiles){
    const b=tile.bounds;if(b[2]<rectangle[0]||b[0]>rectangle[2]||b[3]<rectangle[1]||b[1]>rectangle[3])continue;
    const data=decode(await readFile(new URL('../public/region/'+tile.file,import.meta.url)),tile);
    for(let i=0;i<data.i.length;i+=3){let polygon=[...data.i.slice(i,i+3)].map(i=>[...data.p.slice(i*3,i*3+3)]);
      for(const [axis,limit,lower] of [[0,rectangle[0],true],[2,rectangle[1],true],[0,rectangle[2],false],[2,rectangle[3],false]])polygon=clipSide(polygon,axis,limit,lower,true);
      covered+=polygonAreaXZ(polygon);
    }
    const dem=data.p.slice();for(let i=1;i<dem.length;i+=3)dem[i]=30;
    const wall=coreSeamWall(dem,data.uv,data.i,loop);
    assert.ok(wall.positions.every(Number.isFinite));assert.equal(wall.uv.length,wall.positions.length/3*2);
    for(let i=0;i<wall.positions.length;i+=18){const p=wall.positions;wallLength+=Math.hypot(p[i+3]-p[i],p[i+5]-p[i+2]);}
  }
  const expected=(rectangle[2]-rectangle[0])*(rectangle[3]-rectangle[1])-polygonAreaXZ(loop);
  assert.ok(expected>7000,'reproduces the former missing strips');
  assert.ok(Math.abs(covered-expected)<.2,`gap area: expected ${expected}, covered ${covered}`);
  const perimeter=loop.reduce((s,a,i)=>{const b=loop[(i+1)%loop.length];return s+Math.hypot(a[0]-b[0],a[2]-b[2]);},0);
  assert.ok(Math.abs(wallLength-perimeter)<.2,`seam covers the complete original rim: ${wallLength} / ${perimeter}`);
});

test('seam wall connects supplied heights without creating horizontal ground or modifying inputs',()=>{
  const positions=new Float32Array([0,3,0,2,3,0,0,3,2]),uv=new Float32Array([0,0,1,0,0,1]),indices=new Uint32Array([0,2,1]);
  const before=[...positions],loop=[[0,5,0],[2,7,0],[2,7,-2],[0,5,-2]],wall=coreSeamWall(positions,uv,indices,loop);
  assert.equal(wall.positions.length,18);assert.deepEqual([...positions],before);
  assert.equal(polygonAreaXZ(wall.positions.slice(0,9).reduce((a,_,i,v)=>{if(i%3===0)a.push(v.slice(i,i+3));return a;},[])),0);
  assert.ok(wall.positions.includes(5)&&wall.positions.includes(7));
});

test('polygon subtraction retains the strip outside a nonrectangular original footprint',()=>{
  const triangle=[[0,0,0,0,0],[2,0,0,1,0],[0,0,2,0,1]],mask=[[[0,0,0],[1,0,0],[0,0,1]]];
  const result=outsideFootprint(triangle,mask);assert.ok(Math.abs(result.reduce((s,p)=>s+polygonAreaXZ(p),0)-1.5)<1e-9);
  assert.ok(result.flat().every(p=>p.every(Number.isFinite)));
  assert.throws(()=>terrainBoundaryLoops(new Float32Array([0,0,0,1,0,0,0,0,1,1,0,0,2,0,0,2,0,1])),/boundary/);
});
