// Derive editable line geometry from the same cached, attributed GSI tiles.
import fs from 'node:fs/promises';
import {VectorTile} from '@mapbox/vector-tile';
import {PbfReader} from 'pbf';
import {createHash} from 'node:crypto';
import {tileToLonLat,lonLatToWorld} from './lib/region-geo.mjs';
import {roadWidth} from './lib/field-map.mjs';
import {roadJunctions,crossingLayout} from './lib/street-layout.mjs';
const roads=[],rails=[],tiles=[];
const terrain=JSON.parse(await fs.readFile('public/region/terrain.json','utf8'));
for(const file of (await fs.readdir('.cache/game-field')).filter(f=>/^14-\d+-\d+\.pbf$/.test(f)).sort()){
 const [,x,y]=file.match(/^14-(\d+)-(\d+)/),bytes=await fs.readFile('.cache/game-field/'+file),tile=new VectorTile(new PbfReader(bytes));
 const tileRoads=[],tileRails=[];
 for(const name of ['RdCL','RailCL']){
  const layer=tile.layers[name];if(!layer)continue;
  for(let i=0;i<layer.length;i++){
   const f=layer.feature(i),p=f.properties;
   if(name==='RdCL'&&([2704,2714,2724,2734].includes(p.vt_code)||(p.vt_lvorder??0)!==0))continue;
   if(name==='RailCL'&&['トンネル','地下','雪覆い'].includes(p.vt_railstate))continue;
   for(const line of f.loadGeometry()){
    const points=line.map(v=>{const w=lonLatToWorld(...tileToLonLat(+x+v.x/layer.extent,+y+v.y/layer.extent,14));return [+w[0].toFixed(3),+w[2].toFixed(3)];});
    if(points.length<2)continue;
    (name==='RdCL'?tileRoads:tileRails).push({line:points,width:name==='RdCL'?roadWidth(p):5});
   }
  }
 }
 roads.push(...tileRoads);rails.push(...tileRails);
 const entry=terrain.tiles.find(t=>t.x===+x&&t.y===+y);if(entry)tiles.push({id:entry.id,bounds:entry.bounds,roads:tileRoads,rails:tileRails,source:{file,sha256:createHash('sha256').update(bytes).digest('hex')}});
}
const junctions=roadJunctions(roads),crossings=junctions.flatMap(crossingLayout);
const entries=[];
for(const tile of tiles){
 const [x0,z0,x1,z1]=tile.bounds,inside=p=>p[0]>=x0-50&&p[0]<=x1+50&&p[1]>=z0-50&&p[1]<=z1+50;
 const data={roads:tile.roads,rails:tile.rails,junctions:junctions.filter(j=>inside(j.point)).map(j=>({point:j.point,radius:j.radius+6})),crossings:crossings.filter(c=>inside(c.center))};
 const file='vectors-'+tile.id+'.json',bytes=Buffer.from(JSON.stringify(data)+'\n');await fs.writeFile('public/field/'+file,bytes);
 entries.push({id:tile.id,bounds:tile.bounds,file,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),source:tile.source});
}
const result={version:1,source:'国土地理院最適化ベクトルタイル',sourceUrl:'https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/optimal_bvmap-v1.pmtiles',note:'道路中心線と幅員から描画用の面を生成。レール・枕木・横断歩道は装飾。既存地形に投影し、地形や衝突判定は変更しない。',tiles:entries};
await fs.writeFile('public/field/vector-streets.json',JSON.stringify(result)+'\n');
console.log(JSON.stringify({roads:roads.length,rails:rails.length,crossings:crossings.length,tiles:entries.length}));
