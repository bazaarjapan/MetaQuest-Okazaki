// Native-browser checks against an isolated Worker/D1/R2 fixture.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {startSchoolBrowserServer} from './school-browser-server.mjs';
const run=promisify(execFile),cli=resolve(`node_modules/agent-browser/bin/agent-browser-win32-${process.arch}.exe`),session='login-terrain-'+Date.now();
const checks=[],layouts=[];let server,passed=false;
async function browser(...args){try{return(await run(cli,['--session',session,...args],{windowsHide:true,encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024})).stdout.trim();}catch(error){throw Error(`Browser ${args[0]} failed (${error.code??'unknown'}); private arguments omitted`);}}
async function evaluate(source){let value=JSON.parse(await browser('eval',`JSON.stringify(${source})`));return typeof value==='string'?JSON.parse(value):value;}
async function until(source,timeout=90000){const deadline=Date.now()+timeout;while(!await evaluate(`Boolean(${source})`)){if(Date.now()>deadline)throw Error('Timed out: '+source);await delay(200);}}
const check=(name,ok)=>{assert.ok(ok,name);checks.push(name);console.log('PASS '+name);};
await mkdir('test-results',{recursive:true});
try{
 server=await startSchoolBrowserServer({singleClassroom:true});
 const fixtures=JSON.parse(await readFile('.cache/school-browser-fixtures.json','utf8'));
 await browser('--executable-path','C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','--args','--ignore-gpu-blocklist','open',fixtures.origin);
 await until("document.querySelector('#student-login-id') && !document.querySelector('#login-gate').hidden");
 await browser('set','viewport','1280','800');
 check('initial gate offers separate teacher and student entry',await evaluate("document.querySelectorAll('#login-gate [data-login-role]').length===2"));
 await browser('screenshot','test-results/login-role-gate.png');
 for(const role of ['student','teacher']){
  await browser('click',`#login-gate [data-login-role=${role}]`);
  check(role+' entry opens only its own form',await evaluate(`document.querySelector('#${role}-login-panel').hidden===false && document.querySelector('#${role==='student'?'teacher':'student'}-login-panel').hidden===true`));
  for(const [w,h] of [[1440,900],[1280,800],[797,881],[390,844],[844,390]]){
   await browser('set','viewport',String(w),String(h));
   const layout=await evaluate(`(()=>{const d=document.querySelector('#school-dialog'),b=d.querySelector('.school-body'),r=d.getBoundingClientRect(),c=d.querySelector('#school-close').getBoundingClientRect(),f=d.querySelector('.school-footer').getBoundingClientRect();return{fits:r.left>=0&&r.top>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1,closeVisible:c.top>=0&&c.bottom<=innerHeight,footerVisible:f.top>=0&&f.bottom<=innerHeight,noHorizontal:b.scrollWidth<=b.clientWidth+1,scroll:b.scrollHeight>b.clientHeight+1,overflow:getComputedStyle(b).overflowY};})()`);
   layouts.push({role,w,h,...layout});check(`${role} ${w}x${h} keeps dialog and fixed controls within viewport`,layout.fits&&layout.closeVisible&&layout.footerVisible&&layout.noHorizontal&&layout.overflow==='auto');
   if(h>=800)check(`${role} ${w}x${h} shows form without scrolling`,!layout.scroll);
   await browser('screenshot',`test-results/login-${role}-${w}x${h}.png`);
  }
  await browser('set','viewport','1280','800');await browser('click','#school-close');
 }
 await browser('click','#login-gate [data-login-role=student]');await browser('fill','#student-login-id','temporary-layout-value');
 await browser('click','#teacher-login-tab');await browser('click','#student-login-tab');
 check('switching role preserves typed student ID',await evaluate("document.querySelector('#student-login-id').value==='temporary-layout-value'"));
 await browser('click','#school-close');
 await browser('cookies','set',fixtures.teacher.browserCookie.name,fixtures.teacher.browserCookie.value,'--url',fixtures.origin+'/','--path','/','--secure','--httpOnly','--sameSite','Lax');
 await browser('reload');await until('window.__okazaki?.getState().activityAllowed');
 await browser('click','#school-button');check('authenticated account hides login choices',await evaluate("document.querySelector('.school-login-tabs').hidden"));await browser('click','#school-close');
 await until('window.__okazaki.getState().region.seamTriangles>0');
 check('real core boundary has rendered closure triangles',await evaluate('window.__okazaki.getState().region.seamTriangles>0'));
 await browser('click','#simple-menu');await browser('click','[data-view=east]');
 await browser('click','#panel-close');
 await until("window.__okazaki.getState().nearField.source==='core' && window.__okazaki.getState().nearField.width===2048");
 check('near station loads the 2048px original-vector detail within existing memory budget',await evaluate('(()=>{const n=window.__okazaki.getState().nearField;return n.resident===1&&n.textureBytes<=n.textureBudget&&n.anisotropy>=8;})()'));
 await until('window.__okazaki.getState().vectorStreets.triangles>0 && window.__okazaki.getState().vectorStreets.pending===0');
 check('roads and rails render as bounded terrain-following vector geometry',await evaluate('(()=>{const v=window.__okazaki.getState().vectorStreets;return v.visible&&v.triangles<=50000&&v.residentTiles<=4;})()'));
 await browser('screenshot','test-results/roads-detail-east.png');
 await browser('click','#simple-menu');await browser('click','[data-view=west]');await browser('click','#panel-close');await delay(1500);
 await browser('screenshot','test-results/roads-detail-west.png');
 await browser('click','#simple-menu');await browser('click','[data-view=overview]');await browser('click','#panel-close');await delay(1500);
 await browser('screenshot','test-results/terrain-seam-overview.png');
 check('no uncaught browser errors',await browser('errors')==='');
 passed=true;
}finally{
 if(!passed)await browser('screenshot','test-results/login-terrain-failure.png').catch(()=>{});
 await writeFile('test-results/login-terrain.json',JSON.stringify({passed,checks,layouts,scope:'Native Chrome, isolated real Worker/D1/R2; no real Google OAuth or physical Quest acceptance'},null,2));
 await browser('close').catch(()=>{});await server?.dispose();
}
