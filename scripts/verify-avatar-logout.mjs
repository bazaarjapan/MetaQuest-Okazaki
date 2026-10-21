// Isolated real Worker classroom + native Chrome. Test-only scene access is
// injected by this Vite server; it is never part of the production build.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createServer} from 'vite';
import {startSchoolBrowserServer} from './school-browser-server.mjs';
const run=promisify(execFile),session=process.env.BROWSER_SESSION??'avatar-logout-77',cli=resolve('node_modules/agent-browser/bin/agent-browser-win32-x64.exe');
async function browser(...args){try{return(await run(cli,['--session',session,...args],{windowsHide:true,encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024})).stdout.trim();}catch{throw Error(`Browser ${args[0]} failed; private arguments omitted`);}}
async function evaluate(expr){let v=JSON.parse(await browser('eval',`(async()=>JSON.stringify(await (${expr})))()`));return typeof v==='string'?JSON.parse(v):v;}
async function until(expr){const end=Date.now()+90000;while(!await evaluate(`Boolean(${expr})`)){assert.ok(Date.now()<end,'Timed out: '+expr);await delay(200);}}
const checks=[],check=(name,ok)=>{assert.ok(ok,name);checks.push(name);console.log('PASS '+name);};
let server,vite,passed=false,studentCredentials;await mkdir('test-results',{recursive:true});
try{
 server=await startSchoolBrowserServer({singleClassroom:true});
 const fixtures=JSON.parse(await readFile('.cache/school-browser-fixtures.json','utf8'));
 const rewrite=(p,r)=>{if(r.headers.origin==='http://localhost:4173')p.setHeader('Origin',fixtures.origin);};
 vite=await createServer({plugins:[{name:'test-only-scene',transform(code,id){if(id.endsWith('/src/main.js'))return code+'\nwindow.__sceneFixture={scene,camera,renderer,view:(p,t)=>{setFree(false);setDesktopView(new THREE.Vector3(...p),new THREE.Vector3(...t),new THREE.Vector3(0,1,0),Math.PI*.9,true);}};';}}],server:{host:'127.0.0.1',port:4173,strictPort:true,proxy:{'/api':{target:fixtures.origin,ws:true,changeOrigin:true,configure(p){p.on('proxyReq',rewrite);p.on('proxyReqWs',rewrite);}}}}});await vite.listen();
 await browser('--executable-path','C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','--args','--ignore-gpu-blocklist','open','http://localhost:4173');
 await until('window.__okazaki?.getState().school.configured');
 check('logout hidden before login',await evaluate("document.querySelector('#school-quick-logout').hidden"));
 const rendering=await evaluate("(async()=>{const {checkAvatarRendering}=await import('/tests/avatar-render-check.js');return checkAvatarRendering();})()");
 await writeFile('test-results/avatar-rendering.json',JSON.stringify(rendering,null,2));
 check('real road layers reproduce former nickname overpaint',rendering.streetTriangles>0&&rendering.former<10);
 check('nickname remains readable over roads with depth testing',rendering.visible>rendering.former+20&&rendering.depthTest);
 check('opaque foreground buildings still occlude names',rendering.hidden===0);
 for(const [role,person] of [['teacher',fixtures.teacher],['student',null]]){
  if(person){
   await browser('cookies','set',person.browserCookie.name,person.browserCookie.value,'--url',fixtures.origin+'/','--path','/','--secure','--httpOnly','--sameSite','Lax');await browser('reload');
  }else{
   await browser('click','#login-gate [data-login-role=student]');await browser('fill','#student-login-id',studentCredentials[0]);await browser('fill','#student-password',studentCredentials[1]);await browser('click','#student-login-panel button');await until("document.querySelector('#school-avatar-name')");await browser('fill','#school-avatar-name','名札確認生徒');await browser('click','#school-avatar-save');await browser('click','#school-close');
  }
  await until('window.__okazaki?.getState().activityAllowed');
  check(role+' sees logout immediately',await evaluate("!document.querySelector('#school-quick-logout').hidden"));
  for(const [w,h] of [[1280,800],[390,844],[844,390]]){
   await browser('set','viewport',String(w),String(h));
   check(role+` ${w}x${h} header logout fits`,await evaluate("(()=>{const r=document.querySelector('#school-quick-logout').getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&document.documentElement.scrollWidth<=innerWidth;})()"));
   await browser('click','#school-button');
   await evaluate("document.querySelector('.school-body').scrollTop=document.querySelector('.school-body').scrollHeight");
   check(role+` ${w}x${h} dialog logout needs no scrolling`,await evaluate("(()=>{const b=document.querySelector('#school-logout'),r=b.getBoundingClientRect();return !b.hidden&&r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth;})()"));
   await browser('screenshot',`test-results/logout-${role}-${w}x${h}.png`);await browser('click','#school-close');
  }
  await browser('set','viewport','1280','800');
  if(role==='teacher'){
   await until('window.__okazaki.getState().region.seamTriangles>0');
   await evaluate('window.__sceneFixture.view([-234,19,365],[-250,17,400])');await delay(3500);
   await browser('screenshot','test-results/core-south-seam.png');
   for(const [name,p,t] of [['south-road',[-234,17,365],[-195,16.5,375]],['south-west',[-227,17,368],[-265,16.5,368]]]){
    await evaluate(`window.__sceneFixture.view(${JSON.stringify(p)},${JSON.stringify(t)})`);await delay(700);await browser('screenshot',`test-results/core-seam-${name}.png`);
   }
   const diagnosis=await evaluate("(async()=>{const T=await import('/node_modules/three/build/three.module.js'),f=window.__sceneFixture;return [...f.scene.children].map(o=>({name:o.name,type:o.type}));})()");
   await writeFile('test-results/seam-diagnosis.json',JSON.stringify(diagnosis,null,2));
   await browser('click','#school-button');await browser('click','#student-issue');await until("!document.querySelector('#student-issued-credentials').hidden");studentCredentials=await evaluate("document.querySelector('#student-issued-credentials').value.split('\\n')[1].split('\\t')");await browser('click','#school-close');
  }
  await browser('click',role==='teacher'?'#school-quick-logout':'#school-button');
  if(role==='student')await browser('click','#school-logout');
  await until('!window.__okazaki.getState().school.user');
  check(role+' logout stops activities and hides both buttons',await evaluate("!window.__okazaki.getState().activityAllowed&&!window.__okazaki.getState().free&&document.querySelector('#school-logout').hidden&&document.querySelector('#school-quick-logout').hidden&&!document.querySelector('#login-gate').hidden"));
  const me=await evaluate("(async()=>{const r=await fetch('/api/session');return{status:r.status,body:await r.json()};})()");
  check(role+' session actually signed out on server',me.status===200&&me.body.user===null);
  await browser('click','#school-close');
 }
 check('no uncaught browser exceptions',await browser('errors')==='');passed=true;
}finally{
 if(!passed)await browser('screenshot','test-results/avatar-logout-failure.png').catch(()=>{});
 await writeFile('test-results/avatar-logout.json',JSON.stringify({passed,checks,scope:'Native Chrome WebGL + isolated Worker; no production writes or Google OAuth or physical Quest'},null,2));
 await browser('close').catch(()=>{});await vite?.close();await server?.dispose();
}
