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

test('unlocking or reconnecting always requires explicit movement restart',async()=>{
  const source=await readFile(new URL('../src/main.js',import.meta.url),'utf8');
  const fn=source.slice(source.indexOf('function syncActivityGate()'),source.indexOf('function adoptSchoolPose()'));
  for(const [mobile,dialog,expected] of [[true,false,false],[false,true,false],[false,false,false]]) {
    let movement;
    const context=vm.createContext({activityAllowed:false,activityGate:{update:()=>true},schoolState:{},state:{ready:true,xr:false},
      ownAvatar:{group:{}},controls:{},creative:{getState:()=>({mode:'creative'})},adaptiveUi:{getState:()=>({mobile})},
      document:{querySelector:()=>dialog?{}:null},setFree:value=>{movement=value;},checkVR(){}});
    vm.runInContext(fn+';syncActivityGate();',context);
    assert.equal(context.activityAllowed,true);assert.equal(movement,expected,`mobile=${mobile} dialog=${dialog}`);
  }
});
