// Download bounded GSI PMTiles ranges once at build time. No map service is
// contacted by players. Source geometry and photos are never overwritten.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {PMTiles} from 'pmtiles';
import {VectorTile} from '@mapbox/vector-tile';
import {PbfReader} from 'pbf';
import sharp from 'sharp';
import {renderFieldSVG} from './lib/field-map.mjs';
import {tileToLonLat} from './lib/region-geo.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source='https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/optimal_bvmap-v1.pmtiles';
const cache=path.join(root,'.cache','game-field'),output=path.join(root,'public','field');
const archive=new PMTiles(source),tiles=new Map(),sourceRecords=[];
const hash=b=>createHash('sha256').update(b).digest('hex');
await fs.mkdir(cache,{recursive:true});await fs.mkdir(output,{recursive:true});
async function load(z,x,y) {
  const key=`${z}-${x}-${y}`; if(tiles.has(key))return tiles.get(key);
  const pending=(async()=>{
    const file=path.join(cache,key+'.pbf');let bytes;
    try{bytes=await fs.readFile(file);}catch(error){if(error.code!=='ENOENT')throw error;}
    if(!bytes){
      const result=await archive.getZxy(z,x,y,AbortSignal.timeout(30000));
      if(!result)throw Error(`Missing GSI vector tile ${key}`);
      bytes=Buffer.from(result.data);if(!bytes.length||bytes.length>8*1024*1024)throw Error('Invalid source tile size');
      await fs.writeFile(file,bytes);
    }
    const tile=new VectorTile(new PbfReader(bytes));
    if(!tile.layers.AdmArea)throw Error(`Unrecognized vector tile ${key}`);
    sourceRecords.push({z,x,y,bytes:bytes.length,sha256:hash(bytes)});
    return {z,x,y,tile};
  })();tiles.set(key,pending);return pending;
}
async function render(view,file) {
  const factor=2**(14-view.zoom),samples=[];
  for(let x=Math.floor(view.x*factor);x<Math.ceil((view.x+view.width/view.unit)*factor);x++)
    for(let y=Math.floor(view.y*factor);y<Math.ceil((view.y+view.height/view.unit)*factor);y++)samples.push(await load(14,x,y));
  const {svg,counts}=renderFieldSVG(samples,view);
  const bytes=await sharp(Buffer.from(svg)).webp({lossless:true}).toBuffer();
  await fs.writeFile(path.join(output,file),bytes);
  return {file,bytes:bytes.length,sha256:hash(bytes),width:view.width,height:view.height,counts};
}
const detail=JSON.parse(await fs.readFile(path.join(root,'public/city/detail.json'),'utf8'));
const atlas=detail.originalAtlas;
if(atlas.zoom!==16||atlas.xMin!==57735||atlas.yMin!==25974||!detail.uvValidation.webAtlasExactPixelEquality)throw Error('Core georeference must be verified');
const core=await render({zoom:16,x:atlas.xMin,y:atlas.yMin,unit:1024,width:3072,height:2048,latitude:34.926},'station.webp');
const profiles={high:{...core}};
for(const [id,width,height] of [['performance',768,512],['balanced',1536,1024]]) {
  const file=`station-${id}.webp`;
  const bytes=await sharp(path.join(output,core.file)).resize(width,height).webp({lossless:true}).toBuffer();
  await fs.writeFile(path.join(output,file),bytes);
  profiles[id]={file,width,height,bytes:bytes.length,sha256:hash(bytes)};
}
const terrain=JSON.parse(await fs.readFile(path.join(root,'public/region/terrain.json'),'utf8'));
const region={};let cursor=0;
const near={core:[],region:{}};
for(let y=0;y<4;y++)for(let x=0;x<6;x++) {
  const patch=await render({zoom:16,x:atlas.xMin+x/2,y:atlas.yMin+y/2,unit:2048,width:1024,height:1024,latitude:34.926},`near-core-${x}-${y}.webp`);
  near.core.push({...patch,rect:[x/6,1-(y+1)/4,(x+1)/6,1-y/4]});
}
await Promise.all(Array.from({length:3},async()=>{while(cursor<terrain.tiles.length){
  const tile=terrain.tiles[cursor++];
  if(tile.zoom!==14)throw Error('Unexpected region tile zoom');
  const latitude=tileToLonLat(tile.x+.5,tile.y+.5,tile.zoom)[1];
  region[tile.id]=await render({zoom:14,x:tile.x,y:tile.y,unit:512,width:512,height:512,latitude},tile.id+'.webp');
  near.region[tile.id]=await render({zoom:14,x:tile.x,y:tile.y,unit:2048,width:2048,height:2048,latitude},'near-'+tile.id+'.webp');
  if(Object.keys(region).length%20===0)console.log(`Field textures ${Object.keys(region).length}/${terrain.tiles.length}`);
}}));
const manifest={version:1,generatedAt:new Date().toISOString(),source:'国土地理院最適化ベクトルタイル',sourceUrl:source,
  attributionUrl:'https://github.com/gsi-cyberjapan/optimal_bvmap',sourceDate:'2026-07-01 (provider metadata, latest may differ)',
  featureCodeUrl:'https://maps.gsi.go.jp/help/pdf/vector/optbv_featurecodes.pdf',
  processing:'道路中心線と幅員・鉄道中心線・水域・河川中心線をゲーム風に描画。分岐方向から交差点の横断歩道・停止線を生成。幅員不明時は幅員区分の代表値。色・有機的な草模様・川岸・水面・道路標示・枕木は装飾。トンネル・地下水路・枯れ川は非表示。橋の高さは再現しない。',
  geography:'既存PLATEAU地形と同じ北向きMercator UV。元の地形・建築形状・写真は保持。',
  core,profiles,near,region:Object.fromEntries(Object.entries(region).sort(([a],[b])=>a.localeCompare(b))),sourceTiles:sourceRecords.sort((a,b)=>a.x-b.x||a.y-b.y)};
await fs.writeFile(path.join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({generated:true,coreBytes:core.bytes,regionTiles:Object.keys(region).length,sourceTiles:sourceRecords.length,regionBytes:Object.values(region).reduce((sum,tile)=>sum+tile.bytes,0)}));
