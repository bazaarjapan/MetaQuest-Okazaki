export const fieldPalette = Object.freeze({ grass:'#a4bc79',grassLight:'#acc381',grassDark:'#9cb573',
  water:'#58adcd',waterLight:'#7cc5df',shore:'#d8d4a2',paving:'#c7c7b5',road:'#626e70',curb:'#ccd1c1',
  marking:'#ede5bd',ballast:'#88918a',sleepers:'#5c5c53',rail:'#d7ded9' });

export function roadWidth(properties) {
  const measured = Number(properties.vt_width) / 100;
  if (Number.isFinite(measured) && measured > 0) return Math.max(1.5, Math.min(40, measured));
  return ({'3m未満':2.5,'3m-5.5m未満':4.5,'5.5m-13m未満':9,'13m-19.5m未満':16,'19.5m以上':24})[properties.vt_rnkwidth] ?? 4.5;
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
    `<defs><pattern ${pattern('grass',grassSize)} viewBox="0 0 32 32"><rect width="32" height="32" fill="${palette.grass}"/><path d="M0 0h16v16H0zM16 16h16v16H16z" fill="${palette.grassLight}"/><path d="M6 6h4v4H6zM24 2h3v3h-3zM2 24h4v4H2z" fill="${palette.grassDark}" opacity=".5"/></pattern><pattern ${pattern('water',grassSize*.75)} viewBox="0 0 32 24"><rect width="32" height="24" fill="${palette.water}"/><path d="M4 6h10M20 18h8" stroke="${palette.waterLight}" stroke-width="1.5"/></pattern></defs>`,
    `<rect width="100%" height="100%" fill="url(#grass)"/>`];
  for(const e of layers.TpgphArea) if([7401,7402,7403].includes(e.p.vt_code)) parts.push(path(e.d,`fill="${e.p.vt_code===7402?'#c8c4ae':'#88aa6b'}" fill-rule="evenodd"`));
  for(const e of layers.BldA) parts.push(path(e.d,`fill="${palette.paving}" fill-rule="evenodd"`));
  for(const e of layers.WA) parts.push(path(e.d,`fill="url(#water)" fill-rule="evenodd" stroke="${palette.shore}" stroke-width="${px(.8)}"`));
  for(const e of layers.RvrCL) parts.push(line(e,palette.water,2));
  // Curbs first, then all road surfaces: junctions have no crossing outline.
  const roads=layers.RdCL.filter(e=>![2721,2722,2723,2724].includes(e.p.vt_code));
  for(const e of roads) parts.push(line(e,palette.curb,roadWidth(e.p)+1.2));
  for(const e of roads) parts.push(line(e,palette.road,roadWidth(e.p)));
  for(const e of roads) if(roadWidth(e.p)>=7) parts.push(line(e,palette.marking,.18,`stroke-dasharray="${px(4)} ${px(5)}"`));
  for(const e of layers.RailCL) {
    if(['トンネル','地下','雪覆い'].includes(e.p.vt_railstate))continue;
    parts.push(line(e,palette.ballast,5),line(e,palette.rail,2.3),line(e,palette.ballast,1.55),
      line(e,palette.sleepers,3.2,`stroke-dasharray="${px(.5)} ${px(2)}"`,'butt'));
  }
  parts.push('</svg>');
  return {svg:parts.join(''),counts:Object.fromEntries(Object.entries(layers).map(([key,features])=>[key,features.length]))};
}
