// Regenerate only the derived flat templates that touch the original terrain.
// Source PLATEAU, aerial photos, DEM cache and other derived tiles stay intact.
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {coreTerrainFootprint,geometry} from './build-region-terrain.mjs';
const path=new URL('../public/region/terrain.json',import.meta.url),manifest=JSON.parse(await fs.readFile(path,'utf8'));
const {rectangle,masks}=await coreTerrainFootprint();let changed=0;
for(const tile of manifest.tiles){
  const b=tile.bounds;if(b[2]<rectangle[0]||b[0]>rectangle[2]||b[3]<rectangle[1]||b[1]>rectangle[3])continue;
  const result=geometry(tile.x,tile.y,rectangle,masks),sha256=createHash('sha256').update(result.buffer).digest('hex');
  if(sha256===tile.sha256)continue;
  await fs.writeFile(new URL('../public/region/'+tile.file,import.meta.url),result.buffer);
  Object.assign(tile,{vertices:result.vertices,indices:result.indices,triangles:result.triangles,bytes:result.buffer.length,bounds:result.bounds,sha256});changed++;
}
manifest.coreExclusion={type:'exact original Mesh-004 footprint clipping',bounds:rectangle,note:'Only the actual original terrain footprint is excluded; its bounding-box corner strips remain covered by live DEM terrain.'};
manifest.totalTriangles=manifest.tiles.reduce((sum,t)=>sum+t.triangles,0);manifest.totalGeometryBytes=manifest.tiles.reduce((sum,t)=>sum+t.bytes,0);
await fs.writeFile(path,JSON.stringify(manifest,null,2)+'\n');console.log(JSON.stringify({changed,triangles:manifest.totalTriangles,geometryBytes:manifest.totalGeometryBytes}));
