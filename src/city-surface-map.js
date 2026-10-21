import * as THREE from 'three';

// A bounded, local top-down view of the actual loaded geometry. Neither source
// vertices nor collision geometry are changed. Both road layers and their baked
// underlay use the same silhouette, including concave footprints/courtyards.
export const citySurfaceGLSL = `
uniform sampler2D cityBuildings;
uniform sampler2D cityGround;
uniform vec2 cityOrigin;
uniform float citySpan;
uniform float cityTexel;
uniform float cityReady;
vec2 cityUV(vec2 point){vec2 uv=(point-cityOrigin)/citySpan;return vec2(uv.x,1.0-uv.y);}
float cityInside(vec2 uv){return step(0.0,uv.x)*step(uv.x,1.0)*step(0.0,uv.y)*step(uv.y,1.0)*cityReady;}
float cityBuilding(vec2 point){
 vec2 uv=cityUV(point),d=vec2(.35/citySpan);
 float mask=texture2D(cityBuildings,uv).r;
 mask=max(mask,texture2D(cityBuildings,uv+vec2(d.x,0.)).r);
 mask=max(mask,texture2D(cityBuildings,uv-vec2(d.x,0.)).r);
 mask=max(mask,texture2D(cityBuildings,uv+vec2(0.,d.y)).r);
 mask=max(mask,texture2D(cityBuildings,uv-vec2(0.,d.y)).r);
 return smoothstep(.15,.85,mask)*cityInside(uv);
}
float cityHeight(vec2 point,float fallback){
 vec2 uv=cityUV(point);vec4 encodedHeight=texture2D(cityGround,uv);
 // Zero means no measured ground. Do not invent terrain for missing tiles.
 float valid=step(.000001,dot(encodedHeight,vec4(1.0)))*cityInside(uv);
 float height=dot(encodedHeight,vec4(255./256.,255./65536.,255./16777216.,1./16777216.))*4096.-100.;
 return mix(fallback,height,valid);
}
`;

export function attachCitySurfaceShader(shader,uniforms){
 Object.assign(shader.uniforms,uniforms);shader.fragmentShader=citySurfaceGLSL+shader.fragmentShader;
}

export function applyCityGroundMaterial(material,uniforms,gameUniform){
 if(!material||material.userData?.cityGround)return;
 const before=material.onBeforeCompile,key=material.customProgramCacheKey();
 material.userData.cityGround=true;
 material.onBeforeCompile=shader=>{
  before?.(shader);attachCitySurfaceShader(shader,uniforms);shader.uniforms.cityGame=gameUniform;
  shader.vertexShader='varying vec3 vCityGroundWorld;\n'+shader.vertexShader;
  shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\nvCityGroundWorld=(modelMatrix*vec4(position,1.)).xyz;');
  shader.fragmentShader='uniform float cityGame; varying vec3 vCityGroundWorld;\n'+shader.fragmentShader;
  shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>',`#include <color_fragment>
   if(cityGame>.5)diffuseColor.rgb=mix(diffuseColor.rgb,vec3(.53,.57,.51),cityBuilding(vCityGroundWorld.xz));`);
 };
 material.customProgramCacheKey=()=>key+':city-ground-clearance-v1';material.needsUpdate=true;
}

export function createCitySurfaceMap(renderer){
 const empty=new THREE.DataTexture(new Uint8Array(4),1,1);empty.needsUpdate=true;
 const uniforms={cityBuildings:{value:empty},cityGround:{value:empty},cityOrigin:{value:new THREE.Vector2()},citySpan:{value:768},cityTexel:{value:1},cityReady:{value:0}};
 const groundScene=new THREE.Scene(),buildingScene=new THREE.Scene();
 const camera=new THREE.OrthographicCamera(-384,384,384,-384,.1,5000);camera.up.set(0,0,-1);
 const groundMaterial=new THREE.ShaderMaterial({side:THREE.DoubleSide,toneMapped:false,
  vertexShader:'varying float vHeight; void main(){vec4 world=modelMatrix*vec4(position,1.);vHeight=world.y;gl_Position=projectionMatrix*viewMatrix*world;}',
  fragmentShader:'#include <packing>\nvarying float vHeight;void main(){gl_FragColor=packDepthToRGBA((vHeight+100.)/4096.);}' });
 const buildingMaterial=new THREE.MeshBasicMaterial({color:0xffffff,side:THREE.DoubleSide,depthTest:false,depthWrite:false,toneMapped:false});
 const anchoredBuildingMaterial=new THREE.ShaderMaterial({side:THREE.DoubleSide,depthTest:false,depthWrite:false,toneMapped:false,uniforms,
  vertexShader:'attribute vec2 fieldSpan;varying vec3 vCityWorld;varying float vCityBase;void main(){vec4 world=modelMatrix*vec4(position,1.);vCityWorld=world.xyz;vCityBase=(modelMatrix*vec4(position.x,fieldSpan.x,position.z,1.)).y;gl_Position=projectionMatrix*viewMatrix*world;}',
  fragmentShader:citySurfaceGLSL+'varying vec3 vCityWorld;varying float vCityBase;void main(){float ground=cityHeight(vCityWorld.xz,vCityBase);if(vCityWorld.y<ground+.12||vCityBase>ground+2.5)discard;gl_FragColor=vec4(1.);}' });
 let buildingsTarget=null,groundTarget=null,size=0,signature='',last=-Infinity,updates=0,disposed=false,center=null;
 function resize(next){
  if(size===next)return;buildingsTarget?.dispose();groundTarget?.dispose();size=next;
  // R8 at twice the resolution sharpens footprints without increasing the
  // memory budget: 4*size² bytes, equal to an RGBA map at the ground resolution.
  buildingsTarget=new THREE.WebGLRenderTarget(size*2,size*2,{format:THREE.RedFormat,depthBuffer:false,minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter});
  groundTarget=new THREE.WebGLRenderTarget(size,size,{depthBuffer:true,minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter});
  uniforms.cityBuildings.value=buildingsTarget.texture;uniforms.cityGround.value=groundTarget.texture;uniforms.cityTexel.value=768/size;
 }
 function sync(scene,meshes,material){
  scene.clear();
  for(const source of meshes){
   if(!source?.geometry?.attributes.position||!source.visible)continue;
   source.updateWorldMatrix(true,false);const mesh=new THREE.Mesh(source.geometry,material===buildingMaterial&&source.geometry.attributes.fieldSpan?anchoredBuildingMaterial:material);
   mesh.matrixAutoUpdate=false;mesh.matrix.copy(source.matrixWorld);mesh.frustumCulled=true;scene.add(mesh);
  }
 }
 function update({position,terrain=[],buildings=[],quality='high',xr=false,enabled=true,time=performance.now()}){
  if(disposed)return;
  if(!enabled){
   uniforms.cityReady.value=0;
   if(size){buildingsTarget.dispose();groundTarget.dispose();buildingsTarget=groundTarget=null;size=0;groundScene.clear();buildingScene.clear();uniforms.cityBuildings.value=uniforms.cityGround.value=empty;signature='';center=null;}
   return;
  }
  const requestedSize=quality==='performance'?512:xr||quality==='balanced'?1024:2048;
  const nextSize=Math.min(requestedSize,renderer.capabilities.maxTextureSize/2);
  const meshes=[...terrain,...buildings],next=meshes.map(m=>`${m.id}:${m.geometry.id}:${m.geometry.attributes.position.version}`).join(',');
  const moved=!center||Math.hypot(position.x-center.x,position.z-center.z)>20;
  if(size===nextSize&&uniforms.cityReady.value&&signature===next&&!moved)return;
  if(size===nextSize&&uniforms.cityReady.value&&time-last<350)return;
  const saved={target:renderer.getRenderTarget(),viewport:renderer.getViewport(new THREE.Vector4()),scissor:renderer.getScissor(new THREE.Vector4()),scissorTest:renderer.getScissorTest(),clear:renderer.getClearColor(new THREE.Color()),alpha:renderer.getClearAlpha(),autoClear:renderer.autoClear,xr:renderer.xr.enabled};
  try{
   resize(nextSize);center={x:Math.round(position.x/8)*8,z:Math.round(position.z/8)*8};
   camera.position.set(center.x,2500,center.z);camera.lookAt(center.x,0,center.z);camera.updateMatrixWorld();
   uniforms.cityOrigin.value.set(center.x-384,center.z-384);
   sync(groundScene,terrain,groundMaterial);sync(buildingScene,buildings,buildingMaterial);
   renderer.xr.enabled=false;renderer.autoClear=true;renderer.setScissorTest(false);renderer.setClearColor(0,0);
   renderer.setRenderTarget(groundTarget);renderer.render(groundScene,camera);
   uniforms.cityReady.value=terrain.length?1:0;
   renderer.setRenderTarget(buildingsTarget);renderer.render(buildingScene,camera);
   uniforms.cityReady.value=terrain.length?1:0;signature=next;last=time;updates++;
  }finally{
   renderer.setRenderTarget(saved.target);renderer.setViewport(saved.viewport);renderer.setScissor(saved.scissor);renderer.setScissorTest(saved.scissorTest);renderer.setClearColor(saved.clear,saved.alpha);renderer.autoClear=saved.autoClear;renderer.xr.enabled=saved.xr;
  }
 }
 return {uniforms,update,getState:()=>({ready:Boolean(uniforms.cityReady.value),size,footprintSize:size*2,textureBytes:size*size*8,estimatedBytes:size*size*12,updates,terrain:groundScene.children.length,buildings:buildingScene.children.length}),
  dispose(){if(disposed)return;disposed=true;groundScene.clear();buildingScene.clear();buildingsTarget?.dispose();groundTarget?.dispose();empty.dispose();groundMaterial.dispose();buildingMaterial.dispose();anchoredBuildingMaterial.dispose();}};
}
