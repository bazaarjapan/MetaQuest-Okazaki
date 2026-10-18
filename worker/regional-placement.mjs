import {createSurfaceIndex,placementContains,placementFootprint,placementIntersects} from '../src/placement.js';
import {interpolateElevation,validateDemTile} from '../src/terrain-height.js';
import {loadCorePlacement} from './placement-source.mjs';
import {fail,sha256} from './school-common.mjs';

export const REGION_SOURCE_HASHES=Object.freeze({
  'buildings.json':'d7033f6448eafd98b8cf64918a2637d7efc93bcd67f415a5bb48d4429f8b6f87',
  'terrain.json':'c2782bb05ee9e0d0473dd118c873f754340d69603f808b16bafdf5df211aeff4',
});
export const REGION_PLACEMENT_BOUNDS=Object.freeze([-4818.7919921875,-12503.6240234375,20255.958984375,6905.88623046875]);
const loaders=new WeakMap();
export function parseDemText(text) {
  const rows=text.trim().split(/\r?\n/);
  if(rows.length!==256)throw Error('Invalid DEM rows');
  const values=new Float64Array(65536);
  for(let y=0;y<256;y++){
    const row=rows[y].split(',');if(row.length!==256)throw Error('Invalid DEM columns');
    for(let x=0;x<256;x++){
      const s=row[x].trim(),value=s==='e'?NaN:Number(s);
      if(s!=='e' && (!/^-?\d+(?:\.\d{1,2})?$/.test(s)||!Number.isFinite(value)||Math.abs(value)>10000))throw Error('Invalid DEM sample');
      values[y*256+x]=value;
    }
  }
  return values;
}
async function readBounded(response,max) {
  if(!response.ok || Number(response.headers.get('content-length'))>max)throw Error('Placement source unavailable');
  const reader=response.body.getReader(),chunks=[];let length=0;
  try {for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>max)throw Error('Placement source too large');chunks.push(value);}}
  finally {await reader.cancel();}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes.buffer;
}
export function decodeRegionMesh(data,tile) {
  if(data.byteLength!==tile.bytes || !Number.isInteger(tile.vertices)||tile.vertices<3 || !Number.isInteger(tile.indices)||tile.indices%3)throw Error('Invalid region mesh');
  const n=tile.vertices,packed=tile.type==='building',positions=new Float32Array(n*3);
  if(packed){
    if(tile.format!=='region-building-v1'||tile.indexOffset+tile.indices*4!==data.byteLength)throw Error('Invalid packed region mesh');
    const q=new Int16Array(data,0,n*3);
    for(let i=0;i<q.length;i++)positions[i]=tile.origin[i%3]+q[i]*tile.scale;
  }else{
    if(n*32+tile.indices*4!==data.byteLength)throw Error('Invalid terrain mesh');
    positions.set(new Float32Array(data,0,n*3));
  }
  const indices=new Uint32Array(data,packed?tile.indexOffset:n*32,tile.indices);
  if(!positions.every(Number.isFinite)||!indices.every(i=>i<n))throw Error('Invalid region coordinates');
  return {positions,indices,uv:packed?null:new Float32Array(data,n*24,n*2)};
}
// Identical UV interpolation and Float32 rounding to the browser's PNG DEM.
// GSI documents text and PNG as the same samples; never substitute a zero plane.
export async function applyDemTextHeight(mesh,tile,getDem) {
  validateDemTile(tile);
  const keys=new Set();
  for(let i=0;i<mesh.uv.length;i+=2){
    const px=Math.max(0,Math.min(256,mesh.uv[i]*256)),py=Math.max(0,Math.min(256,(1-mesh.uv[i+1])*256));
    for(const x of [Math.floor(px),Math.ceil(px)])for(const y of [Math.floor(py),Math.ceil(py)])keys.add(`${Math.floor(x/256)},${Math.floor(y/256)}`);
  }
  const tiles=new Map(await Promise.all([...keys].map(async key=>{
    const [dx,dy]=key.split(',').map(Number);return [key,await getDem(tile.x+dx,tile.y+dy)];
  })));
  const sample=(x,y)=>tiles.get(`${Math.floor(x/256)},${Math.floor(y/256)}`)[(y%256)*256+x%256];
  for(let i=0;i<mesh.uv.length;i+=2){
    const px=Math.max(0,Math.min(256,mesh.uv[i]*256)),py=Math.max(0,Math.min(256,(1-mesh.uv[i+1])*256));
    const x=Math.floor(px),y=Math.floor(py),xx=Math.ceil(px),yy=Math.ceil(py);
    const value=interpolateElevation([sample(x,y),sample(xx,y),sample(x,yy),sample(xx,yy)],px-x,py-y);
    if(!value)throw Error('Verified terrain is unavailable');
    mesh.positions[i/2*3+1]=value.height;
  }
  return mesh;
}
function clippedIndex(mesh,box) {
  const points=[];
  for(let i=0;i<mesh.indices.length;i+=3){
    const ids=[mesh.indices[i]*3,mesh.indices[i+1]*3,mesh.indices[i+2]*3],p=mesh.positions;
    const bounds=[Math.min(...ids.map(j=>p[j])),Math.min(...ids.map(j=>p[j+2])),Math.max(...ids.map(j=>p[j])),Math.max(...ids.map(j=>p[j+2]))];
    if(placementIntersects(bounds,box))for(const j of ids)points.push(p[j],p[j+1],p[j+2]);
  }
  return points.length?createSurfaceIndex(new Float32Array(points)):null;
}
export function createRegionPlacementLoader(binding,{fetchImpl=fetch}={}) {
  const bytesCache=new Map(),demCache=new Map();let manifests=null;
  async function checked(file,hash,max=2*1024*1024){
    if(!/^[a-zA-Z0-9_.-]+$/.test(file))throw Error('Invalid source path');
    const key=`${file}:${hash}`;
    if(bytesCache.has(key))return bytesCache.get(key);
    const data=await readBounded(await binding.fetch(new Request(`https://metaquest001.gigach.net/region/${file}`)),max);
    if(await sha256(data)!==hash)throw Error('Placement source hash mismatch');
    bytesCache.set(key,data);while(bytesCache.size>12)bytesCache.delete(bytesCache.keys().next().value);return data;
  }
  async function getDem(x,y){
    if(!Number.isInteger(x)||!Number.isInteger(y)||x<0||y<0||x>=16384||y>=16384)throw Error('Invalid DEM coordinate');
    const key=`${x}/${y}`;
    if(demCache.has(key))return demCache.get(key);
    const pending=(async()=>{
      // workerd supports manual, not redirect:error. readBounded rejects every
      // 3xx response, so elevation requests cannot follow an external redirect.
      const response=await fetchImpl(`https://cyberjapandata.gsi.go.jp/xyz/dem/14/${key}.txt`,{redirect:'manual',signal:AbortSignal.timeout(8000)});
      return parseDemText(new TextDecoder().decode(await readBounded(response,1024*1024)));
    })();
    demCache.set(key,pending);
    try{const result=await pending;while(demCache.size>16)demCache.delete(demCache.keys().next().value);return result;}
    catch(error){demCache.delete(key);throw error;}
  }
  return async candidate=>{
    const core=await loadCorePlacement(binding);let box;
    try{box=placementFootprint(candidate);}catch(error){return {...core,error:error.message};}
    if(placementContains(core.bounds,box))return core;
    if(!placementContains(REGION_PLACEMENT_BOUNDS,box))return {...core,error:'Object is outside the editable region'};
    try{
      if(!manifests)manifests=Promise.all(Object.entries(REGION_SOURCE_HASHES).map(async([file,hash])=>JSON.parse(new TextDecoder().decode(await checked(file,hash))))).catch(error=>{manifests=null;throw error;});
      const [buildings,terrain]=await manifests;
      if(!placementContains(buildings.bounds,box))return {...core,error:'Object is outside the editable region'};
      const needed=[...terrain.tiles,...buildings.tiles].filter(t=>placementIntersects(t.bounds,box));
      if(needed.length>16)throw Error('Placement source budget exceeded');
      const ground=[],obstacles=[];
      if(placementIntersects(core.bounds,box)){ground.push(core.terrain);obstacles.push(...core.obstacles);}
      for(const tile of needed){
        const mesh=decodeRegionMesh(await checked(tile.file,tile.sha256),tile);
        if(tile.type==='terrain')await applyDemTextHeight(mesh,tile,getDem);
        const index=clippedIndex(mesh,box);if(index)(tile.type==='terrain'?ground:obstacles).push(index);
      }
      return {terrain:ground,obstacles,bounds:buildings.bounds};
    }catch(error){console.warn('Regional placement source unavailable:',error.message);fail(503,'placement_source_unavailable');}
  };
}
export function loadRegionalPlacement(binding,candidate) {
  if(!binding)fail(503,'placement_source_unavailable');
  if(!loaders.has(binding))loaders.set(binding,createRegionPlacementLoader(binding));
  return loaders.get(binding)(candidate);
}
