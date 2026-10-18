// Read-only live GSI gate. No classroom credentials, mutation or deployment.
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createRegionPlacementLoader} from '../worker/regional-placement.mjs';
import {validatePlacement} from '../src/placement.js';
const binding={async fetch(request){const u=new URL(request.url);try{return new Response(await readFile(new URL(`../public${u.pathname}`,import.meta.url)));}catch{return new Response('',{status:404});}}};
const load=createRegionPlacementLoader(binding),results=[];
const positions=new Float32Array([0,0,0,1,0,0,0,0,1,0,0,0,0,2,0,1,0,0,0,0,0,0,0,1,0,2,0,1,0,0,0,2,0,0,0,1]);
for(const [cx,cz] of [[1200,0],[4000,-4000],[10000,0]]){
  let result=null,candidate=null;
  for(const [dx,dz] of [[0,0],[20,0],[-20,0],[0,20],[0,-20],[50,50],[-50,-50],[100,100]]){
    candidate={positions,position:[cx+dx,9999,cz+dz],rotation:[0,0,0],scale:[1,1,1]};
    result=validatePlacement(candidate,await load(candidate));if(result.valid)break;
  }
  if(!result?.valid)throw Error(JSON.stringify({cx,cz,result}));
  results.push({requested:candidate.position,snapped:result.position,valid:result.valid,source:'live GSI DEM + hash-verified regional PLATEAU'});
}
await mkdir(new URL('../test-results/',import.meta.url),{recursive:true});
await writeFile(new URL('../test-results/regional-placement.json',import.meta.url),JSON.stringify({passed:true,results},null,2));
console.log(JSON.stringify({passed:true,results},null,2));
