import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {createSurfaceIndex,projectSurfacePolygon} from '../src/placement.js';
import {streetRectangle,streetSegments,createVectorStreets} from '../src/vector-streets.js';
function terrain(){const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute([0,0,0,0,1,10,10,2,10,10,1,0],3));g.setIndex(new THREE.BufferAttribute(new Uint32Array([0,1,2,0,2,3]),1));return new THREE.Mesh(g);}
test('vector surfaces clip to real terrain, follow its slope and keep front faces upward',()=>{
 const mesh=terrain(),a=mesh.geometry.attributes.position.array,before=[...a],index=createSurfaceIndex(a,mesh.geometry.index.array);
 const projected=projectSurfacePolygon(index,streetRectangle([-5,5],[15,5],2),.02);
 assert.ok(projected.length>0);
 for(let i=0;i<projected.length;i+=3){const [x,y,z]=projected.slice(i,i+3);assert.ok(x>=0&&x<=10);assert.ok(Math.abs(y-(x+z)/10-.02)<1e-6);}
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(projected,3));g.computeVertexNormals();
 for(let i=1;i<g.attributes.normal.array.length;i+=3)assert.ok(g.attributes.normal.array[i]>.9);
 assert.deepEqual([...a],before);assert.deepEqual(projectSurfacePolygon(index,streetRectangle([50,50],[70,50],2)),[]);
});
test('subdivision preserves source route and limits each terrain query to twenty metres',()=>{
 const data={roads:[{line:[[0,0],[55,0]],width:9}],rails:[]},before=JSON.stringify(data),segments=streetSegments(data);
 assert.deepEqual(segments.map(s=>s.length),[20,20,15]);assert.deepEqual(segments.map(s=>s.along),[0,20,40]);assert.equal(JSON.stringify(data),before);
});
test('raised rails include top and side geometry without extending outside real ground',()=>{
 const mesh=terrain(),index=createSurfaceIndex(mesh.geometry.attributes.position.array,mesh.geometry.index.array),points=projectSurfacePolygon(index,streetRectangle([-5,5],[15,5],.18),.02,.14);
 assert.ok(points.length>36);
 for(let i=0;i<points.length;i+=3){const [x,y,z]=points.slice(i,i+3),h=(x+z)/10;assert.ok(x>=0&&x<=10);assert.ok(y>=h+.02-1e-6&&y<=h+.16+1e-6);}
});
test('raised streets never extrude the internal diagonal of the terrain mesh',()=>{
 const mesh=terrain(),index=createSurfaceIndex(mesh.geometry.attributes.position.array,mesh.geometry.index.array);
 const points=projectSurfacePolygon(index,[[2,2],[8,2],[8,8],[2,8]],.02,.14);let sides=0;
 for(let i=0;i<points.length;i+=9){
  const p=[points.slice(i,i+3),points.slice(i+3,i+6),points.slice(i+6,i+9)];
  const area=(p[1][0]-p[0][0])*(p[2][2]-p[0][2])-(p[2][0]-p[0][0])*(p[1][2]-p[0][2]);
  if(Math.abs(area)>1e-8)continue;
  sides++;assert.ok([2,8].some(v=>p.every(q=>Math.abs(q[0]-v)<1e-6)||p.every(q=>Math.abs(q[2]-v)<1e-6)),'every wall belongs to the original outline');
 }
 assert.equal(sides,8,'only the four outer walls, not duplicate internal diagonal walls');
});
test('near streets render six untextured geometry layers and release them in performance mode',()=>{
 const scene=new THREE.Scene(),streets=createVectorStreets({scene}),mesh=terrain();
 streets.setData({roads:[{line:[[1,5],[9,5]],width:3}],rails:[{line:[[5,1],[5,9]],width:5}],junctions:[],crossings:[]});
 const options={position:new THREE.Vector3(5,4,5),terrain:[mesh],terrainVersion:'first'};
 for(let i=0;i<40;i++)streets.update(options);
 assert.ok(streets.getState().triangles>0);assert.ok(streets.getState().triangles<50000);
 for(const layer of scene.children[0].children)assert.equal(layer.material.map,null);
 assert.equal(mesh.children.length,0);
 streets.update({...options,quality:'performance'});assert.equal(streets.getState().triangles,0);assert.equal(streets.getState().visible,false);
 streets.dispose();assert.equal(scene.children.length,0);
});
