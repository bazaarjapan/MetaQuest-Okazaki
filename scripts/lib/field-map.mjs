import {tileToLonLat,lonLatToWorld,worldToLonLat,lonLatToTile} from './region-geo.mjs';
import {roadJunctions,crossingLayout} from './street-layout.mjs';
export const fieldPalette = Object.freeze({ grass:'#94ad78',grassLight:'#9cb681',grassDark:'#87a16d',
  water:'#4e9baa',waterLight:'#78b8bf',shore:'#b8c4a6',paving:'#c3c3b3',road:'#586567',curb:'#c9cfbf',
  marking:'#ede5bd',ballast:'#88918a',sleepers:'#5c5c53',rail:'#d7ded9' });

export function roadWidth(properties) {
  const measured = Number(properties.vt_width) / 100;
  if (Number.isFinite(measured) && measured > 0) return Math.max(1.5, Math.min(40, measured));
  return ({'3m未満':2.5,'3m-5.5m未満':4.5,'5.5m-13m未満':9,'13m-19.5m未満':16,'19.5m以上':24})[properties.vt_rnkwidth] ?? 4.5;
}

const roadCache=new WeakMap();
function tileRoads({tile,z,x,y}) {
  if(roadCache.has(tile))return roadCache.get(tile);
  const layer=tile.layers.RdCL,roads=[];
  if(layer)for(let i=0;i<layer.length;i++) {
    const f=layer.feature(i),p=f.properties;
    if([2704,2714,2724,2734].includes(p.vt_code))continue;
    for(const line of f.loadGeometry()) {
      const points=line.map(v=>{const geo=tileToLonLat(x+v.x/layer.extent,y+v.y/layer.extent,z),w=lonLatToWorld(...geo);return [w[0],w[2]];});
      if(points.every(p=>p.every(Number.isFinite)))roads.push({line:points,width:roadWidth(p)});
    }
  }
  roadCache.set(tile,roads);return roads;
}

// Tile-space coordinates keep the existing north-up atlas UVs exactly aligned.
export function mapPoint(point, tile, extent, view) {
  const factor = 2 ** (view.zoom - tile.z);
  return [(tile.x + point.x / extent) * factor * view.unit - view.x * view.unit,
    (tile.y + point.y / extent) * factor * view.unit - view.y * view.unit];
}

export function renderFieldSVG(tiles, view) {
  const palette=fieldPalette, layers={WA:[],RvrCL:[],RdCL:[],RailCL:[],BldA:[],TpgphArea:[]};
  const metersPerPixel = 40075016.68557849 * Math.cos(view.latitude * Math.PI/180) / (2**view.zoom * view.unit);
  const px = meters => Math.max(.15,meters/metersPerPixel);
  const junctions=roadJunctions(tiles.flatMap(tileRoads));
  const screen=point=>{const [lon,lat]=worldToLonLat(...point),[x,y]=lonLatToTile(lon,lat,view.zoom);return [(x-view.x)*view.unit,(y-view.y)*view.unit];};
  for(const {z,x,y,tile} of tiles) for(const key of Object.keys(layers)) {
    const layer=tile.layers[key]; if(!layer)continue;
    for(let i=0;i<layer.length;i++) {
      const feature=layer.feature(i), geometry=feature.loadGeometry();
      if(feature.type!==2 && feature.type!==3)continue;
      const d=geometry.map(ring=>ring.map((point,j)=>{const p=mapPoint(point,{z,x,y},layer.extent,view);
        return `${j?'L':'M'}${p[0].toFixed(2)},${p[1].toFixed(2)}`;}).join('')+(feature.type===3?'Z':'')).join('');
      if(d)layers[key].push({d,p:feature.properties});
    }
  }
  const path=(d,attributes)=>`<path d="${d}" ${attributes}/>`;
  const line=(entry,color,width,extra='',cap='round')=>path(entry.d,`fill="none" stroke="${color}" stroke-width="${px(width).toFixed(3)}" stroke-linecap="${cap}" stroke-linejoin="round" ${extra}`);
  const grassSize=view.unit*2**(view.zoom-14)/128;
  const pattern=(id,height)=>`id="${id}" width="${grassSize}" height="${height}" x="${-(view.x*view.unit%grassSize)}" y="${-(view.y*view.unit%height)}" patternUnits="userSpaceOnUse"`;
  const parts=[`<svg xmlns="http://www.w3.org/2000/svg" width="${view.width}" height="${view.height}" viewBox="0 0 ${view.width} ${view.height}">`,
    `<defs><pattern ${pattern('grass',grassSize)} viewBox="0 0 32 32"><rect width="32" height="32" fill="${palette.grass}"/><path d="M0 6Q9 1 17 6T35 6M-3 22Q8 15 19 21T35 22" stroke="${palette.grassLight}" stroke-width="6" fill="none" opacity=".4"/><path d="M6 8l2-1m12 17l3-1m5-20l1-1M3 29l2-1" stroke="${palette.grassDark}" opacity=".5"/></pattern><pattern ${pattern('water',grassSize*.75)} viewBox="0 0 32 24"><rect width="32" height="24" fill="${palette.water}"/><path d="M-3 7Q3 4 10 7T24 7T38 7M12 18q6-3 12 0" stroke="${palette.waterLight}" stroke-width=".8" fill="none" opacity=".65"/></pattern></defs>`,
    `<rect width="100%" height="100%" fill="url(#grass)"/>`];
  for(const e of layers.TpgphArea) if([7401,7402,7403].includes(e.p.vt_code)) parts.push(path(e.d,`fill="${({7401:'#88aa6b',7402:'#e9eff1',7403:'#d2c6a1'})[e.p.vt_code]}" fill-rule="evenodd"`));
  for(const e of layers.BldA) parts.push(path(e.d,`fill="${palette.paving}" fill-rule="evenodd"`));
  for(const e of layers.WA) parts.push(path(e.d,`fill="url(#water)" fill-rule="evenodd" stroke="${palette.grassDark}" stroke-width="${px(4)}"`),path(e.d,`fill="url(#water)" fill-rule="evenodd" stroke="${palette.shore}" stroke-width="${px(1.2)}"`));
  // GSI feature-code table: 5302 is dry, 5322 is underground.
  for(const e of layers.RvrCL) if(![5302,5322].includes(e.p.vt_code))parts.push(line(e,palette.water,2));
  // Curbs first, then all road surfaces: junctions have no crossing outline.
  const roads=layers.RdCL.filter(e=>![2704,2714,2724,2734].includes(e.p.vt_code));
  for(const e of roads) parts.push(line(e,palette.curb,roadWidth(e.p)+1.2));
  for(const e of roads) parts.push(line(e,palette.road,roadWidth(e.p)));
  const holes=junctions.map(j=>{const [x,y]=screen(j.point);return `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${px(j.radius+6).toFixed(2)}" fill="black"/>`;}).join('');
  parts.push(`<defs><mask id="road-marking-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="${view.width}" height="${view.height}"><rect width="100%" height="100%" fill="white"/>${holes}</mask></defs><g mask="url(#road-marking-mask)">`);
  for(const e of roads) if(roadWidth(e.p)>=6) parts.push(line(e,palette.marking,.16,`stroke-dasharray="${px(4)} ${px(5)}"`));
  parts.push('</g>');
  let crossings=0;
  const marking=(center,direction,normal,length,width)=>{
    const corners=[[-1,-1],[-1,1],[1,1],[1,-1]].map(([a,b])=>screen([center[0]+direction[0]*length/2*a+normal[0]*width/2*b,center[1]+direction[1]*length/2*a+normal[1]*width/2*b]));
    return `<polygon points="${corners.map(p=>p.map(v=>v.toFixed(2)).join(',')).join(' ')}" fill="#eeeedd"/>`;
  };
  for(const j of junctions)for(const c of crossingLayout(j)) {
    const [x,y]=screen(c.center),pad=px(c.width+5);if(x < -pad || y < -pad || x>view.width+pad || y>view.height+pad)continue;
    const stripes=Math.max(3,Math.floor((c.width-1)/1.05)),span=stripes*1.05;
    parts.push('<g data-crosswalk="decorative">');
    for(let i=0;i<stripes;i++)parts.push(marking([c.center[0]+c.normal[0]*((i+.5)*1.05-span/2),c.center[1]+c.normal[1]*((i+.5)*1.05-span/2)],c.direction,c.normal,3,.5));
    parts.push(marking([c.stop[0]+c.normal[0]*c.width*.23,c.stop[1]+c.normal[1]*c.width*.23],c.direction,c.normal,.35,c.width*.42),'</g>');crossings++;
  }
  for(const e of layers.RailCL) {
    if(['トンネル','地下','雪覆い'].includes(e.p.vt_railstate))continue;
    parts.push(line(e,palette.ballast,5),line(e,palette.rail,2.3),line(e,palette.ballast,1.55),
      line(e,palette.sleepers,3.2,`stroke-dasharray="${px(.5)} ${px(2)}"`,'butt'));
  }
  parts.push('</svg>');
  return {svg:parts.join(''),counts:{...Object.fromEntries(Object.entries(layers).map(([key,features])=>[key,features.length])),crossings}};
}
