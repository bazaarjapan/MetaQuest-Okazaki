import * as THREE from "three";
import { validatePlacement } from "./placement.js";
import { sharedObjectOverlap } from "./workshop-access.js";

export const sceneryLimits = Object.freeze({ performance: [0,0], balanced: [80,8], high: [180,16] });
const footprint = new Float32Array([-1,0,-1, 1,0,-1, 1,0,1]);
export function sceneryCandidates(entries, position, limit, radius = 420) {
  return entries.map(entry => ({ entry, distance: Math.hypot(entry[0]-position.x,entry[1]-position.z) }))
    .filter(item => item.distance < radius).sort((a,b) => a.distance-b.distance).slice(0,limit*3).map(item=>item.entry);
}
export function createStreetScenery({scene, getEnvironment}) {
  const group = new THREE.Group(); group.name = "decorative-street-scenery"; scene.add(group);
  const matrix = new THREE.Object3D(), tint = new THREE.Color();
  const make = (geometry,color,count) => {
    const material = new THREE.MeshStandardMaterial({color,roughness:.9});
    const mesh = new THREE.InstancedMesh(geometry,material,count); mesh.count=0; mesh.frustumCulled=false;
    group.add(mesh); return mesh;
  };
  const trunks=make(new THREE.CylinderGeometry(.18,.27,1,6),0x786044,180);
  const crowns=make(new THREE.IcosahedronGeometry(1,1),0xffffff,180);
  const poles=make(new THREE.CylinderGeometry(.09,.13,1,6),0x59666a,16);
  const boxes=make(new THREE.BoxGeometry(1.5,.58,.45),0x27343d,16);
  const lamps=[0x54e0b1,0xffc857,0xff655e].map(color=>make(new THREE.SphereGeometry(.19,8,6),color,16));
  lamps.forEach(mesh=>{mesh.material.emissive.copy(mesh.material.color);mesh.material.emissiveIntensity=.7;});
  let data=null, queue=[], prepared=null, treeCount=0, signalCount=0, last=-Infinity, mode="", loaded=false, visible=true, occupiedKey="";
  function put(mesh,index,x,y,z,sx,sy,sz,angle=0) {
    matrix.position.set(x,y,z); matrix.rotation.set(0,angle,0); matrix.scale.set(sx,sy,sz); matrix.updateMatrix();
    mesh.setMatrixAt(index,matrix.matrix); mesh.count=index+1; mesh.instanceMatrix.needsUpdate=true;
  }
  return {
    setData(value) { data=value; loaded=true; last=-Infinity; },
    update({position,quality,enabled,time,objects=[]}) {
      const nextMode=`${enabled}:${quality}`;
      if(nextMode!==mode){mode=nextMode;last=-Infinity;queue=[];prepared=null;group.children.forEach(m=>m.count=0);}
      visible=Boolean(enabled && quality!=="performance" && data);group.visible=visible;
      if(!visible)return;
      const [treeLimit,signalLimit]=sceneryLimits[quality]??sceneryLimits.balanced;
      const nextOccupied=JSON.stringify(objects.map(o=>[o.id,o.bounds]));
      if(nextOccupied!==occupiedKey){occupiedKey=nextOccupied;last=-Infinity;queue=[];prepared=null;group.children.forEach(m=>m.count=0);}
      if(!queue.length && time-last>1800){
        last=time;treeCount=signalCount=0;prepared=[];
        queue=[...sceneryCandidates(data.signals,position,signalLimit).map(p=>({p,signal:true})),
          ...sceneryCandidates(data.trees,position,treeLimit).map(p=>({p,signal:false}))];
      }
      // A bounded amount of trusted terrain/obstacle work in each frame.
      for(let n=0;n<4&&queue.length;n++){
        const {p:[x,z,angle],signal}=queue.shift();
        if(signal ? signalCount>=signalLimit : treeCount>=treeLimit)continue;
        const candidate={positions:footprint,position:[x,0,z],rotation:[0,0,0],scale:[1,1,1]};
        const placement=validatePlacement(candidate,getEnvironment(candidate));
        if(!placement.valid || objects.some(item=>sharedObjectOverlap(placement.bounds,item)))continue;
        const y=placement.position[1];
        prepared.push({x,y,z,angle,signal});if(signal)signalCount++;else treeCount++;
      }
      if(!queue.length&&prepared){
        treeCount=signalCount=0;group.children.forEach(m=>m.count=0);
        for(const {x,y,z,angle,signal} of prepared){
        if(signal){
          const i=signalCount++;put(poles,i,x,y+2.4,z,1,4.8,1);
          put(boxes,i,x,y+4.65,z,1,1,1,angle);
          lamps.forEach((mesh,k)=>put(mesh,i,x+Math.cos(angle)*(k-1)*.45+Math.sin(angle)*.27,y+4.65,
            z-Math.sin(angle)*(k-1)*.45+Math.cos(angle)*.27,1,1,1,angle));
        }else{
          const i=treeCount++,s=1+Math.abs(Math.sin(x*4+z))*.4;
          put(trunks,i,x,y+1.8*s,z,1,3.6*s,1);
          put(crowns,i,x,y+3.8*s,z,1.65*s,2.1*s,1.65*s);
          tint.setHSL(.25+Math.abs(Math.sin(x))*.09,.38,.31+Math.abs(Math.sin(z))*.12);
          crowns.setColorAt(i,tint);crowns.instanceColor.needsUpdate=true;
        }
        }
        prepared=null;
      }
      lamps.forEach((mesh,k)=>mesh.material.emissiveIntensity=k===(Math.floor(time/7000)%3)?1.5:.05);
    },
    getState:()=>({loaded,visible,trees:trunks.count,signals:poles.count,pending:queue.length}),
    dispose(){group.children.forEach(m=>{m.geometry.dispose();m.material.dispose();m.dispose();});group.removeFromParent();}
  };
}
