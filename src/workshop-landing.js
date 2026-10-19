import { validatePlacement } from './placement.js';

// A one-metre standing footprint. Full coverage and projected building checks
// reuse the same trusted terrain validation as STL placement (no guessed floor).
const feet = new Float32Array([-.5,0,-.5,.5,0,-.5,.5,0,.5, -.5,0,-.5,.5,0,.5,-.5,0,.5]);
export function findWorkLanding(box, viewer, getEnvironment, occupied=[]) {
  const cx=(box.min.x+box.max.x)/2,cz=(box.min.z+box.max.z)/2;
  for(const gap of [2,4,8,12]) {
    const candidates=[[box.min.x-gap,cz],[box.max.x+gap,cz],[cx,box.min.z-gap],[cx,box.max.z+gap],
      [box.min.x-gap,box.min.z-gap],[box.max.x+gap,box.min.z-gap],[box.min.x-gap,box.max.z+gap],[box.max.x+gap,box.max.z+gap]];
    candidates.sort((a,b)=>Math.hypot(a[0]-viewer.x,a[1]-viewer.z)-Math.hypot(b[0]-viewer.x,b[1]-viewer.z));
    for(const [x,z] of candidates) {
      if(occupied.some(b=>x+.5>=b.min.x && x-.5<=b.max.x && z+.5>=b.min.z && z-.5<=b.max.z))continue;
      const candidate={positions:feet,position:[x,0,z],rotation:[0,0,0],scale:[1,1,1]};
      const result=validatePlacement(candidate,getEnvironment(candidate));
      if(result.valid)return result.position;
    }
  }
  return null;
}
