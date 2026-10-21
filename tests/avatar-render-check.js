// Real WebGL regression: render the production street layers and shared names.
import * as THREE from 'three';
import {createAvatarLabel} from '../src/avatar-label.js';
import {createVectorStreets} from '../src/vector-streets.js';
export function checkAvatarRendering() {
  const renderer=new THREE.WebGLRenderer({antialias:false}); renderer.setSize(256,256);
  const target=new THREE.WebGLRenderTarget(256,256),pixels=new Uint8Array(256*256*4);
  const scene=new THREE.Scene();scene.background=new THREE.Color(0x88bbdd);
  scene.add(new THREE.AmbientLight(0xffffff,3));
  const parent=new THREE.Group();scene.add(parent);
  const label=createAvatarLabel(THREE,{parent});label.setName('安藤先生');
  const sprite=parent.children[0],camera=new THREE.PerspectiveCamera(45,1,.1,200);
  camera.position.set(0,7,10);camera.lookAt(0,2.16,0);
  const geometry=new THREE.PlaneGeometry(100,100);geometry.rotateX(-Math.PI/2);
  const terrain=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({color:0x77aa66}));scene.add(terrain);
  const streets=createVectorStreets({scene});
  streets.setData({roads:[{line:[[-45,0],[45,0]],width:40}],rails:[],junctions:[],crossings:[]});
  for(let i=0;i<100;i++)streets.update({position:new THREE.Vector3(),terrain:[terrain],terrainVersion:'test'});
  const sample=()=>{renderer.setRenderTarget(target);renderer.render(scene,camera);renderer.readRenderTargetPixels(target,0,0,256,256,pixels);let text=0;for(let y=124;y<132;y++)for(let x=115;x<141;x++){const i=(y*256+x)*4;if(pixels[i]>180&&pixels[i+1]>180&&pixels[i+2]>180)text++;}return text;};
  const visible=sample();
  const order=sprite.renderOrder;sprite.renderOrder=0;const former=sample();sprite.renderOrder=order;
  const occluder=new THREE.Mesh(new THREE.PlaneGeometry(6,6),new THREE.MeshBasicMaterial({color:0xff0000,side:THREE.DoubleSide}));
  occluder.position.copy(camera.position).lerp(new THREE.Vector3(0,2.16,0),.7);occluder.quaternion.copy(camera.quaternion);scene.add(occluder);
  const hidden=sample();
  const result={visible,former,hidden,depthTest:sprite.material.depthTest,streetTriangles:streets.getState().triangles};
  label.dispose();streets.dispose();geometry.dispose();terrain.material.dispose();occluder.geometry.dispose();occluder.material.dispose();target.dispose();renderer.dispose();renderer.forceContextLoss();return result;
}
