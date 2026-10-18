import {createSurfaceIndex,placementContains,placementFootprint,placementIntersects} from './placement.js';

// Read only trusted, fully loaded meshes. Missing nearby buildings must never
// mean "empty land" just because the renderer has not streamed them yet.
export function createRegionalPlacementEnvironment({getCore,getManifest,getMeshes}) {
  const indexes=new WeakMap();
  const index=mesh=>{
    if(!indexes.has(mesh.geometry))indexes.set(mesh.geometry,createSurfaceIndex(mesh.geometry.attributes.position.array,mesh.geometry.index?.array));
    return indexes.get(mesh.geometry);
  };
  return candidate=>{
    const core=getCore(),manifest=getManifest(),meshes=getMeshes();
    const terrainMeshes=[...core.terrainMeshes,...meshes.filter(m=>m.userData.regionType==='terrain')];
    if(!candidate)return {...core,bounds:manifest?.bounds??core.bounds,terrainMeshes};
    try {
      const box=placementFootprint(candidate);
      if(placementContains(core.bounds,box))return {...core,terrainMeshes};
      if(!manifest || !placementContains(manifest.bounds,box))return {...core,terrainMeshes,error:'Object is outside the editable region'};
      const needed=manifest.tiles.filter(t=>placementIntersects(t.bounds,box));
      const resident=new Map(meshes.map(m=>[m.userData.regionTileId,m]));
      if(needed.some(t=>!resident.has(t.id)))return {...core,terrainMeshes,error:'Nearby placement terrain or buildings are still loading'};
      const ground=[],obstacles=[];
      if(placementIntersects(core.bounds,box)){ground.push(core.terrain);obstacles.push(...core.obstacles);}
      for(const tile of needed)(tile.type==='terrain'?ground:obstacles).push(index(resident.get(tile.id)));
      return {terrain:ground,obstacles,bounds:manifest.bounds,terrainMeshes};
    }catch(error){return {...core,terrainMeshes,error:error.message};}
  };
}
