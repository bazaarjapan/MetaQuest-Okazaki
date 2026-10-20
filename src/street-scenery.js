import * as THREE from 'three';
import {validatePlacement} from './placement.js';
import {sharedObjectOverlap} from './workshop-access.js';

export const sceneryLimits=Object.freeze({performance:[0,0],balanced:[80,8],high:[180,16]});
const extras=Object.freeze({performance:[0,0],balanced:[20,100],high:[40,360]});
const footprint=new Float32Array([-.35,0,-.35,.35,0,-.35,.35,0,.35,-.35,0,-.35,.35,0,.35,-.35,0,.35]);
export function sceneryCandidates(entries,position,limit,radius=420) {
  if(!limit)return [];
  return entries.map(entry=>({entry,distance:Math.hypot(entry[0]-position.x,entry[1]-position.z)}))
    .filter(item=>item.distance<radius).sort((a,b)=>a.distance-b.distance).slice(0,limit*3).map(item=>item.entry);
}
export function trafficSignalState(time,angle=0) {
  const phase=((time/1000)%32+32)%32,axis=Math.abs(Math.sin(angle))>Math.abs(Math.cos(angle))?0:1;
  const local=(phase-axis*16+32)%32;return local<12?'green':local<15?'amber':'red';
}
function grassGeometry() {
  const positions=[];
  for(let i=0;i<32;i++) {
    const angle=i*2.399963,x=Math.cos(angle)*Math.sqrt(i/32)*2.5,z=Math.sin(angle)*Math.sqrt(i/32)*2.5,h=.25+(Math.sin(i*7)+1)*.18,w=.045;
    positions.push(x-Math.cos(angle)*w,0,z-Math.sin(angle)*w,x+Math.cos(angle)*w,0,z+Math.sin(angle)*w,x+.15*Math.sin(angle),h,z+.15*Math.cos(angle));
  }
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.computeVertexNormals();return geometry;
}
export function createStreetScenery({scene,getEnvironment}) {
  const group=new THREE.Group();group.name='decorative-street-scenery';scene.add(group);
  const matrix=new THREE.Object3D(),tint=new THREE.Color();
  const make=(geometry,color,count,basic=false)=>{
    const material=basic?new THREE.MeshBasicMaterial({color,toneMapped:false}):new THREE.MeshStandardMaterial({color,roughness:.9});
    const mesh=new THREE.InstancedMesh(geometry,material,count);mesh.count=0;mesh.frustumCulled=false;group.add(mesh);return mesh;
  };
  const trunks=make(new THREE.CylinderGeometry(.18,.27,1,6),0x786044,180),crowns=make(new THREE.IcosahedronGeometry(1,1),0xffffff,180);
  const poles=make(new THREE.CylinderGeometry(.10,.15,1,6),0x56636a,16),arms=make(new THREE.BoxGeometry(1,1,1),0x56636a,16);
  const boxes=make(new THREE.BoxGeometry(2.0,.72,.55),0x263238,16),backs=make(new THREE.BoxGeometry(2.2,.91,.12),0x253138,16);
  const lamps=[0x3ee0a4,0xffcf55,0xff5650].map(color=>make(new THREE.SphereGeometry(.23,8,6),color,16,true));
  const lightPoles=make(new THREE.CylinderGeometry(.085,.15,1,6),0x647278,40),lightArms=make(new THREE.BoxGeometry(1,1,1),0x647278,40);
  const lightHeads=make(new THREE.BoxGeometry(1.1,.18,.5),0x485860,40),lightLenses=make(new THREE.BoxGeometry(.87,.035,.39),0xffe3a0,40,true);
  const grass=make(grassGeometry(),0xffffff,360);grass.material.side=THREE.DoubleSide;
  const wind={value:0};grass.material.onBeforeCompile=shader=>{shader.uniforms.grassTime=wind;shader.vertexShader='uniform float grassTime;\n'+shader.vertexShader;shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>',`#include <begin_vertex>
    transformed.x+=sin(grassTime*1.7+instanceMatrix[3].x*.13+instanceMatrix[3].z*.09)*position.y*.14;`);};grass.material.customProgramCacheKey=()=> 'okazaki-grass-wind-v1';
  let data=null,queue=[],prepared=null,last=-Infinity,mode='',loaded=false,visible=true,occupiedKey='',signalAngles=[],lastLights=-Infinity,lastPosition=null,groundVersion;
  function put(mesh,index,x,y,z,sx,sy,sz,angle=0) {
    matrix.position.set(x,y,z);matrix.rotation.set(0,angle,0);matrix.scale.set(sx,sy,sz);matrix.updateMatrix();mesh.setMatrixAt(index,matrix.matrix);mesh.count=index+1;mesh.instanceMatrix.needsUpdate=true;
  }
  function reset(){queue=[];prepared=null;group.children.forEach(m=>m.count=0);signalAngles=[];lastPosition=null;}
  return {
    setData(value){data=value;loaded=true;last=-Infinity;reset();},
    update({position,quality,enabled,time,objects=[],timeOfDay='day',terrainVersion=null,paused=false}) {
      const nextMode=`${enabled}:${quality}`;if(nextMode!==mode){mode=nextMode;last=-Infinity;reset();}
      visible=Boolean(enabled&&quality!=='performance'&&data);group.visible=visible;if(!visible)return;
      wind.value=time/1000;
      const [treeLimit,signalLimit]=sceneryLimits[quality]??sceneryLimits.balanced,[lightLimit,grassLimit]=extras[quality]??extras.balanced;
      const limits={tree:treeLimit,signal:signalLimit,light:lightLimit,grass:grassLimit};
      const nextOccupied=JSON.stringify(objects.map(o=>[o.id,o.bounds]));if(nextOccupied!==occupiedKey){occupiedKey=nextOccupied;last=-Infinity;reset();}
      if(terrainVersion!==groundVersion){groundVersion=terrainVersion;last=-Infinity;reset();}
      // A menu or editor needs no new scenery queries. At a stationary viewpoint
      // reuse the accepted batch until geometry, objects or the position changes.
      if(paused)return;
      if(!queue.length&&time-last>1800&&(!lastPosition||Math.hypot(position.x-lastPosition.x,position.z-lastPosition.z)>12)) {
        lastPosition={x:position.x,z:position.z};
        last=time;prepared={items:[],counts:{tree:0,signal:0,light:0,grass:0}};
        queue=[['signal',data.signals],['light',data.lights],['tree',data.trees],['grass',data.grass]].flatMap(([kind,entries])=>sceneryCandidates(entries??[],position,limits[kind],kind==='grass'?220:420).map(p=>({p,kind})));
      }
      let checks=0;
      while(queue.length&&checks<6) {
        const {p:[x,z,angle],kind}=queue.shift();if(prepared.counts[kind]>=limits[kind])continue;checks++;
        const scale=kind==='grass'?7:1,candidate={positions:footprint,position:[x,0,z],rotation:[0,0,0],scale:[scale,1,scale]};
        const placement=validatePlacement(candidate,getEnvironment(candidate));
        if(!placement.valid||objects.some(item=>sharedObjectOverlap({...placement.bounds,max:[placement.bounds.max[0],placement.bounds.min[1]+(kind==='grass'?.8:7),placement.bounds.max[2]]},item)))continue;
        prepared.items.push({x,y:placement.position[1],z,angle,kind});prepared.counts[kind]++;
      }
      if(!queue.length&&prepared) {
        group.children.forEach(m=>m.count=0);const counts={tree:0,signal:0,light:0,grass:0};signalAngles=[];
        for(const {x,y,z,angle,kind} of prepared.items) {
          const i=counts[kind]++,cx=Math.cos(angle),sz=Math.sin(angle);
          if(kind==='signal') {
            put(poles,i,x,y+3.1,z,1,6.2,1);put(arms,i,x-cx*1.6,y+6.05,z+sz*1.6,3.2,.14,.14,angle);
            const hx=x-cx*3.2,hz=z+sz*3.2;put(boxes,i,hx,y+5.98,hz,1,1,1,angle);
            put(backs,i,hx-sz*.29,y+5.98,hz-cx*.29,1,1,1,angle);
            lamps.forEach((mesh,k)=>put(mesh,i,hx+cx*(k-1)*.61+sz*.33,y+5.98,hz-sz*(k-1)*.61+cx*.33,1,1,.5,angle));signalAngles.push(angle);
          }else if(kind==='light') {
            put(lightPoles,i,x,y+3.5,z,1,7,1);put(lightArms,i,x-cx*.9,y+6.9,z+sz*.9,1.9,.12,.12,angle);
            put(lightHeads,i,x-cx*1.8,y+6.84,z+sz*1.8,1,1,1,angle);put(lightLenses,i,x-cx*1.8,y+6.73,z+sz*1.8,1,1,1,angle);
          }else if(kind==='grass') {
            put(grass,i,x,y+.015,z,1,1,1,angle);tint.setHSL(.22+Math.abs(Math.sin(x))*.08,.35,.27+Math.abs(Math.sin(z))*.09);grass.setColorAt(i,tint);
          }else {
            const s=1+Math.abs(Math.sin(x*4+z))*.4;put(trunks,i,x,y+1.8*s,z,1,3.6*s,1);put(crowns,i,x,y+3.8*s,z,1.65*s,2.1*s,1.65*s);
            tint.setHSL(.25+Math.abs(Math.sin(x))*.09,.38,.31+Math.abs(Math.sin(z))*.12);crowns.setColorAt(i,tint);
          }
        }
        if(grass.instanceColor)grass.instanceColor.needsUpdate=true;if(crowns.instanceColor)crowns.instanceColor.needsUpdate=true;prepared=null;lastLights=-Infinity;
      }
      if(time-lastLights>200) {
        lastLights=time;
        lamps.forEach((mesh,k)=>{for(let i=0;i<signalAngles.length;i++){const on=['green','amber','red'][k]===trafficSignalState(time,signalAngles[i]);tint.setRGB(on?1:.12,on?1:.12,on?1:.12);mesh.setColorAt(i,tint);}if(mesh.instanceColor)mesh.instanceColor.needsUpdate=true;});
        lightLenses.material.color.set(timeOfDay==='evening'?0xffdf8c:0xc7d5cc);
      }
    },
    getState:()=>({loaded,visible,trees:trunks.count,signals:poles.count,lights:lightPoles.count,grass:grass.count,pending:queue.length}),
    dispose(){group.children.forEach(m=>{m.geometry.dispose();m.material.dispose();m.dispose();});group.removeFromParent();}
  };
}
