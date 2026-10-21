import * as THREE from 'three';
import {createSurfaceIndex,projectSurfacePolygon} from './placement.js';

export function streetRectangle(a,b,width,offset=0){
 const dx=b[0]-a[0],dz=b[1]-a[1],length=Math.hypot(dx,dz);if(length<1e-6)return [];
 const nx=dz/length,nz=-dx/length;
 return [[a[0]+nx*(offset-width/2),a[1]+nz*(offset-width/2)],[b[0]+nx*(offset-width/2),b[1]+nz*(offset-width/2)],[b[0]+nx*(offset+width/2),b[1]+nz*(offset+width/2)],[a[0]+nx*(offset+width/2),a[1]+nz*(offset+width/2)]];
}
export function streetSegments(data){
 const result=[];
 for(const [kind,lines] of [['road',data.roads??[]],['rail',data.rails??[]]])for(const route of lines){
  let along=0;
  for(let i=1;i<route.line.length;i++){
   const a=route.line[i-1],b=route.line[i],length=Math.hypot(b[0]-a[0],b[1]-a[1]);
   for(let d=0;d<length;d+=20){const end=Math.min(d+20,length),point=t=>[a[0]+(b[0]-a[0])*t/length,a[1]+(b[1]-a[1])*t/length];result.push({kind,a:point(d),b:point(end),width:route.width,along:along+d,length:end-d});}
   along+=length;
  }
 }
 return result;
}
export function createVectorStreets({scene,fetchImpl=globalThis.fetch,getIndex=()=>null}){
 const group=new THREE.Group();group.name='vector-streets';scene.add(group);
 const palette=[0xc9cfbf,0x586567,0x88918a,0x5c5c53,0xd7ded9,0xede5bd];
 const center={value:new THREE.Vector3()},range={value:220};
 const meshes=palette.map((color,i)=>{
  const material=new THREE.MeshStandardMaterial({color,roughness:i===4?.35:1,metalness:i===4?.65:0,transparent:true,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-2});
  material.onBeforeCompile=shader=>{shader.uniforms.streetCenter=center;shader.uniforms.streetRange=range;shader.vertexShader='varying vec3 vStreetWorld;\n'+shader.vertexShader;shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\nvStreetWorld=(modelMatrix*vec4(position,1.)).xyz;');shader.fragmentShader='uniform vec3 streetCenter;uniform float streetRange;varying vec3 vStreetWorld;\n'+shader.fragmentShader;shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>','#include <color_fragment>\ndiffuseColor.a*=1.-smoothstep(streetRange-35.,streetRange,length(vStreetWorld.xz-streetCenter.xz));');};
  material.customProgramCacheKey=()=> 'draped-vector-streets-v1';
  const mesh=new THREE.Mesh(new THREE.BufferGeometry(),material);mesh.renderOrder=i+1;mesh.frustumCulled=false;group.add(mesh);return mesh;
 });
 let data=null,segments=[],version='',last=null,pending=null,shown=0,checks=0,manifest=null,revision=0,disposed=false;
 const resident=new Map(),loading=new Map(),failures=new Map();
 function setData(value){data=value;segments=streetSegments(value);revision++;last=null;}
 function rebuild(){const values=[...resident.values()],unique=(items,key)=>[...new Map(items.map(i=>[key(i),i])).values()];setData({roads:values.flatMap(v=>v.roads),rails:values.flatMap(v=>v.rails),junctions:unique(values.flatMap(v=>v.junctions),j=>j.point.join(',')),crossings:unique(values.flatMap(v=>v.crossings),c=>c.center.join(','))});}
 function loadNearby(position,radius){
  if(!manifest)return;
  const wanted=manifest.tiles.filter(t=>Math.hypot(Math.max(t.bounds[0]-position.x,0,position.x-t.bounds[2]),Math.max(t.bounds[1]-position.z,0,position.z-t.bounds[3]))<=radius+40).slice(0,4),ids=new Set(wanted.map(t=>t.id));
  let changed=false;for(const id of resident.keys())if(!ids.has(id)){resident.delete(id);changed=true;}
  for(const [id,c] of loading)if(!ids.has(id)){c.abort();loading.delete(id);}
  if(changed)rebuild();
  for(const tile of wanted){if(resident.has(tile.id)||loading.has(tile.id)||(failures.get(tile.id)??0)>performance.now())continue;
   const controller=new AbortController();loading.set(tile.id,controller);
   void (async()=>{try{const response=await fetchImpl('/field/'+tile.file,{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)]),credentials:'same-origin'});if(!response.ok)throw Error('Vector tile unavailable');const bytes=await response.arrayBuffer();if(bytes.byteLength!==tile.bytes||bytes.byteLength>2*1024*1024)throw Error('Vector tile size mismatch');const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');if(digest!==tile.sha256)throw Error('Vector tile hash mismatch');const value=JSON.parse(new TextDecoder().decode(bytes));if(!disposed&&!controller.signal.aborted){resident.set(tile.id,value);rebuild();}}catch{if(!controller.signal.aborted)failures.set(tile.id,performance.now()+5000);}finally{if(loading.get(tile.id)===controller)loading.delete(tile.id);}})();
  }
 }
 const indexes=new WeakMap();
 const clear=()=>{for(const g of pending?.geometries??[])g.dispose();pending=null;for(const mesh of meshes){mesh.geometry.dispose();mesh.geometry=new THREE.BufferGeometry();}shown=0;};
 function ground(mesh){const shared=getIndex(mesh);if(shared)return shared;if(!indexes.has(mesh.geometry))indexes.set(mesh.geometry,createSurfaceIndex(mesh.geometry.attributes.position.array,mesh.geometry.index?Uint32Array.from(mesh.geometry.index.array):null));return indexes.get(mesh.geometry);}
 function draw(buffers,grounds,layer,polygon){if(polygon.length<3)return;for(const index of grounds){
  const positions=projectSurfacePolygon(index,polygon,.015+layer*.005,layer===4?.14:layer===3?.07:0);buffers[layer].push(...positions);
  // Build normals during the bounded projection jobs, not in one costly final
  // computeVertexNormals pass over the complete neighbourhood.
  for(let i=0;i<positions.length;i+=9){const ux=positions[i+3]-positions[i],uy=positions[i+4]-positions[i+1],uz=positions[i+5]-positions[i+2],vx=positions[i+6]-positions[i],vy=positions[i+7]-positions[i+1],vz=positions[i+8]-positions[i+2],nx=uy*vz-uz*vy,ny=uz*vx-ux*vz,nz=ux*vy-uy*vx,length=Math.hypot(nx,ny,nz)||1;for(let k=0;k<3;k++)buffers[layer].normals.push(nx/length,ny/length,nz/length);}
 }}
 function segment(task,buffers,grounds){
  if(task.kind==='crossing'){
   const c=task,n=Math.max(3,Math.floor((c.width-1)/1.05));
   for(let i=0;i<n;i++){const p=c.center.map((v,k)=>v+c.normal[k]*((i+.5)*1.05-n*1.05/2)),a=p.map((v,k)=>v-c.direction[k]*1.5),b=p.map((v,k)=>v+c.direction[k]*1.5);draw(buffers,grounds,5,streetRectangle(a,b,.5));}
   return;
  }
  const {a,b,width,kind,along,length}=task,point=d=>[a[0]+(b[0]-a[0])*d/length,a[1]+(b[1]-a[1])*d/length];
  if(kind==='road'){
   draw(buffers,grounds,0,streetRectangle(a,b,width+1.2));draw(buffers,grounds,1,streetRectangle(a,b,width));
    if(width>=6)for(let d=Math.floor(along/9)*9-along;d<length;d+=9){const start=Math.max(0,d),end=Math.min(d+4,length);if(end<=start)continue;const mid=point((start+end)/2);if(!data.junctions.some(j=>Math.hypot(mid[0]-j.point[0],mid[1]-j.point[1])<j.radius))draw(buffers,grounds,5,streetRectangle(point(start),point(end),.16));}
  }else{
   draw(buffers,grounds,2,streetRectangle(a,b,5));
   for(let d=Math.floor(along/2.5)*2.5-along;d<length;d+=2.5){const start=Math.max(0,d),end=Math.min(d+.5,length);if(end>start)draw(buffers,grounds,3,streetRectangle(point(start),point(end),3.2));}
   for(const side of [-1,1])draw(buffers,grounds,4,streetRectangle(a,b,.18,side*.85));
  }
 }
 return {
  setData,setManifest(value){manifest=value;},
  update({position,quality='high',enabled=true,terrain=[],terrainVersion=''}){
   if(enabled&&quality!=='performance')loadNearby(position,quality==='high'?240:150);
   group.visible=Boolean(enabled&&quality!=='performance'&&data);checks=0;if(!group.visible){if(shown||pending)clear();pending=null;last=null;return;}
   const radius=quality==='high'?240:150;range.value=radius;center.value.copy(position);
   const key=terrainVersion+':'+quality+':'+revision;
   if(key!==version){version=key;clear();pending=null;last=null;}
   if(!pending&&(!last||Math.hypot(position.x-last.x,position.z-last.z)>30)){
    last={x:position.x,z:position.z};
    const tasks=segments.map(s=>({s,d:Math.hypot((s.a[0]+s.b[0])/2-position.x,(s.a[1]+s.b[1])/2-position.z)})).filter(t=>t.d<radius+20).sort((a,b)=>a.d-b.d).slice(0,1400).map(t=>t.s);
    tasks.push(...(data.crossings??[]).filter(c=>Math.hypot(c.center[0]-position.x,c.center[1]-position.z)<radius+10).map(c=>({...c,kind:'crossing'})));
    pending={tasks,at:0,buffers:palette.map(()=>Object.assign([],{normals:[]})),grounds:terrain.map(ground),geometries:[]};
   }
   const start=performance.now();
   while(pending&&pending.at<pending.tasks.length&&checks<6&&performance.now()-start<5){segment(pending.tasks[pending.at++],pending.buffers,pending.grounds);checks++;if(pending.buffers.reduce((sum,a)=>sum+a.length/9,0)>(quality==='high'?42000:24000))pending.at=pending.tasks.length;}
   if(pending&&pending.at===pending.tasks.length){
    // Stage one layer per frame, then atomically swap all six ready layers.
    const i=pending.geometries.length,geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(pending.buffers[i],3));geometry.setAttribute('normal',new THREE.Float32BufferAttribute(pending.buffers[i].normals,3));pending.geometries.push(geometry);
    if(pending.geometries.length===meshes.length){meshes.forEach((mesh,i)=>{mesh.geometry.dispose();mesh.geometry=pending.geometries[i];mesh.visible=pending.buffers[i].length>0;});shown=pending.buffers.reduce((sum,a)=>sum+a.length/9,0);pending=null;}
   }
  },
  getState:()=>({visible:group.visible,triangles:shown,pending:pending?pending.tasks.length-pending.at:0,checks,segments:segments.length,residentTiles:resident.size,loadingTiles:loading.size}),
  dispose(){disposed=true;for(const c of loading.values())c.abort();loading.clear();resident.clear();clear();for(const mesh of meshes){mesh.geometry.dispose();mesh.material.dispose();}group.removeFromParent();}
 };
}
