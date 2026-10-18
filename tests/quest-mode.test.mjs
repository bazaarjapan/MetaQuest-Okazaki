import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isQuestBrowser, readControlMode, controlPreferenceKey, initialPCMovement } from '../src/creative-controls.js';

const questAgents=[
  'Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 OculusBrowser/39.2.0.0.56 Chrome/136.0.0.0 VR Safari/537.36',
  'Mozilla/5.0 (Linux; Android 12; Quest 3) AppleWebKit/537.36 OculusBrowser/38.0.0.0 Chrome/134.0.0.0 Mobile VR Safari/537.36',
  'Mozilla/5.0 OculusBrowser/30.1.0 Quest 2',
  'Mozilla/5.0 OculusBrowser/30.1.0 Quest Pro',
];
test('Quest browser device hints support desktop and mobile browsing without screen-size inference',()=>{
  for(const ua of questAgents) assert.equal(isQuestBrowser(ua),true,ua);
  for(const ua of [null,undefined,{},'', 'Mozilla/5.0 Windows NT 10.0 Chrome/140.0', 'Mozilla/5.0 Macintosh Safari/605.1', 'Mozilla/5.0 Android Mobile Chrome/140.0', 'Quest 3 VR', 'OculusBrowserFake/1.0']) assert.equal(isQuestBrowser(ua),false,String(ua));
});
test('Quest initial mode overrides stale creative and drone preferences without reading or writing PC storage',()=>{
  for(const ua of questAgents) for(const mobile of [false,true]) for(const stored of [null,'creative','drone','bad']) {
    let reads=0,writes=0;
    const storage={getItem(){reads++;return stored;},setItem(){writes++;}};
    assert.equal(readControlMode(storage,{quest:isQuestBrowser(ua),mobile}),'drone');
    assert.equal(reads,0);assert.equal(writes,0);
  }
  assert.equal(readControlMode({getItem(){throw Error('storage denied');}},{quest:true}),'drone');
});
test('PC deliberate choices remain intact and phone does not acquire a Quest default',()=>{
  for(const value of ['creative','drone']) {
    assert.equal(readControlMode({getItem:key=>key===controlPreferenceKey?value:null},{quest:false,mobile:false}),value);
    assert.equal(readControlMode({getItem:()=>value},{quest:false,mobile:true}),'creative');
  }
  assert.equal(readControlMode(undefined,{quest:false}),'creative');
  assert.equal(initialPCMovement({ready:true,quest:true}),false);
});
test('main wires device defaults and storage isolation without using UA for XR capability or login',async()=>{
  const source=await readFile(new URL('../src/main.js',import.meta.url),'utf8');
  assert.match(source,/const questBrowser = isQuestBrowser\(navigator\.userAgent\)/);
  assert.match(source,/readControlMode\(preferenceStorage, \{ quest: questBrowser, mobile: adaptiveUi\.getState\(\)\.mobile \}\)/);
  assert.match(source,/if \(!mobile && !questBrowser\) preferenceStorage\?\.setItem/);
  assert.match(source,/navigator\.xr\.isSessionSupported\("immersive-vr"\)/);
  assert.match(source,/if \(!activityAllowed/);
  assert.match(source,/quest: questBrowser,/);
});
