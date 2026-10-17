import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
test('fatal activity lock clears authoritative input flag even if XR end rejects',async()=>{
  const source=await readFile(new URL('../src/main.js',import.meta.url),'utf8');
  const body=source.match(/const activityGate = createActivityGate\(\{ onOpen:[^\n]+onLock: \(\) => \{([\s\S]*?)\n\} \}\);/)[1];
  let ended=0,cleared=0;
  const context=vm.createContext({activityAllowed:true,controls:{enabled:true},setFree(value){assert.equal(value,false);cleared++;},
    document:{querySelectorAll:()=>[],fullscreenElement:null},renderer:{xr:{getSession:()=>({end(){ended++;return Promise.reject(Error('device failure'));}})}}});
  vm.runInContext(body,context);await Promise.resolve();
  assert.equal(context.activityAllowed,false);assert.equal(context.controls.enabled,false);assert.equal(ended,1);assert.equal(cleared,1);
});
