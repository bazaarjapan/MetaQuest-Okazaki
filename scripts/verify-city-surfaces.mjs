// Real browser + isolated Worker. Scene access and camera movement exist only
// in this local Vite transform, never in the deployed application.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createServer} from 'vite';
import {startSchoolBrowserServer} from './school-browser-server.mjs';
const run=promisify(execFile),session=process.env.BROWSER_SESSION??'city-surfaces-79',cli=resolve('node_modules/agent-browser/bin/agent-browser-win32-x64.exe');
async function browser(...args){try{return(await run(cli,['--session',session,...args],{windowsHide:true,encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024})).stdout.trim();}catch{throw Error(`Browser ${args[0]} failed; private arguments omitted`);}}
async function evaluate(expr){let v=JSON.parse(await browser('eval',`(async()=>JSON.stringify(await (${expr})))()`));return typeof v==='string'?JSON.parse(v):v;}
async function until(expr){const end=Date.now()+90000;while(!await evaluate(`Boolean(${expr})`)){assert.ok(Date.now()<end,'Timed out: '+expr);await delay(200);}}
const checks=[],check=(name,ok)=>{assert.ok(ok,name);checks.push(name);console.log('PASS '+name);};
let server,vite,passed=false;await mkdir('test-results',{recursive:true});
try{
 server=await startSchoolBrowserServer({singleClassroom:true});const f=JSON.parse(await readFile('.cache/school-browser-fixtures.json','utf8'));
 const rewrite=(p,r)=>{if(r.headers.origin==='http://localhost:4173')p.setHeader('Origin',f.origin);};
 vite=await createServer({plugins:[{name:'test-only-scene',transform(code,id){if(id.endsWith('/src/main.js'))return code+'\nwindow.__shaderErrors=[];renderer.debug.onShaderError=(gl,p,v,f)=>window.__shaderErrors.push(gl.getShaderInfoLog(f));window.__sceneFixture={scene,camera,renderer,view:(p,t)=>{setFree(false);setDesktopView(new THREE.Vector3(...p),new THREE.Vector3(...t),new THREE.Vector3(0,1,0),Math.PI*.9,true);}};';}}],server:{host:'127.0.0.1',port:4173,strictPort:true,proxy:{'/api':{target:f.origin,ws:true,changeOrigin:true,configure(p){p.on('proxyReq',rewrite);p.on('proxyReqWs',rewrite);}}}}});await vite.listen();
 await browser('--executable-path','C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','--args','--ignore-gpu-blocklist','open','http://localhost:4173');
 await until('window.__okazaki?.getState().school.configured');
 const result=await evaluate("(async()=>{const {checkCitySurfaceRendering}=await import('/tests/city-surface-render-check.js');return checkCitySurfaceRendering();})()");
 await writeFile('test-results/city-surfaces-rendering.json',JSON.stringify(result,null,2));console.log('Rendering '+JSON.stringify(result));
 check('real WebGL shaders compile',result.shaderErrors.length===0);
 check('offscreen passes produce no WebGL errors',result.glError===0);
 check('offscreen passes restore target viewport scissor and XR state',result.restored);
 check('stationary views reuse existing maps',result.cached);
 check('source vertices stay unchanged',result.unchanged);
 check('measured height survives texture encoding within one centimetre',result.measured[1]>200&&result.measured[0]<20);
 check('courtyard corner keeps its road while the actual building footprint is cleared',result.covered[1]>result.openCorner[1]+20);
 check('elevated passages and fully buried structures do not erase roads',result.underBridge[1]<result.covered[1]-20&&result.buriedBuilding[1]<result.covered[1]-20);
 check('unloading buildings clears old silhouettes',result.afterUnload[1]<result.covered[1]-20);
 check('formerly cut first-floor window is replaced by solid foundation',result.formerLow[2]>result.formerLow[0]+10&&result.correctedLow[0]>result.correctedLow[2]+20);
 check('a complete first-floor window appears above measured ground',result.correctedWindow[2]>result.correctedWindow[0]+10&&result.formerWindow[0]>result.formerWindow[2]+40);
 check('XR caps the local targets at 1024 pixels',result.xr.size===1024&&result.xr.estimatedBytes<=12*1024*1024);
 check('photo mode releases both targets',!result.released.ready&&result.released.estimatedBytes===0);
 await browser('cookies','set',f.teacher.browserCookie.name,f.teacher.browserCookie.value,'--url',f.origin+'/','--path','/','--secure','--httpOnly','--sameSite','Lax');await browser('reload');await until('window.__okazaki?.getState().activityAllowed&&window.__okazaki.getState().citySurface.ready');
 await browser('set','viewport','1440','900');
 for(const [name,p,t] of [['reported-road',[251,22.5,1079],[251,21,1020]],['reported-overview',[251,65,1120],[251,18,1045]],['core-road',[75,20,115],[95,18,45]],['west-road',[-580,23,670],[-540,20,620]]]){
  await evaluate(`window.__sceneFixture.view(${JSON.stringify(p)},${JSON.stringify(t)})`);await delay(2500);
  await until('window.__okazaki.getState().citySurface.ready');
  await until('window.__okazaki.getState().vectorStreets.triangles>0&&window.__okazaki.getState().vectorStreets.pending===0');await delay(800);
  check(name+' uses actual loaded ground and building silhouettes',await evaluate('(()=>{const s=window.__okazaki.getState().citySurface;return s.ready&&s.terrain>0&&s.buildings>0&&s.size===2048;})()'));
  await browser('screenshot',`test-results/city-${name}.png`);
 }
 await browser('click','#simple-menu');await browser('click','#tab-settings');await browser('select','#field-style','photo');await until("window.__okazaki.getState().field.style==='photo'&&!window.__okazaki.getState().citySurface.ready");
 check('photo mode clears the game-only silhouette and height targets',await evaluate('window.__okazaki.getState().citySurface.estimatedBytes===0'));
 await browser('select','#field-style','game');await until("window.__okazaki.getState().field.style==='game'&&window.__okazaki.getState().citySurface.ready");
 check('returning to game rebuilds current geometry',await evaluate('window.__okazaki.getState().citySurface.buildings>0'));
 for(const [quality,size] of [['balanced',1024],['performance',512],['high',2048]]){
  await browser('select','#quality-select',quality);await until(`window.__okazaki.getState().citySurface.size===${size}&&!document.querySelector('#quality-select').disabled`);
  check(quality+' keeps bounded correction targets',await evaluate(`window.__okazaki.getState().citySurface.estimatedBytes===${size*size*12}`));
 }
 await browser('click','#panel-close');
 check('application has no shader compilation errors',await evaluate('window.__shaderErrors.length===0'));
 check('no uncaught browser exceptions',await browser('errors')==='');passed=true;
}finally{
 if(!passed)await browser('screenshot','test-results/city-surfaces-failure.png').catch(()=>{});
 await writeFile('test-results/city-surfaces.json',JSON.stringify({passed,checks,scope:'Native Chrome WebGL + isolated classroom Worker; no production writes or physical Quest'},null,2));
 await browser('close').catch(()=>{});await vite?.close();await server?.dispose();
}
