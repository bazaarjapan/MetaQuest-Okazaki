// Decorative junction layout derived from connected GSI road centerlines.
// Parallel duplicates are one branch; a bend or tile seam is not a crossing.
export function roadJunctions(roads) {
  const nodes=[],grid=new Map(),key=(x,z)=>`${x},${z}`;
  for(const road of roads) {
    if(!Array.isArray(road.line)||road.line.length<2||!(road.width>=3))continue;
    for(const reverse of [false,true]) {
      const line=reverse?[...road.line].reverse():road.line,p=line[0];
      if(!p.every(Number.isFinite))continue;
      const next=line.find(q=>Math.hypot(q[0]-p[0],q[1]-p[1])>=5);if(!next)continue;
      const gx=Math.floor(p[0]/2),gz=Math.floor(p[1]/2);
      let node;
      for(let x=gx-1;x<=gx+1;x++)for(let z=gz-1;z<=gz+1;z++)for(const n of grid.get(key(x,z))??[])
        if(Math.hypot(n.point[0]-p[0],n.point[1]-p[1])<2)node=n;
      if(!node){node={point:p,branches:[]};nodes.push(node);const k=key(gx,gz);if(!grid.has(k))grid.set(k,[]);grid.get(k).push(node);}
      const length=Math.hypot(next[0]-p[0],next[1]-p[1]),direction=[(next[0]-p[0])/length,(next[1]-p[1])/length];
      const duplicate=node.branches.find(b=>b.direction[0]*direction[0]+b.direction[1]*direction[1]>.94);
      if(duplicate)duplicate.width=Math.max(duplicate.width,road.width);
      else node.branches.push({direction,width:road.width});
    }
  }
  return nodes.filter(n=>n.branches.length>=3&&n.branches.some(b=>b.width>=9)).map(n=>({...n,radius:Math.max(...n.branches.map(b=>b.width))/2+1}));
}

export function crossingLayout(junction) {
  return junction.branches.filter(b=>b.width>=5.5).map(branch=>{
    const [dx,dz]=branch.direction,normal=[dz,-dx],distance=junction.radius+2.8;
    return {...branch,normal,center:[junction.point[0]+dx*distance,junction.point[1]+dz*distance],
      stop:[junction.point[0]+dx*(distance+3.6),junction.point[1]+dz*(distance+3.6)]};
  });
}

export function pathLength(points) {
  return points.slice(1).reduce((n,p,i)=>n+Math.hypot(p[0]-points[i][0],p[1]-points[i][1]),0);
}

// Extend source lines through shared endpoints for long, continuous animation.
// One route stays on one level; roads and rails never join each other.
export function joinedRoutes(lines,{minimum=160,maximum=1600,limit=200}={}) {
  const available=lines.filter(l=>l.length>=2&&l.every(p=>p.length===2&&p.every(Number.isFinite)));
  const endpoint=p=>`${Math.round(p[0]/2)},${Math.round(p[1]/2)}`,ends=new Map();
  available.forEach((line,i)=>{for(const reverse of [false,true]){const p=reverse?line.at(-1):line[0],k=endpoint(p);if(!ends.has(k))ends.set(k,[]);ends.get(k).push({i,reverse});}});
  const used=new Set(),routes=[];
  for(let start=0;start<available.length;start++) {
    if(used.has(start))continue;
    let points=[...available[start]],length=pathLength(points);used.add(start);
    for(let tries=0;tries<50&&length<maximum;tries++) {
      const tail=points.at(-1),previous=points.at(-2),dx=tail[0]-previous[0],dz=tail[1]-previous[1],d=Math.hypot(dx,dz)||1;
      const candidates=(ends.get(endpoint(tail))??[]).filter(e=>!used.has(e.i)).map(e=>{
        const line=e.reverse?[...available[e.i]].reverse():available[e.i],next=line[1],dd=Math.hypot(next[0]-line[0][0],next[1]-line[0][1])||1;
        return {...e,line,score:(dx*(next[0]-line[0][0])+dz*(next[1]-line[0][1]))/(d*dd)};
      }).filter(e=>e.score>-.7).sort((a,b)=>b.score-a.score||a.i-b.i);
      if(!candidates.length)break;
      const next=candidates[0];used.add(next.i);points.push(...next.line.slice(1));length=pathLength(points);
    }
    if(length>=minimum)routes.push(points.map(p=>p.map(v=>+v.toFixed(2))));
  }
  return routes.sort((a,b)=>Math.min(...a.map(p=>Math.hypot(...p)))-Math.min(...b.map(p=>Math.hypot(...p)))).slice(0,limit);
}
