import test from 'node:test';
import assert from 'node:assert/strict';
import {findWorkLanding} from '../src/workshop-landing.js';
import {createSurfaceIndex} from '../src/placement.js';
const box={min:{x:-2,y:0,z:-2},max:{x:2,y:5,z:2}};
const viewer={x:20,z:0};
const ground=createSurfaceIndex(new Float32Array([-50,7,-50,50,7,-50,50,7,50,-50,7,-50,50,7,50,-50,7,50]));
const env=()=>({terrain:ground,obstacles:[],bounds:[-50,-50,50,50]});
test('landing uses real ground beside object, nearest side first',()=>{
  assert.deepEqual(findWorkLanding(box,viewer,env,[box]),[4,7,0]);
});
test('landing avoids occupied works and building surfaces',()=>{
  const occupied={min:{x:3,z:-2},max:{x:5,z:2}};
  const landing=findWorkLanding(box,viewer,env,[box,occupied]);
  assert.notDeepEqual(landing,[4,7,0]);
  assert.equal(findWorkLanding(box,viewer,()=>({...env(),obstacles:[ground]})),null);
});
test('missing terrain, incomplete streaming and holes never create a fabricated floor',()=>{
  assert.equal(findWorkLanding(box,viewer,()=>({...env(),error:'Nearby placement terrain or buildings are still loading'})),null);
  assert.equal(findWorkLanding(box,viewer,()=>({bounds:[-50,-50,50,50]})),null);
});
