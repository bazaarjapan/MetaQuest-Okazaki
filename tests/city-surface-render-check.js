import * as THREE from 'three';
import {createCitySurfaceMap,applyCityGroundMaterial,attachCitySurfaceShader} from '../src/city-surface-map.js';
import {createFieldBuildingMaterial,decorateBuildingGeometry} from '../src/field-style.js';
import {createVectorStreets} from '../src/vector-streets.js';

// Actual WebGL checks. In particular, a bounding-box mask would incorrectly
// erase the road in the open corner of this L-shaped building.
export function checkCitySurfaceRendering(){
 const renderer=new THREE.WebGLRenderer({antialias:false}),shaderErrors=[];renderer.setSize(256,256);
 renderer.debug.onShaderError=()=>shaderErrors.push('shader compilation failed');
 const map=createCitySurfaceMap(renderer),target=new THREE.WebGLRenderTarget(256,256),pixels=new Uint8Array(256*256*4),game={value:1};
 const terrain=new THREE.Mesh(new THREE.PlaneGeometry(120,120),new THREE.MeshBasicMaterial({color:0x555555}));terrain.geometry.rotateX(-Math.PI/2);terrain.geometry.translate(0,20,0);applyCityGroundMaterial(terrain.material,map.uniforms,game);
 const buildings=[new THREE.Mesh(new THREE.BoxGeometry(4,8,14)),new THREE.Mesh(new THREE.BoxGeometry(12,8,4)),new THREE.Mesh(new THREE.BoxGeometry(4,4,8)),new THREE.Mesh(new THREE.BoxGeometry(4,4,8))];buildings[0].position.set(-5,22,0);buildings[1].position.set(0,22,-5);buildings[2].position.set(12,32,4);buildings[3].position.set(-15,12,4);buildings.forEach(m=>decorateBuildingGeometry(THREE,m.geometry));
 const source=JSON.stringify(buildings.map(m=>[...m.geometry.attributes.position.array]));
 const options={position:new THREE.Vector3(),terrain:[terrain],buildings,quality:'high',time:0};
 renderer.xr.enabled=true;renderer.setRenderTarget(target);renderer.setViewport(3,5,120,130);renderer.setScissor(2,4,100,110);renderer.setScissorTest(true);
 map.update(options);
 const restored=renderer.getRenderTarget()===target&&renderer.getViewport(new THREE.Vector4()).equals(new THREE.Vector4(3,5,120,130))&&renderer.getScissor(new THREE.Vector4()).equals(new THREE.Vector4(2,4,100,110))&&renderer.getScissorTest()&&renderer.xr.enabled;
 renderer.setViewport(0,0,256,256);renderer.setScissorTest(false);renderer.xr.enabled=false;
 const scene=new THREE.Scene();scene.background=new THREE.Color(0);scene.add(terrain,new THREE.AmbientLight(0xffffff,3));
 const streets=createVectorStreets({scene,citySurfaceUniforms:map.uniforms});streets.setData({roads:[{line:[[-30,4],[30,4]],width:4}],rails:[],junctions:[],crossings:[]});
 for(let i=0;i<100;i++)streets.update({position:new THREE.Vector3(),terrain:[terrain],terrainVersion:'test'});
 const camera=new THREE.OrthographicCamera(-20,20,20,-20,.1,200);camera.position.set(0,100,0);camera.up.set(0,0,-1);camera.lookAt(0,0,0);
 const render=()=>{renderer.setRenderTarget(target);renderer.render(scene,camera);renderer.readRenderTargetPixels(target,0,0,256,256,pixels);};
 const pixel=(x,z)=>{const col=Math.floor((x+20)/40*256),row=Math.floor((20-z)/40*256),i=(row*256+col)*4;return [...pixels.slice(i,i+3)];};
 render();const covered=pixel(-5,4),openCorner=pixel(6,4),underBridge=pixel(12,4),buriedBuilding=pixel(-15,4);
 const before=map.getState().updates;for(let i=0;i<100;i++)map.update({...options,time:1000+i});const cached=map.getState().updates===before;
 map.update({...options,buildings:[],time:1500});render();const afterUnload=pixel(-5,4);
 map.update({...options,time:1900});
 // Read the encoded measured elevation through the same shader helper used by
 // facades, rather than comparing a JavaScript reimplementation of the math.
 const diagnostic=new THREE.ShaderMaterial({vertexShader:'void main(){gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',fragmentShader:'void main(){float error=abs(cityHeight(vec2(0.),0.)-20.);gl_FragColor=error<.01?vec4(0.,1.,0.,1.):vec4(1.,0.,0.,1.);}'});
 diagnostic.onBeforeCompile=s=>attachCitySurfaceShader(s,map.uniforms);
 const probe=new THREE.Mesh(new THREE.PlaneGeometry(40,40),diagnostic);probe.rotation.x=-Math.PI/2;probe.position.y=30;scene.add(probe);render();const measured=pixel(0,0);scene.remove(probe);
 // Same original wall, with/without correction. A formerly half-buried window
 // at 20.2m must disappear; a complete visible first-floor window at 21.6m
 // must appear. The source base remains 18m and the roof remains 26m.
 const wallGeometry=new THREE.PlaneGeometry(12,8);wallGeometry.translate(0,22,0);decorateBuildingGeometry(THREE,wallGeometry);
 const material=createFieldBuildingMaterial(THREE,game,{citySurfaceUniforms:map.uniforms}),wall=new THREE.Mesh(wallGeometry,material),wallScene=new THREE.Scene();wallScene.add(wall,new THREE.AmbientLight(0xffffff,3));
 const wallCamera=new THREE.OrthographicCamera(-6,6,4,-4,.1,100);wallCamera.position.set(0,22,20);wallCamera.lookAt(0,22,0);
 const wallRender=()=>{renderer.setRenderTarget(target);renderer.render(wallScene,wallCamera);renderer.readRenderTargetPixels(target,0,0,256,256,pixels);};
 const wallPixel=y=>{const i=(Math.floor((y-18)/8*256)*256+Math.floor(6.5/12*256))*4;return [...pixels.slice(i,i+3)];};
 wallRender();const correctedLow=wallPixel(20.2),correctedWindow=wallPixel(21.6);
 map.uniforms.cityReady.value=0;wallRender();const formerLow=wallPixel(20.2),formerWindow=wallPixel(21.6);map.uniforms.cityReady.value=1;
 map.update({...options,xr:true,time:2000});const xr=map.getState();
 map.update({...options,enabled:false,time:3000});const released=map.getState();
 const unchanged=source===JSON.stringify(buildings.map(m=>[...m.geometry.attributes.position.array]));
 const glError=renderer.getContext().getError();
 const result={covered,openCorner,underBridge,buriedBuilding,afterUnload,measured,correctedLow,correctedWindow,formerLow,formerWindow,restored,cached,xr,released,unchanged,shaderErrors,glError};
 streets.dispose();map.dispose();target.dispose();terrain.geometry.dispose();terrain.material.dispose();buildings.forEach(m=>{m.geometry.dispose();m.material.dispose();});probe.geometry.dispose();diagnostic.dispose();wallGeometry.dispose();material.dispose();renderer.dispose();renderer.forceContextLoss();return result;
}
