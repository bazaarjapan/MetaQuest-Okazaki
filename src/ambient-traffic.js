import * as THREE from 'three';
import {validatePlacement} from './placement.js';
import {sharedObjectOverlap} from './workshop-access.js';

export const trafficLimits=Object.freeze({performance:[0,0,0],balanced:[10,1,1],high:[20,2,2]});
export function makeRoute(points) {
  if(!Array.isArray(points)||points.length<2||!points.every(p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite)))return null;
  const distances=[0];for(let i=1;i<points.length;i++)distances.push(distances.at(-1)+Math.hypot(points[i][0]-points[i-1][0],points[i][1]-points[i-1][1]));
  return distances.at(-1)>1?{points,distances,length:distances.at(-1)}:null;
}
export function sampleRoute(route,distance,offset=0) {
  const d=Math.max(0,Math.min(route.length,distance));let i=1;while(i<route.distances.length-1&&route.distances[i]<d)i++;
  const a=route.points[i-1],b=route.points[i],length=route.distances[i]-route.distances[i-1]||1,t=(d-route.distances[i-1])/length,dx=(b[0]-a[0])/length,dz=(b[1]-a[1])/length;
  return {x:a[0]+(b[0]-a[0])*t+dz*offset,z:a[1]+(b[1]-a[1])*t-dx*offset,angle:Math.atan2(dx,dz)};
}
export function routeTravel(route,time,speed,margin=0) {
  const span=Math.max(1,route.length-margin*2),cycle=((time*speed)%(span*2)+span*2)%(span*2),reverse=cycle>span;
  return {distance:margin+(reverse?span*2-cycle:cycle),reverse};
}
export function nearestRoutePoint(route,position) {
  let best={distance:Infinity,along:0};
  for(let i=1;i<route.points.length;i++){
    const a=route.points[i-1],b=route.points[i],dx=b[0]-a[0],dz=b[1]-a[1],length=route.distances[i]-route.distances[i-1];if(!length)continue;
    const t=Math.max(0,Math.min(1,((position.x-a[0])*dx+(position.z-a[1])*dz)/(length*length))),distance=Math.hypot(a[0]+dx*t-position.x,a[1]+dz*t-position.z);
    if(distance<best.distance)best={distance,along:route.distances[i-1]+t*length};
  }
  return best;
}
const rectangle=(width,length)=>new Float32Array([-width/2,0,-length/2,width/2,0,-length/2,width/2,0,length/2,-width/2,0,-length/2,width/2,0,length/2,-width/2,0,length/2]);
export function createAmbientTraffic({scene,getEnvironment}) {
  const group=new THREE.Group();group.name='decorative-traffic';scene.add(group);const transform=new THREE.Object3D(),color=new THREE.Color();
  const meshes=[],make=(geometry,paint,count)=>{const material=new THREE.MeshStandardMaterial({color:paint,roughness:.65});const mesh=new THREE.InstancedMesh(geometry,material,count);mesh.count=0;mesh.frustumCulled=false;meshes.push(mesh);group.add(mesh);return mesh;};
  const box=()=>new THREE.BoxGeometry(1,1,1);
  const carBody=make(box(),0xffffff,20),carCab=make(box(),0x335767,20),carTires=make(new THREE.SphereGeometry(1,6,4),0x273135,80),carLights=make(box(),0xfff3c5,40);
  const trainBody=make(box(),0xdde4de,6),trainRoof=make(box(),0x647d80,6),trainBand=make(box(),0x297f7c,12),trainWindows=make(box(),0x284956,120),trainWheels=make(box(),0x344245,12);
  const fuselage=make(new THREE.SphereGeometry(1,12,6),0xf2eee0,2),wings=make(box(),0xece6d4,2),tail=make(box(),0xd37e53,2),fin=make(box(),0xf2eee0,2);
  let data=null,roads=[],rails=[],cars=[],trains=[],lastPlan=-Infinity,clock=0,lastTime=null,checks=0,enabled=false,quality='',shownCars=0,shownTrains=0,shownPlanes=0,environmentVersion=null,objectsReference=null,occupiedKey='';
  function put(mesh,index,p,y,sx,sy,sz,lx=0,ly=0,lz=0,roll=0) {
    const c=Math.cos(p.angle),s=Math.sin(p.angle);transform.position.set(p.x+c*lx+s*lz,y+ly,p.z-s*lx+c*lz);transform.rotation.set(0,p.angle,roll);transform.scale.set(sx,sy,sz);transform.updateMatrix();mesh.setMatrixAt(index,transform.matrix);mesh.count=Math.max(mesh.count,index+1);mesh.instanceMatrix.needsUpdate=true;
  }
  function nearby(routes,position,limit){return routes.map((route,i)=>({route,i,...nearestRoutePoint(route,position)})).filter(r=>r.distance<700).sort((a,b)=>a.distance-b.distance).slice(0,limit);}
  function validateCell(vehicle,cell,objects,time) {
    const train=vehicle.carriage!==undefined,start=cell*6,end=Math.min(vehicle.route.length,start+6),samples=[start,end];
    for(const d of vehicle.route.distances)if(d>start&&d<end)samples.push(Math.max(start,d-.0001),Math.min(end,d+.0001));
    let minX=Infinity,minZ=Infinity,maxX=-Infinity,maxZ=-Infinity;
    for(const distance of samples){const p=sampleRoute(vehicle.route,distance,vehicle.offset),c=Math.cos(p.angle),s=Math.sin(p.angle);
      for(const x of [train?-1.4:-.825,train?1.4:.825])for(const z of [train?-6: -1.8,train?6:1.8]){
        const wx=p.x+c*x+s*z,wz=p.z-s*x+c*z;minX=Math.min(minX,wx);maxX=Math.max(maxX,wx);minZ=Math.min(minZ,wz);maxZ=Math.max(maxZ,wz);
      }
    }
    const candidate={positions:rectangle(maxX-minX+.24,maxZ-minZ+.24),position:[(minX+maxX)/2,0,(minZ+maxZ)/2],rotation:[0,0,0],scale:[1,1,1]};
    const placement=validatePlacement(candidate,getEnvironment(candidate));
    const valid=placement.valid&&!objects.some(o=>sharedObjectOverlap({...placement.bounds,max:[placement.bounds.max[0],placement.bounds.min[1]+(train?3.7:1.7),placement.bounds.max[2]]},o));
    return {valid,y:placement.position?.[1],retryAt:time+1500};
  }
  return {
    setData(value){data=value;roads=(value?.roads??[]).map(makeRoute).filter(Boolean);rails=(value?.rails??[]).map(makeRoute).filter(Boolean);cars=[];trains=[];lastPlan=-Infinity;environmentVersion=null;},
    update({position,quality:nextQuality,active,time,objects=[],terrainVersion=null}) {
      enabled=Boolean(active&&data&&nextQuality!=='performance');group.visible=enabled;
      if(lastTime!==null&&enabled)clock+=Math.max(0,Math.min(.1,(time-lastTime)/1000));lastTime=time;
      if(!enabled){shownCars=shownTrains=shownPlanes=0;return;}
      const [carLimit,trainLimit,planeLimit]=trafficLimits[nextQuality]??trafficLimits.balanced;
      if(time-lastPlan>4000||quality!==nextQuality){
        lastPlan=time;quality=nextQuality;
        const previousCars=new Map(cars.map(c=>[c.id,c])),previousTrains=new Map(trains.map(c=>[`${c.id}:${c.carriage}`,c]));
        cars=nearby(roads,position,carLimit).map(({route,i,along})=>previousCars.get(i)??{route,id:i,seed:(Math.max(5,Math.min(route.length-5,along))-5)/7.5-clock,cache:new Map()});
        trains=nearby(rails,position,trainLimit).flatMap(({route,i,along})=>Array.from({length:3},(_,carriage)=>previousTrains.get(`${i}:${carriage}`)??{route,id:i,seed:(Math.max(30,Math.min(route.length-30,along))-30)/16-clock,carriage,cache:new Map()}));
      }
      const vehicles=[...cars,...trains];
      let changed=terrainVersion!==environmentVersion;environmentVersion=terrainVersion;
      if(objectsReference!==objects){objectsReference=objects;const key=JSON.stringify(objects.map(o=>[o.id,o.bounds]));changed=changed||key!==occupiedKey;occupiedKey=key;}
      if(changed)vehicles.forEach(v=>v.cache.clear());
      for(const vehicle of vehicles){
        const train=vehicle.carriage!==undefined,travel=routeTravel(vehicle.route,clock+vehicle.seed,train?16:7.5,train?30:5);
        const distance=travel.distance+(train?(vehicle.carriage-1)*14:0),offset=train?0:(travel.reverse?-1.6:1.6);
        vehicle.distance=Math.max(0,Math.min(vehicle.route.length,distance));vehicle.offset=offset;vehicle.reverse=travel.reverse;vehicle.cell=Math.floor(vehicle.distance/6);
        vehicle.p=sampleRoute(vehicle.route,vehicle.distance,offset);if(travel.reverse)vehicle.p.angle+=Math.PI;
      }
      // Validate the whole swept body in each six-metre route cell, including
      // bends. Interpolate only inside accepted cells; never reuse an old point's
      // validity at a new position. Mesh replacement or an STL edit invalidates
      // all cells before any vehicle is drawn. Prepare the next cell in advance.
      checks=0;
      const key=(v,cell)=>`${cell}:${v.offset}`,needs=(v,cell)=>{const value=v.cache.get(key(v,cell));return !value||!value.valid&&time>=value.retryAt;};
      const jobs=vehicles.filter(v=>needs(v,v.cell)).map(v=>({vehicle:v,cell:v.cell}));
      for(const vehicle of vehicles){const cell=Math.max(0,Math.min(Math.floor(vehicle.route.length/6),vehicle.cell+(vehicle.reverse?-1:1)));if(cell!==vehicle.cell&&needs(vehicle,cell))jobs.push({vehicle,cell});}
      for(const {vehicle,cell} of jobs.slice(0,4)){vehicle.cache.set(key(vehicle,cell),validateCell(vehicle,cell,objects,time));while(vehicle.cache.size>6)vehicle.cache.delete(vehicle.cache.keys().next().value);checks++;}
      for(const vehicle of vehicles){const cell=vehicle.cache.get(key(vehicle,vehicle.cell));vehicle.valid=Boolean(cell?.valid);vehicle.y=cell?.y;}
      meshes.forEach(m=>m.count=0);shownCars=shownTrains=shownPlanes=0;
      for(const car of cars)if(car.valid&&Math.hypot(car.p.x-position.x,car.p.z-position.z)<700){
        const i=shownCars++,p=car.p,y=car.y;put(carBody,i,p,y,1.65,.65,3.6,0,.65);put(carCab,i,p,y,1.4,.6,1.85,0,1.2,-.25);
        color.set(['#e2dbc4','#6b9b98','#bd795a','#bbc8d0','#839096'][car.id%5]);carBody.setColorAt(i,color);
        for(let k=0;k<4;k++)put(carTires,i*4+k,p,y,.14,.29,.29,k%2?.83:-.83,.3,k<2?-1.12:1.12);
        for(let k=0;k<2;k++)put(carLights,i*2+k,p,y,.28,.15,.04,k?.56:-.56,.71,1.82);
      }
      if(carBody.instanceColor)carBody.instanceColor.needsUpdate=true;
      for(const train of trains)if(train.valid&&Math.hypot(train.p.x-position.x,train.p.z-position.z)<900){
        const i=shownTrains++,p=train.p,y=train.y;put(trainBody,i,p,y,2.8,3.1,12,0,1.9);put(trainRoof,i,p,y,2.9,.25,12.1,0,3.57);
        for(let side=0;side<2;side++){const x=side?1.415:-1.415;put(trainBand,i*2+side,p,y,.04,.45,11.8,x,1.35);put(trainWheels,i*2+side,p,y,2.4,.55,1.1,0,.35,side?3.7:-3.7);
          for(let w=0;w<10;w++)put(trainWindows,i*20+side*10+w,p,y,.04,.9,.72,x,2.55,(w-4.5)*1.06);}
      }
      const aircraft=[{x:95,z:100,y:250,radius:580,period:140,span:13},...(data.airfield?[{x:data.airfield.x,z:data.airfield.z,y:data.airfield.elevation+150,radius:440,period:110,span:17}]:[])];
      for(let n=0;n<Math.min(planeLimit,aircraft.length);n++){
        const a=aircraft[n],t=clock/a.period*Math.PI*2+n*1.4,p={x:a.x+Math.cos(t)*a.radius,z:a.z+Math.sin(t)*a.radius,angle:-t};
        if(Math.hypot(p.x-position.x,p.z-position.z)>2000)continue;
        const i=shownPlanes++,y=a.y+Math.sin(t*2)*12;put(fuselage,i,p,y,.6,.65,4.8);put(wings,i,p,y,a.span,.12,1.1,0,.1,-.4);put(tail,i,p,y,4.3,.1,.7,0,.2,-3.5);put(fin,i,p,y,.12,1.3,1.0,0,.7,-3.6);
      }
    },
    getState:()=>({enabled,cars:shownCars,trainCarriages:shownTrains,planes:shownPlanes,terrainChecks:checks,clock,roadRoutes:roads.length,railRoutes:rails.length}),
    dispose(){for(const mesh of meshes){mesh.geometry.dispose();mesh.material.dispose();mesh.dispose();}group.removeFromParent();}
  };
}
