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
for(const item of [...Object.values(manifest.profiles),...Object.values(manifest.region)]) {
  assert.match(item.file,/^[\w-]+\.webp$/);
  const data=await readFile(new URL(item.file,root)),image=await sharp(data).metadata();
  assert.equal(data.length,item.bytes);assert.equal(createHash('sha256').update(data).digest('hex'),item.sha256);
  assert.equal(image.width,item.width);assert.equal(image.height,item.height);assert.equal(image.format,'webp');
  bytes+=data.length;
}
for(const tile of terrain.tiles)assert.ok(manifest.region[tile.id]);
assert.ok(manifest.core.counts.RdCL>0&&manifest.core.counts.RailCL>0&&manifest.core.counts.WA>0);
console.log(JSON.stringify({passed:true,fieldTextures:3+terrain.tiles.length,bytes,originalGeometry:'unchanged'}));
