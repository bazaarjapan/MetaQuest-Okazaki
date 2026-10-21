import {textureMemoryBytes} from './quality.js';
import {applyCityGroundMaterial} from './city-surface-map.js';

// Clip in the original UV space, interpolating the existing DEM surface rather
// than inventing a second flat ground. Original arrays are never modified.
export function clipTerrainUV(positions,normals,uv,indices,rect=[0,0,1,1]) {
  const out={positions:[],normals:[],uv:[],bounds:[Infinity,Infinity,-Infinity,-Infinity],heightRange:[Infinity,-Infinity]};
  const [u0,v0,u1,v1]=rect;
  if(!(u1>u0&&v1>v0))throw Error('Invalid detail UV rectangle');
  for(let n=0;n<indices.length;n+=3) {
    const ia=indices[n]*2,ib=indices[n+1]*2,ic=indices[n+2]*2;
    if(Math.max(uv[ia],uv[ib],uv[ic])<u0||Math.min(uv[ia],uv[ib],uv[ic])>u1||
      Math.max(uv[ia+1],uv[ib+1],uv[ic+1])<v0||Math.min(uv[ia+1],uv[ib+1],uv[ic+1])>v1)continue;
    let polygon=Array.from(indices.slice(n,n+3),i=>[...positions.slice(i*3,i*3+3),...normals.slice(i*3,i*3+3),...uv.slice(i*2,i*2+2)]);
    for(const [axis,value,sign] of [[6,u0,1],[6,u1,-1],[7,v0,1],[7,v1,-1]]) {
      const input=polygon;polygon=[];
      for(let i=0;i<input.length;i++) {
        const a=input[i],b=input[(i+1)%input.length],insideA=(a[axis]-value)*sign>=0,insideB=(b[axis]-value)*sign>=0;
        if(insideA)polygon.push(a);
        if(insideA!==insideB){const t=(value-a[axis])/(b[axis]-a[axis]);polygon.push(a.map((v,j)=>v+(b[j]-v)*t));}
      }
    }
    for(let i=1;i+1<polygon.length;i++)for(const vertex of [polygon[0],polygon[i],polygon[i+1]]) {
      out.positions.push(...vertex.slice(0,3));out.normals.push(...vertex.slice(3,6));
      out.uv.push((vertex[6]-u0)/(u1-u0),(vertex[7]-v0)/(v1-v0));
      out.bounds[0]=Math.min(out.bounds[0],vertex[0]);out.bounds[1]=Math.min(out.bounds[1],vertex[2]);
      out.bounds[2]=Math.max(out.bounds[2],vertex[0]);out.bounds[3]=Math.max(out.bounds[3],vertex[2]);
      out.heightRange[0]=Math.min(out.heightRange[0],vertex[1]);out.heightRange[1]=Math.max(out.heightRange[1],vertex[1]);
    }
  }
  return out;
}

export function chooseNearField(candidates,position,quality='high',current=null) {
  if(quality==='performance')return null;
  const [x,y,z]=Array.isArray(position)?position:[position.x,position.y,position.z];
  if(![x,y,z].every(Number.isFinite))return null;
  const distance=c=>Math.hypot(Math.max(c.bounds[0]-x,0,x-c.bounds[2]),Math.max(c.heightRange[0]-y,0,y-c.heightRange[1]),Math.max(c.bounds[1]-z,0,z-c.bounds[3]));
  const radius=quality==='high'?450:250;
  const list=candidates.filter(c=>c.positions.length&&distance(c)<=radius).sort((a,b)=>{
    // Height ranges of a whole regional tile may include distant hills. They
    // only gate altitude; they must not outrank the actual nearby core patch.
    const score=c=>Math.hypot(Math.max(c.bounds[0]-x,0,x-c.bounds[2]),Math.max(c.bounds[1]-z,0,z-c.bounds[3]))+
      Math.hypot((c.bounds[0]+c.bounds[2])/2-x,(c.bounds[1]+c.bounds[3])/2-z)*.01;
    return score(a)-score(b)||a.id.localeCompare(b.id);
  });
  const best=list[0];
  // A small spatial hysteresis avoids thrashing while hovering on a seam.
  const previous=list.find(c=>c.id===current);
  if(previous&&best&&previous.source===best.source&&distance(previous)===0&&distance(best)===0)return previous;
  return best??null;
}

export function createNearField(THREE,{fetchImpl=globalThis.fetch,maxAnisotropy=16,citySurfaceUniforms=null,gameUniform={value:1}}={}) {
  let cache=new WeakMap(),current=null,task=null,target=null,lastTime=-Infinity,disposed=false;
  let requested=0,errors=0,lastError=null;
  const failures=new Map();
  const budget=textureMemoryBytes(2048,2048);
  function release(){if(!current)return;current.mesh.removeFromParent();current.mesh.geometry.dispose();current.mesh.material.dispose();current.texture.dispose();current.bitmap.close();current=null;}
  function sourceCandidates(source,entries) {
    if(!cache.has(source)) {
      const g=source.geometry,a=g.attributes;
      const indices=g.index?.array??Uint32Array.from({length:a.position.count},(_,i)=>i);
      cache.set(source,entries.map(entry=>({...clipTerrainUV(a.position.array,a.normal.array,a.uv.array,indices,entry.rect),
        ...entry,id:entry.file,source})));
    }
    return cache.get(source);
  }
  async function load(next,controller) {
    let bitmap,texture,geometry,material,mesh;
    const timeout=setTimeout(()=>controller.abort(),30000);
    try {
      const response=await fetchImpl('/field/'+next.file,{signal:controller.signal,credentials:'same-origin'});
      if(!response.ok)throw Error(`Detail image ${response.status}`);
      const bytes=await response.arrayBuffer();
      if(bytes.byteLength!==next.bytes||bytes.byteLength>25*1024*1024)throw Error('Detail image size mismatch');
      const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
      if(hash!==next.sha256)throw Error('Detail image hash mismatch');
      if(controller.signal.aborted)return;
      // Balanced samples fewer pixels from the same vector-rendered source.
      const width=next.quality==='high'?next.width:Math.min(1024,next.width),height=Math.round(next.height*width/next.width);
      bitmap=await createImageBitmap(new Blob([bytes],{type:'image/webp'}),{imageOrientation:'flipY',colorSpaceConversion:'none',premultiplyAlpha:'none',resizeWidth:width,resizeHeight:height});
      if(controller.signal.aborted||disposed||target?.key!==next.key||target?.source!==next.source)return;
      if(bitmap.width!==width||bitmap.height!==height||textureMemoryBytes(width,height)>budget)throw Error('Invalid detail texture dimensions');
      texture=new THREE.Texture(bitmap);texture.flipY=false;texture.colorSpace=THREE.SRGBColorSpace;
      texture.anisotropy=Math.min(next.quality==='high'?16:8,maxAnisotropy);texture.needsUpdate=true;
      geometry=new THREE.BufferGeometry();
      geometry.setAttribute('position',new THREE.BufferAttribute(new Float32Array(next.positions),3));
      geometry.setAttribute('normal',new THREE.BufferAttribute(new Float32Array(next.normals),3));
      geometry.setAttribute('uv',new THREE.BufferAttribute(new Float32Array(next.uv),2));
      material=new THREE.MeshStandardMaterial({map:texture,roughness:1,metalness:0,polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-1});
      if(citySurfaceUniforms)applyCityGroundMaterial(material,citySurfaceUniforms,gameUniform);
      mesh=new THREE.Mesh(geometry,material);mesh.name='near-field-detail';mesh.receiveShadow=next.source.receiveShadow;
      // Child transform keeps exact alignment even if a source group moves.
      next.source.add(mesh);
      current={...next,mesh,bitmap,texture,textureBytes:textureMemoryBytes(width,height)};
      bitmap=texture=geometry=material=null;failures.delete(next.key);
    }catch(error){if(!controller.signal.aborted){errors++;lastError=error.message;failures.set(next.key,performance.now()+5000);}}
    finally{clearTimeout(timeout);bitmap?.close();texture?.dispose();geometry?.dispose();material?.dispose();if(task?.controller===controller)task=null;pump();}
  }
  function pump(){
    if(disposed||task||!target||current?.key===target.key||(failures.get(target.key)??0)>performance.now())return;
    // Free the previous near image before decoding another. Far ground is
    // always present, including on failure, abort and fast teleport.
    release();const controller=new AbortController(),next=target;
    task={controller,key:next.key,source:next.source};requested++;void load(next,controller);
  }
  function update({position,quality='high',enabled=true,manifest,core,terrain=[],time=performance.now()}) {
    if(disposed)return;
    const sources=new Set([core,...terrain].filter(Boolean));
    if(!enabled||!manifest?.near||quality==='performance') {
      target=null;task?.controller.abort();release();lastTime=-Infinity;return;
    }
    if(current&&!sources.has(current.source))release();
    if(time>=lastTime&&time-lastTime<600&&target?.quality===quality&&sources.has(target.source)){pump();return;}
    lastTime=time;
    const candidates=[];
    if(core)candidates.push(...sourceCandidates(core,manifest.near.core));
    for(const source of terrain){const entry=manifest.near.region[source.userData.regionTileId];if(entry)candidates.push(...sourceCandidates(source,[entry]));}
    const chosen=chooseNearField(candidates,position,quality,current?.id);
    target=chosen?{...chosen,quality,key:chosen.id+':'+quality}:null;
    if(task&&(task.key!==target?.key||task.source!==target?.source))task.controller.abort();
    if(!target)release();pump();
  }
  return {update,getState:()=>({resident:Number(Boolean(current)),loading:Number(Boolean(task)),id:current?.id??null,
    quality:current?.quality??null,width:current?.bitmap.width??0,anisotropy:current?.texture.anisotropy??0,textureBytes:current?.textureBytes??0,loadingTextureBytes:task?budget:0,textureBudget:budget,requested,errors,lastError,
    source:current?.source.userData.regionTileId??(current?'core':null)}),
    dispose(){disposed=true;target=null;task?.controller.abort();release();cache=new WeakMap();failures.clear();}};
}
