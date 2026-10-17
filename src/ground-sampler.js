import {createSurfaceIndex,sampleSurfaceHeight} from './placement.js';

// Geometry objects change when streaming/DEM completes. A new set/version
// invalidates cached heights, including cached "unknown" values.
export function createTerrainSampler(getMeshes,{getIndex=()=>null}={}) {
  const indexes=new WeakMap(),points=new Map();let signature=[];
  let queries=0,builds=0;
  const sample=(x,z)=>{
    const meshes=getMeshes().filter(Boolean),next=meshes.flatMap(m=>[m,m.geometry,m.geometry.attributes.position.version]);
    if(next.length!==signature.length||next.some((v,i)=>v!==signature[i])){signature=next;points.clear();}
    const key=`${x},${z}`;
    if(points.has(key))return points.get(key);
    let top=-Infinity;
    for(const mesh of meshes) {
      const geometry=mesh.geometry,version=geometry.attributes.position.version;
      let record=indexes.get(geometry);
      if(!record||record.version!==version){
        record={version,index:getIndex(mesh)??createSurfaceIndex(geometry.attributes.position.array,geometry.index?.array??null,{cellSize:32})};
        indexes.set(geometry,record);builds++;
      }
      const y=sampleSurfaceHeight(record.index,x,z);queries++;
      if(y!==null)top=Math.max(top,y);
    }
    const height=Number.isFinite(top)?top:null;points.set(key,height);
    if(points.size>32)points.delete(points.keys().next().value);
    return height;
  };
  sample.getState=()=>({queries,builds,cachedPoints:points.size});return sample;
}
