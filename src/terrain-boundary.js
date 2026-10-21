// Original vertices stay untouched. Weld only the topology used to find the rim.
export function terrainBoundaryLoops(positions, indices = null) {
  const vertices=[], remap=[], welded=new Map(), edges=new Map();
  for(let i=0;i<positions.length;i+=3){
    const key=`${positions[i].toFixed(3)},${positions[i+2].toFixed(3)}`;
    if(!welded.has(key)){welded.set(key,vertices.length);vertices.push([positions[i],positions[i+1],positions[i+2]]);}
    remap.push(welded.get(key));
  }
  const count=indices?.length??remap.length;
  for(let i=0;i<count;i+=3)for(let j=0;j<3;j++){
    const a=remap[indices?indices[i+j]:i+j], b=remap[indices?indices[i+(j+1)%3]:i+(j+1)%3];
    if(a===b)continue;
    const key=a<b?`${a},${b}`:`${b},${a}`,edge=edges.get(key)??{a,b,count:0};edge.count++;edges.set(key,edge);
  }
  const neighbors=new Map();
  for(const {a,b,count} of edges.values())if(count===1)for(const [x,y] of [[a,b],[b,a]]){
    if(!neighbors.has(x))neighbors.set(x,[]);neighbors.get(x).push(y);
  }
  if([...neighbors.values()].some(n=>n.length!==2))throw Error('Terrain boundary is not a closed manifold');
  const remaining=new Set(neighbors.keys()), loops=[];
  while(remaining.size){
    const start=remaining.values().next().value;let at=start,previous=-1;const loop=[];
    do{if(!remaining.delete(at))throw Error('Terrain boundary loops intersect');loop.push(vertices[at]);const next=neighbors.get(at).find(v=>v!==previous);previous=at;at=next;}while(at!==start);
    if(loop.length>=3)loops.push(loop);
  }
  return loops;
}

export function polygonAreaXZ(polygon) {
  return Math.abs(polygon.reduce((sum,a,i)=>{const b=polygon[(i+1)%polygon.length];return sum+a[0]*b[2]-b[0]*a[2];},0))/2;
}

// Preserve the original PLATEAU vertices and measured DEM away from its rim.
// In a 40m transition outside the core, join the regional display/collision
// surface to the exact core edge. Shared by browser and authoritative placement.
export function stitchTerrainToCore(positions, coreLoop, width=40) {
  if(!coreLoop?.length)return 0;
  const bounds=[Math.min(...coreLoop.map(p=>p[0]))-width,Math.min(...coreLoop.map(p=>p[2]))-width,Math.max(...coreLoop.map(p=>p[0]))+width,Math.max(...coreLoop.map(p=>p[2]))+width];
  let changed=0;
  for(let n=0;n<positions.length;n+=3){
    const x=positions[n],z=positions[n+2];if(x<bounds[0]||x>bounds[2]||z<bounds[1]||z>bounds[3])continue;
    let distance=width,height=0;
    for(let i=0;i<coreLoop.length;i++){
      const a=coreLoop[i],b=coreLoop[(i+1)%coreLoop.length],dx=b[0]-a[0],dz=b[2]-a[2],length=dx*dx+dz*dz;
      if(!length)continue;
      const t=Math.max(0,Math.min(1,((x-a[0])*dx+(z-a[2])*dz)/length)),d=Math.hypot(x-a[0]-dx*t,z-a[2]-dz*t);
      if(d<distance){distance=d;height=a[1]+(b[1]-a[1])*t;}
    }
    if(distance>=width)continue;
    const t=distance/width,weight=t*t*(3-2*t);
    positions[n+1]=height+(positions[n+1]-height)*weight;changed++;
  }
  return changed;
}

// A vertical seam closes the height difference between the original PLATEAU
// rim and the live DEM. Its horizontal footprint is zero: no new flat ground.
export function coreSeamWall(positions, uv, indices, coreLoop, tolerance=.003) {
  const edges=new Map(), result={positions:[],uv:[]};
  for(let i=0;i<indices.length;i+=3){
    const [x,y,z]=[indices[i]*3,indices[i+1]*3,indices[i+2]*3];
    if(Math.abs((positions[y]-positions[x])*(positions[z+2]-positions[x+2])-(positions[y+2]-positions[x+2])*(positions[z]-positions[x]))<1e-8)continue;
    for(let j=0;j<3;j++){
    const a=indices[i+j],b=indices[i+(j+1)%3],key=a<b?`${a},${b}`:`${b},${a}`;
    const edge=edges.get(key)??{a,b,count:0};edge.count++;edges.set(key,edge);
    }
  }
  // Clipping can leave coincident/T-junction edges with multiple incidents.
  // All edges on the original rim participate in the height envelope.
  const candidates=[...edges.values()].map(e=>({...e,p:[...positions.slice(e.a*3,e.a*3+3)],q:[...positions.slice(e.b*3,e.b*3+3)],pu:[...uv.slice(e.a*2,e.a*2+2)],qu:[...uv.slice(e.b*2,e.b*2+2)]}));
  for(let i=0;i<coreLoop.length;i++){
    const a=coreLoop[i],b=coreLoop[(i+1)%coreLoop.length],dx=b[0]-a[0],dz=b[2]-a[2],length=dx*dx+dz*dz,intervals=[];
    if(!length)continue;
    for(const edge of candidates){
      const {p,q}=edge;
      if(Math.max(p[0],q[0])<Math.min(a[0],b[0])-tolerance||Math.min(p[0],q[0])>Math.max(a[0],b[0])+tolerance||Math.max(p[2],q[2])<Math.min(a[2],b[2])-tolerance||Math.min(p[2],q[2])>Math.max(a[2],b[2])+tolerance)continue;
      const t0=((p[0]-a[0])*dx+(p[2]-a[2])*dz)/length,t1=((q[0]-a[0])*dx+(q[2]-a[2])*dz)/length;
      if(Math.hypot(p[0]-a[0]-dx*t0,p[2]-a[2]-dz*t0)>tolerance||Math.hypot(q[0]-a[0]-dx*t1,q[2]-a[2]-dz*t1)>tolerance||Math.abs(t1-t0)<1e-9)continue;
      const from=Math.max(0,Math.min(t0,t1)),to=Math.min(1,Math.max(t0,t1));if(to-from<1e-9)continue;
      intervals.push({from,to,p,q,t0,t1,pu:edge.pu,qu:edge.qu});
    }
    const stops=[...new Set(intervals.flatMap(e=>[e.from,e.to]))].sort((x,y)=>x-y);
    for(let j=0;j+1<stops.length;j++){
      const from=stops[j],to=stops[j+1],middle=(from+to)/2,cover=intervals.filter(e=>e.from<=middle&&e.to>=middle);
      if(!cover.length||to-from<1e-9)continue;
      const edge=cover[0];
      const at=t=>{const f=(t-edge.t0)/(edge.t1-edge.t0),heights=[a[1]+(b[1]-a[1])*t,...cover.map(e=>e.p[1]+(e.q[1]-e.p[1])*(t-e.t0)/(e.t1-e.t0))];return {bottom:[a[0]+dx*t,Math.min(...heights),a[2]+dz*t],top:[a[0]+dx*t,Math.max(...heights),a[2]+dz*t],uv:edge.pu.map((v,k)=>v+(edge.qu[k]-v)*f)};};
      const p=at(from),q=at(to);if(Math.max(Math.abs(p.top[1]-p.bottom[1]),Math.abs(q.top[1]-q.bottom[1]))<.001)continue;
      result.positions.push(...p.bottom,...q.bottom,...p.top,...q.bottom,...q.top,...p.top);
      result.uv.push(...p.uv,...q.uv,...p.uv,...q.uv,...q.uv,...p.uv);
    }
  }
  return result;
}
