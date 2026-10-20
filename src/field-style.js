export const FIELD_STYLE_KEY = 'okazaki-field-style-v1';
// The station export consists of building material groups plus one terrain
// atlas. A material group is not a building-size or texture-presence test.
export function isCoreBuildingPart(part) {
  return part.texture !== 'Texture-001.png';
}
export function gameTerrainFile(manifest,quality) {
  return '../field/'+(manifest.profiles?.[quality]?.file??manifest.core.file);
}
export function readFieldStyle(storage) {
  try { return storage?.getItem(FIELD_STYLE_KEY)==='photo'?'photo':'game'; } catch { return 'game'; }
}
export const buildingPalette=['#e7d8b4','#c8d7cb','#d8bca8','#c7d5df','#e3d49c','#c9c5b5'];

// Connected surfaces share a color, including split roof/wall vertices.
// Coordinates and indices are read only; original geometry remains unchanged.
export function buildingAttributes(positions, indices) {
  const count=positions.length/3,parent=Uint32Array.from({length:count},(_,i)=>i),seen=new Map();
  const find=i=>{while(parent[i]!==i){parent[i]=parent[parent[i]];i=parent[i];}return i;};
  const join=(a,b)=>{a=find(a);b=find(b);if(a!==b)parent[b]=a;};
  for(let i=0;i<count;i++) {
    const key=`${Math.round(positions[i*3]*100)},${Math.round(positions[i*3+1]*100)},${Math.round(positions[i*3+2]*100)}`;
    if(seen.has(key))join(i,seen.get(key));else seen.set(key,i);
  }
  if(indices)for(let i=0;i<indices.length;i+=3){join(indices[i],indices[i+1]);join(indices[i],indices[i+2]);}
  else for(let i=0;i<count;i+=3){join(i,i+1);join(i,i+2);}
  const centers=new Map();
  const columns=new Map();
  const columnKey=i=>`${find(i)}:${Math.round(positions[i*3]*100)},${Math.round(positions[i*3+2]*100)}`;
  for(let i=0;i<count;i++){
    const root=find(i),y=positions[i*3+1],c=centers.get(root)??[0,0,0,Infinity,-Infinity];
    c[0]+=positions[i*3];c[1]+=positions[i*3+2];c[2]++;c[3]=Math.min(c[3],y);c[4]=Math.max(c[4],y);centers.set(root,c);
    const key=columnKey(i),column=columns.get(key)??[Infinity,-Infinity];column[0]=Math.min(column[0],y);column[1]=Math.max(column[1],y);columns.set(key,column);
  }
  const colors=new Map([...centers].map(([root,c])=>{const seed=Math.abs(Math.round(c[0]/c[2]*3)*73856093 ^ Math.round(c[1]/c[2]*3)*19349663);
    const hex=buildingPalette[seed%buildingPalette.length];return [root,[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16))];}));
  const colorsBytes=new Uint8Array(count*3),spans=new Float32Array(count*2);
  for(let i=0;i<count;i++){
    const root=find(i),component=centers.get(root),column=columns.get(columnKey(i));
    colorsBytes.set(colors.get(root),i*3);spans[i*2]=component[3];
    // Each vertical corner keeps its own roof height. A low wing must not use
    // the tallest tower's roof; roof-only vertices use the component fallback.
    spans[i*2+1]=column[1]-column[0]>.1?column[1]:component[4];
  }
  const triangles=(indices?.length??count)/3,ceilings=new Float32Array(triangles);ceilings.fill(NaN);
  for(let t=0;t<triangles;t++){
    const ids=[0,1,2].map(k=>indices?indices[t*3+k]:t*3+k),[a,b,c]=ids.map(i=>i*3);
    const ux=positions[b]-positions[a],uy=positions[b+1]-positions[a+1],uz=positions[b+2]-positions[a+2],vx=positions[c]-positions[a],vy=positions[c+1]-positions[a+1],vz=positions[c+2]-positions[a+2];
    const nx=uy*vz-uz*vy,ny=uz*vx-ux*vz,nz=ux*vy-uy*vx;
    if(Math.abs(ny)<Math.hypot(nx,ny,nz)*.5)ceilings[t]=Math.min(Math.max(...ids.map(i=>positions[i*3+1])),...ids.map(i=>spans[i*2+1]));
  }
  return {colors:colorsBytes,spans,ceilings};
}
export function buildingColorBytes(positions,indices) {
  return buildingAttributes(positions,indices).colors;
}
export function decorateBuildingGeometry(THREE,geometry) {
  const attributes=buildingAttributes(geometry.attributes.position.array,geometry.index?.array);
  const count=geometry.attributes.position.array.length/3,sourceIndex=geometry.index?.array,indices=sourceIndex?.slice(),mapping=Array.from({length:count},(_,i)=>i),tops=new Array(count),variants=new Map();
  for(let t=0;t<attributes.ceilings.length;t++)for(let k=0;k<3;k++){
    const at=t*3+k,i=sourceIndex?sourceIndex[at]:at,top=Number.isFinite(attributes.ceilings[t])?attributes.ceilings[t]:attributes.spans[i*2+1];
    if(tops[i]===undefined||tops[i]===top){tops[i]=top;continue;}
    const key=`${i}:${top}`;let target=variants.get(key);
    if(target===undefined){target=mapping.length;mapping.push(i);tops.push(top);variants.set(key,target);}indices[at]=target;
  }
  if(mapping.length>count){
    // Split only shared vertices whose two facades need different roof caps.
    // Triangle coordinates, source buffers and the original model stay intact.
    for(const [name,attribute] of Object.entries(geometry.attributes)){
      const array=new attribute.array.constructor(mapping.length*attribute.itemSize);
      mapping.forEach((source,i)=>array.set(attribute.array.subarray(source*attribute.itemSize,(source+1)*attribute.itemSize),i*attribute.itemSize));
      geometry.setAttribute(name,new THREE.BufferAttribute(array,attribute.itemSize,attribute.normalized));
    }
    geometry.setIndex(new THREE.BufferAttribute(indices,1));
  }
  const colors=new Uint8Array(mapping.length*3),spans=new Float32Array(mapping.length*2);
  mapping.forEach((source,i)=>{colors.set(attributes.colors.subarray(source*3,source*3+3),i*3);spans[i*2]=attributes.spans[source*2];spans[i*2+1]=tops[i]??attributes.spans[source*2+1];});
  geometry.setAttribute('fieldColor',new THREE.BufferAttribute(colors,3,true));
  geometry.setAttribute('fieldSpan',new THREE.BufferAttribute(spans,2));
}
export function createFieldBuildingMaterial(THREE,uniform,options={}) {
  const material=new THREE.MeshStandardMaterial({roughness:1,metalness:0,...options});
  material.userData??={};material.userData.fieldBuilding=true;
  material.onBeforeCompile=shader=>{
    shader.uniforms.fieldGame=uniform;
    shader.vertexShader='attribute vec3 fieldColor; attribute vec2 fieldSpan; varying vec2 vFieldSpan; varying vec3 vFieldColor; varying vec3 vFieldPosition; varying vec3 vFieldNormal;\n'+shader.vertexShader;
    shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>',`#include <begin_vertex>
      vFieldColor=fieldColor;vFieldPosition=(modelMatrix*vec4(position,1.0)).xyz;vFieldNormal=normalize(mat3(modelMatrix)*normal);
      vFieldSpan=vec2((modelMatrix*vec4(position.x,fieldSpan.x,position.z,1.0)).y,(modelMatrix*vec4(position.x,fieldSpan.y,position.z,1.0)).y);`);
    shader.fragmentShader='uniform float fieldGame; varying vec2 vFieldSpan; varying vec3 vFieldColor; varying vec3 vFieldPosition; varying vec3 vFieldNormal;\n'+shader.fragmentShader;
    // Keep the original map bound for photo mode, but do not sample or multiply
    // it into a game-style facade. The uniform switches both modes atomically.
    shader.fragmentShader=shader.fragmentShader.replace('#include <map_fragment>',`if(fieldGame<.5){
      #include <map_fragment>
    }`);
    shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>',`#include <color_fragment>
      if(fieldGame>.5){
        vec3 paint=pow(vFieldColor,vec3(2.2));
        float roof=step(.5,abs(vFieldNormal.y));
        vec2 wall=vec2(abs(vFieldNormal.x)>.5?vFieldPosition.z:vFieldPosition.x,vFieldPosition.y-vFieldSpan.x);
        vec2 cell=fract(wall/vec2(2.0,3.2));
        vec2 aa=max(fwidth(wall/vec2(2.0,3.2))*1.5,vec2(.001));
        // Test the entire window, including a sloping roof, before drawing any
        // of it. The upper floor becomes a solid parapet instead of half glass.
        float windowTop=vFieldSpan.x+floor(wall.y/3.2)*3.2+2.4;
        float completeWindow=step(windowTop+.65,vFieldSpan.y)*step(0.0,wall.y);
        float windowMask=smoothstep(.16-aa.x,.16+aa.x,cell.x)*(1.0-smoothstep(.72-aa.x,.72+aa.x,cell.x))
          *smoothstep(.27-aa.y,.27+aa.y,cell.y)*(1.0-smoothstep(.75-aa.y,.75+aa.y,cell.y))*completeWindow;
        float nearView=1.0-smoothstep(100.0,300.0,distance(cameraPosition,vFieldPosition));
        float floorBand=1.0-smoothstep(.025,.065,cell.y);
        paint*=1.0-floorBand*(1.0-roof)*nearView*.16;
        vec3 glass=mix(vec3(.07,.16,.19),vec3(.28,.40,.43),cell.y);
        float frame=windowMask*(1.0-smoothstep(.035,.065,abs(cell.x-.44)));
        paint=mix(paint,glass,windowMask*(1.0-roof)*nearView*.85);
        paint=mix(paint,vec3(.48,.53,.49),frame*(1.0-roof)*nearView*.6);
        float roofDistance=vFieldSpan.y-vFieldPosition.y;
        float coping=(1.0-smoothstep(.16,.27,roofDistance))*(1.0-roof);
        paint=mix(paint,vec3(.48,.51,.49),coping*.8);
        vec3 roofPaint=mix(paint*.42,vec3(.20,.24,.25),.45);
        roofPaint*=.98+.02*sin(vFieldPosition.x*2.8)*sin(vFieldPosition.z*2.8);
        paint=mix(paint,roofPaint,roof);
        diffuseColor.rgb=paint;
      }`);
  };
  material.customProgramCacheKey=()=> 'okazaki-field-building-v4';
  return material;
}
