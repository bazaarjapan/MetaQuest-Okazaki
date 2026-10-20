import fs from 'node:fs/promises';
import {VectorTile} from '@mapbox/vector-tile';
import {PbfReader} from 'pbf';
import {createHash} from 'node:crypto';
import {tileToLonLat,lonLatToWorld} from './lib/region-geo.mjs';
import {roadWidth} from './lib/field-map.mjs';
const roads=[],areas=[],rails=[],landmarks=[],sources=[];
const toPoint=(p,x,y,extent)=>{const [lon,lat]=tileToLonLat(x+p.x/extent,y+p.y/extent,14);const [wx,,wz]=lonLatToWorld(lon,lat);return [wx,wz];};
const files=(await fs.readdir('.cache/game-field')).filter(f=>/^14-\d+-\d+\.pbf$/.test(f)).sort();
for(const file of files){
 const [,sx,sy]=file.match(/^14-(\d+)-(\d+)/),x=+sx,y=+sy;
 const bytes=await fs.readFile('.cache/game-field/'+file),tile=new VectorTile(new PbfReader(bytes));
 let used=false;
 for(const name of ['RdCL','BldA','WA','RailCL','Anno']){
  const layer=tile.layers[name];if(!layer)continue;
  for(let i=0;i<layer.length;i++){
   const f=layer.feature(i),p=f.properties,rings=f.loadGeometry().map(r=>r.map(v=>toPoint(v,x,y,layer.extent)));
   if(name==='Anno'){
    if(['岡崎駅','東岡崎駅','岡崎公園','岡崎城','南公園','シビックセンター'].includes(p.vt_text)){
     const [px,pz]=rings[0][0];if(!landmarks.some(l=>l.name===p.vt_text)){landmarks.push({name:p.vt_text,x:+px.toFixed(2),z:+pz.toFixed(2)});used=true;}
    }
    continue;
   }
   if(!rings.some(r=>r.some(([px,pz])=>Math.abs(px)<2000&&Math.abs(pz)<2000)))continue;
   used=true;
   if(name==='RdCL' && ![2704,2714,2724,2734].includes(p.vt_code))for(const line of rings)roads.push({line,width:roadWidth(p)});
   if(name==='BldA'||name==='WA')areas.push(rings);
   if(name==='RailCL')rails.push(...rings);
  }
 }
 if(used)sources.push({file,sha256:createHash('sha256').update(bytes).digest('hex')});
}
function inside(p,ring){let hit=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const a=ring[i],b=ring[j];if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])hit=!hit;}return hit;}
function distance(p,a,b){const dx=b[0]-a[0],dz=b[1]-a[1],t=Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dz)/(dx*dx+dz*dz||1)));return Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dz);}
const segments=roads.flatMap(r=>r.line.slice(1).map((b,i)=>({a:r.line[i],b,radius:r.width/2+1.3}))).concat(rails.flatMap(line=>line.slice(1).map((b,i)=>({a:line[i],b,radius:4}))));
// Grid keeps generation bounded even with thousands of road segments.
const grid=new Map();for(const s of segments)for(let x=Math.floor((Math.min(s.a[0],s.b[0])-s.radius)/32);x<=Math.floor((Math.max(s.a[0],s.b[0])+s.radius)/32);x++)for(let z=Math.floor((Math.min(s.a[1],s.b[1])-s.radius)/32);z<=Math.floor((Math.max(s.a[1],s.b[1])+s.radius)/32);z++){const k=x+','+z;if(!grid.has(k))grid.set(k,[]);grid.get(k).push(s);}
const areasBounded=areas.map(rings=>({rings,minX:Math.min(...rings.flat().map(p=>p[0])),maxX:Math.max(...rings.flat().map(p=>p[0])),minZ:Math.min(...rings.flat().map(p=>p[1])),maxZ:Math.max(...rings.flat().map(p=>p[1]))}));
const clear=p=>Math.abs(p[0])<1800&&Math.abs(p[1])<1800&&!areasBounded.some(a=>p[0]>=a.minX&&p[0]<=a.maxX&&p[1]>=a.minZ&&p[1]<=a.maxZ&&a.rings.reduce((hit,r)=>hit!==inside(p,r),false))&&!(grid.get(Math.floor(p[0]/32)+','+Math.floor(p[1]/32))??[]).some(s=>distance(p,s.a,s.b)<s.radius);
const trees=[],signals=[],seen=new Set(),junctions=new Map();
function add(list,p,angle=0){const key=Math.round(p[0]/7)+','+Math.round(p[1]/7);if(!clear(p)||seen.has(key))return;seen.add(key);list.push([+p[0].toFixed(2),+p[1].toFixed(2),+angle.toFixed(3)]);}
for(const road of roads){
 if(road.width<8)continue;
 for(const p of [road.line[0],road.line.at(-1)]){const k=Math.round(p[0]/2)+','+Math.round(p[1]/2),v=junctions.get(k)??{p,roads:[]};v.roads.push(road);junctions.set(k,v);}
 let remaining=15;
 for(let i=1;i<road.line.length;i++){
  const a=road.line[i-1],b=road.line[i],dx=b[0]-a[0],dz=b[1]-a[1],length=Math.hypot(dx,dz);if(!length)continue;
  for(;remaining<length;remaining+=38)for(const side of [-1,1])add(trees,[a[0]+dx*remaining/length+dz/length*(road.width/2+3)*side,a[1]+dz*remaining/length-dx/length*(road.width/2+3)*side]);
  remaining-=length;
 }
}
for(const {p,roads:rs} of junctions.values())if(rs.length>=3){
 const r=rs[0],a=r.line[0],b=r.line.at(-1),dx=b[0]-a[0],dz=b[1]-a[1],len=Math.hypot(dx,dz)||1;
 for(const side of [-1,1]){const offset=r.width/2+3;add(signals,[p[0]+(dx+dz)/len*offset*side,p[1]+(dz-dx)/len*offset*side],Math.atan2(dx,dz));}
}
const result={version:1,source:'国土地理院最適化ベクトルタイル',sourceUrl:'https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/optimal_bvmap-v1.pmtiles',note:'道路・目印は地図に基づく。樹木・信号機は道路沿いの装飾で、実在の植生・設備の位置や点灯を再現しない。表示時に実地形へ接地。',trees,signals,landmarks,sources};
await fs.writeFile('public/field/scenery.json',JSON.stringify(result)+'\n');
console.log(JSON.stringify({trees:trees.length,signals:signals.length,landmarks,sources:sources.length}));
