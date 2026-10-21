import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {terrainBoundaryLoops,polygonAreaXZ,coreSeamWall,stitchTerrainToCore} from '../src/terrain-boundary.js';
import {coreTerrainFootprint,clipSide,outsideFootprint,conformTerrainEdges} from '../scripts/build-region-terrain.mjs';
import {createSurfaceIndex,terrainCoversBox,sampleSurfaceHeight} from '../src/placement.js';
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

test('T-junction is shared by both adjacent faces before nonlinear heights are applied',()=>{
  const vertices=[[0,0,0,0,0],[2,0,0,1,0],[0,0,2,0,1],[1,0,1,.5,.5],[2,0,2,1,1]];
  const indices=conformTerrainEdges(vertices,[0,2,1,1,3,4,3,2,4]);
  const edges=new Map();for(let i=0;i<indices.length;i+=3)for(let j=0;j<3;j++){const ids=[indices[i+j],indices[i+(j+1)%3]].sort((a,b)=>a-b),key=ids.join(',');edges.set(key,(edges.get(key)??0)+1);}
  assert.equal(edges.has('1,2'),false,'long edge must be split at the neighbouring midpoint');
  assert.equal(edges.get('1,3'),2);assert.equal(edges.get('2,3'),2);
});

test('transition joins the exact original rim, changes only nearby regional heights and retains XYZ',()=>{
  const rim=[[0,10,0],[100,20,0],[100,20,-100],[0,10,-100]],before=structuredClone(rim);
  const p=new Float32Array([25,30,0,25,30,20,25,30,40,25,30,80]);
  assert.equal(stitchTerrainToCore(p,rim),2);assert.equal(p[1],12.5);assert.equal(p[4],21.25);assert.equal(p[7],30);assert.equal(p[10],30);
  assert.deepEqual(Array.from(p).filter((_,i)=>i%3!==1),[25,0,25,20,25,40,25,80]);assert.deepEqual(rim,before);
});

test('seam envelope covers a higher incident edge instead of taking the first lower edge',()=>{
  const p=new Float32Array([0,3,0,2,3,0,0,3,2,0,8,0,2,8,0,2,8,2]),uv=new Float32Array(12),i=new Uint32Array([0,2,1,3,5,4]);
  const wall=coreSeamWall(p,uv,i,[[0,5,0],[2,5,0],[2,5,-2],[0,5,-2]]);
  assert.ok(wall.positions.includes(3)&&wall.positions.includes(8));
});

test('distributed regional faces join all original rim height segments without holes or steps',async()=>{
  const {rectangle,loop}=await coreTerrainFootprint(),m=JSON.parse(await readFile(new URL('../public/region/terrain.json',import.meta.url))),ground=[];
  for(const tile of m.tiles){const b=tile.bounds;if(b[2]<rectangle[0]||b[0]>rectangle[2]||b[3]<rectangle[1]||b[1]>rectangle[3])continue;
    const d=decode(await readFile(new URL('../public/region/'+tile.file,import.meta.url)),tile);
    for(let i=1;i<d.p.length;i+=3)d.p[i]=25+Math.sin(d.p[i-1]/10);
    stitchTerrainToCore(d.p,loop);ground.push(createSurfaceIndex(d.p,d.i));
  }
  const signed=loop.reduce((s,a,i)=>{const b=loop[(i+1)%loop.length];return s+a[0]*b[2]-b[0]*a[2];},0),sign=Math.sign(signed);
  let samples=0;
  for(let i=0;i<loop.length;i++){
    const a=loop[i],b=loop[(i+1)%loop.length],dx=b[0]-a[0],dz=b[2]-a[2],length=Math.hypot(dx,dz);
    if(length<.01)continue;
    for(const t of [.1,.5,.9]){
      const x=a[0]+dx*t+sign*dz/length*.001,z=a[2]+dz*t-sign*dx/length*.001,expected=a[1]+(b[1]-a[1])*t;
      const values=ground.map(g=>sampleSurfaceHeight(g,x,z)).filter(Number.isFinite);
      assert.ok(values.length,`missing ground at ${x},${z}`);
      assert.ok(Math.abs(Math.max(...values)-expected)<.02,`step at ${x},${z}: ${Math.max(...values)-expected}m`);samples++;
    }
  }
  assert.ok(samples>1400);
});
