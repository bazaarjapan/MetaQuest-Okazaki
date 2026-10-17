export const FIELD_STYLE_KEY = 'okazaki-field-style-v1';
export function readFieldStyle(storage) {
  try { return storage?.getItem(FIELD_STYLE_KEY)==='photo'?'photo':'game'; } catch { return 'game'; }
}
export const buildingPalette=['#e7d8b4','#c8d7cb','#d8bca8','#c7d5df','#e3d49c','#c9c5b5'];

// Connected surfaces share a color, including split roof/wall vertices.
// Coordinates and indices are read only; original geometry remains unchanged.
export function buildingColorBytes(positions, indices) {
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
  for(let i=0;i<count;i++){const root=find(i),c=centers.get(root)??[0,0,0];c[0]+=positions[i*3];c[1]+=positions[i*3+2];c[2]++;centers.set(root,c);}
  const colors=new Map([...centers].map(([root,c])=>{const seed=Math.abs(Math.round(c[0]/c[2]*3)*73856093 ^ Math.round(c[1]/c[2]*3)*19349663);
    const hex=buildingPalette[seed%buildingPalette.length];return [root,[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16))];}));
  const bytes=new Uint8Array(count*3);for(let i=0;i<count;i++)bytes.set(colors.get(find(i)),i*3);
  return bytes;
}
export function decorateBuildingGeometry(THREE,geometry) {
  geometry.setAttribute('fieldColor',new THREE.BufferAttribute(buildingColorBytes(geometry.attributes.position.array,geometry.index?.array),3,true));
}
export function createFieldBuildingMaterial(THREE,uniform,options={}) {
  const material=new THREE.MeshStandardMaterial({roughness:1,metalness:0,...options});
  material.onBeforeCompile=shader=>{
    shader.uniforms.fieldGame=uniform;
    shader.vertexShader='attribute vec3 fieldColor; varying vec3 vFieldColor; varying vec3 vFieldPosition; varying vec3 vFieldNormal;\n'+shader.vertexShader;
    shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>',`#include <begin_vertex>
      vFieldColor=fieldColor;vFieldPosition=(modelMatrix*vec4(position,1.0)).xyz;vFieldNormal=normalize(mat3(modelMatrix)*normal);`);
    shader.fragmentShader='uniform float fieldGame; varying vec3 vFieldColor; varying vec3 vFieldPosition; varying vec3 vFieldNormal;\n'+shader.fragmentShader;
    shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>',`#include <color_fragment>
      if(fieldGame>.5){
        vec3 paint=pow(vFieldColor,vec3(2.2));
        float roof=step(.5,abs(vFieldNormal.y));
        paint*=mix(1.0,.66,roof);
        vec2 wall=vec2(abs(vFieldNormal.x)>.5?vFieldPosition.z:vFieldPosition.x,vFieldPosition.y);
        vec2 cell=fract(wall/vec2(2.0,3.2));
        vec2 aa=fwidth(cell)*1.5;
        float windowMask=smoothstep(.16-aa.x,.16+aa.x,cell.x)*(1.0-smoothstep(.72-aa.x,.72+aa.x,cell.x))
          *smoothstep(.27-aa.y,.27+aa.y,cell.y)*(1.0-smoothstep(.75-aa.y,.75+aa.y,cell.y));
        float nearView=1.0-smoothstep(100.0,300.0,distance(cameraPosition,vFieldPosition));
        paint=mix(paint,vec3(.10,.19,.23),windowMask*(1.0-roof)*nearView*.78);
        diffuseColor.rgb=paint;
      }`);
  };
  material.customProgramCacheKey=()=> 'okazaki-field-building-v1';
  return material;
}
