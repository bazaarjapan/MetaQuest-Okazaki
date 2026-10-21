import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import sharp from 'sharp';
const root=new URL('../public/field/',import.meta.url);
const manifest=JSON.parse(await readFile(new URL('manifest.json',root),'utf8'));
const terrain=JSON.parse(await readFile(new URL('../public/region/terrain.json',import.meta.url),'utf8'));
assert.equal(Object.keys(manifest.region).length,terrain.tiles.length);
assert.equal(manifest.core.width,3072);assert.equal(manifest.core.height,2048);
let bytes=0;
for(const [id,width,height] of [['performance',768,512],['balanced',1536,1024],['high',3072,2048]]) {
  assert.equal(manifest.profiles[id].width,width);assert.equal(manifest.profiles[id].height,height);
}
const near=[...manifest.near.core,...Object.values(manifest.near.region)];
assert.equal(manifest.near.core.length,24);assert.equal(Object.keys(manifest.near.region).length,terrain.tiles.length);
for(const patch of manifest.near.core){assert.equal(patch.width,2048);assert.equal(patch.height,2048);}
for(const item of [...Object.values(manifest.profiles),...Object.values(manifest.region),...near]) {
  assert.match(item.file,/^[\w-]+\.webp$/);
  const data=await readFile(new URL(item.file,root)),image=await sharp(data).metadata();
  assert.equal(data.length,item.bytes);assert.equal(createHash('sha256').update(data).digest('hex'),item.sha256);
  assert.equal(image.width,item.width);assert.equal(image.height,item.height);assert.equal(image.format,'webp');
  bytes+=data.length;
}
for(const tile of terrain.tiles)assert.ok(manifest.region[tile.id]);
const scenery=JSON.parse(await readFile(new URL('scenery.json',root),'utf8'));
const vectors=JSON.parse(await readFile(new URL('vector-streets.json',root),'utf8'));
assert.equal(vectors.tiles.length,terrain.tiles.length);
for(const entry of vectors.tiles){
 assert.match(entry.file,/^vectors-g-14-\d+-\d+\.json$/);
 const data=await readFile(new URL(entry.file,root));assert.equal(data.length,entry.bytes);assert.ok(data.length<2*1024*1024);assert.equal(createHash('sha256').update(data).digest('hex'),entry.sha256);
 const value=JSON.parse(data);assert.ok(Array.isArray(value.roads)&&Array.isArray(value.rails)&&Array.isArray(value.crossings));
}
assert.equal(scenery.version,2);
for(const kind of ['trees','signals','lights','grass']){
  assert.ok(scenery[kind].length>0&&scenery[kind].length<20000);
  for(const point of scenery[kind])assert.ok(Array.isArray(point)&&point.length===3&&point.every(Number.isFinite)&&Math.abs(point[0])<1800&&Math.abs(point[1])<1800);
}
assert.ok(scenery.motion.roads.length>0&&scenery.motion.roads.length<=160);
assert.ok(scenery.motion.rails.length>0&&scenery.motion.rails.length<=24);
for(const route of [...scenery.motion.roads,...scenery.motion.rails])assert.ok(route.length>=2&&route.every(p=>p.length===2&&p.every(Number.isFinite)));
assert.equal(scenery.motion.airfield.sourceUrl,'https://www.okazakiglider.jp/gliderport/');
assert.ok(scenery.landmarks.length>=4);
const sourceHashes=new Map(manifest.sourceTiles.map(s=>[`${s.z}-${s.x}-${s.y}.pbf`,s.sha256]));
for(const record of scenery.sources)assert.equal(record.sha256,sourceHashes.get(record.file),record.file);
assert.ok(manifest.core.counts.RdCL>0&&manifest.core.counts.RailCL>0&&manifest.core.counts.WA>0);
console.log(JSON.stringify({passed:true,fieldTextures:3+terrain.tiles.length+near.length,bytes,originalGeometry:'unchanged'}));
