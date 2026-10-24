// Real isolated Worker/D1/R2 and native Chrome. Google button rendering is
// stubbed only in this test; no Google credential exchange or production writes.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {startSchoolBrowserServer} from './school-browser-server.mjs';
const run=promisify(execFile),session=process.env.BROWSER_SESSION??'simple-login81-ready',cli=resolve('node_modules/agent-browser/bin/agent-browser-win32-x64.exe');
async function browser(...args){try{return(await run(cli,['--session',session,...args],{windowsHide:true,timeout:120000,maxBuffer:4*1024*1024})).stdout.trim();}catch{throw Error(`Browser ${args[0]} failed; private arguments omitted`);}}
async function evaluate(expr){let v=JSON.parse(await browser('eval',`(async()=>JSON.stringify(await (${expr})))()`));return typeof v==='string'?JSON.parse(v):v;}
async function until(expr){const end=Date.now()+90000;while(!await evaluate(`Boolean(${expr})`)){assert.ok(Date.now()<end,'Timed out: '+expr);await delay(200);}}
const checks=[],layouts=[],check=(name,ok)=>{assert.ok(ok,name);checks.push(name);console.log('PASS '+name);};
let server,passed=false;await mkdir('test-results',{recursive:true});
try{
 server=await startSchoolBrowserServer({singleClassroom:true});
 const f=JSON.parse(await readFile('.cache/school-browser-fixtures.json','utf8'));
 await browser('--executable-path','C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','--args','--ignore-gpu-blocklist','open',f.origin);
 await until('window.__okazaki?.getState().school.configured');
 check('gate preserves clear teacher Google and student ID entry labels',await evaluate("(()=>{const t=document.querySelector('#login-gate [data-login-role=teacher]'),s=document.querySelector('#login-gate [data-login-role=student]');return t.textContent.includes('先生の入り口')&&t.textContent.includes('Google')&&s.textContent.includes('生徒の入り口')&&s.textContent.includes('ID');})()"));
 await browser('set','viewport','1280','800');await browser('screenshot','test-results/simple-login-gate.png');
 await evaluate("(()=>{window.__googleButtons=0;window.google={accounts:{id:{initialize(){},renderButton(host){window.__googleButtons++;const b=document.createElement('button');b.textContent='Googleでログイン（テスト表示）';host.append(b);},cancel(){}}}};return true;})()");
 for(const role of ['teacher','student']){
  await browser('click',`#login-gate [data-login-role=${role}]`);
  if(role==='teacher')await until('window.__googleButtons>0');
  check(role+' entry shows only its own login method',await evaluate(`!document.querySelector('#${role}-login-panel').hidden&&document.querySelector('#${role==='teacher'?'student':'teacher'}-login-panel').hidden`));
  if(role==='student')check('student instructions contain only ID password guidance',await evaluate("!document.querySelector('#school-status').textContent.includes('Google')&&document.querySelector('#school-status').textContent.includes('ID')"));
  for(const [w,h] of [[1440,900],[1280,800],[797,881],[390,844],[844,390]]){
   await browser('set','viewport',String(w),String(h));
   const l=await evaluate("(()=>{const d=document.querySelector('#school-dialog'),b=d.querySelector('.school-body'),r=d.getBoundingClientRect();return{fits:r.left>=0&&r.top>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1,noHorizontal:b.scrollWidth<=b.clientWidth+1,scroll:b.scrollHeight>b.clientHeight+1,fixed:['school-close'].every(id=>{const r=document.getElementById(id).getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;})};})()");
   layouts.push({role,w,h,...l});check(`${role} ${w}x${h} fits and keeps close accessible`,l.fits&&l.noHorizontal&&l.fixed);
   if(h>=800)check(`${role} ${w}x${h} needs no form scrolling`,!l.scroll);
   await browser('screenshot',`test-results/simple-${role}-${w}x${h}.png`);
  }
  await browser('set','viewport','1280','800');await browser('click','#school-close');
 }
 await browser('cookies','set',f.teacher.browserCookie.name,f.teacher.browserCookie.value,'--url',f.origin+'/','--path','/','--secure','--httpOnly','--sameSite','Lax');
 await browser('reload');await until('window.__okazaki?.getState().activityAllowed');await browser('click','#school-button');
 await until("!document.querySelector('.student-roster-filters').hidden");
 check('teacher roster loads automatically on opening management',await evaluate("document.querySelector('#student-roster-count').textContent.includes('表示')"));
 check('normal management shows autosave and hides optional restore controls',await evaluate("document.querySelector('#school-autosave').textContent.includes('自動保存 ON')&&!document.querySelector('#school-save-details').open&&document.querySelector('#school-world-save').closest('details').id==='school-save-details'"));
 await browser('click','#student-issue');await until("!document.querySelector('#student-issued-credentials').hidden");
 const credentials=await evaluate("document.querySelector('#student-issued-credentials').value.split('\\n')[1].split('\\t')");
 await browser('click','#school-close');await browser('click','#school-quick-logout');await until('!window.__okazaki.getState().school.user');
 check('quick logout works while management automatically fetches roster',await evaluate("document.querySelector('#login-gate [data-login-role=teacher]').textContent.includes('先生の入り口')"));
 if(await evaluate("document.querySelector('#school-dialog').open"))await browser('click','#school-close');
 await browser('click','#login-gate [data-login-role=student]');await browser('fill','#student-login-id',credentials[0]);await browser('fill','#student-password',credentials[1]);await browser('click','#student-login-panel button');
 await until("document.querySelector('#school-avatar-name')");await browser('fill','#school-avatar-name','自動保存確認生徒');await browser('click','#school-avatar-save');await until('window.__okazaki.getState().activityAllowed');await browser('click','#school-close');
 check('student enters with ID password and first nickname only',await evaluate("window.__okazaki.getState().school.user.role==='student'"));
 await browser('upload','#stl-hotbar input[type=file]',f.cubeFile);await until('window.__okazaki.getState().workshop.current&&!window.__okazaki.getState().hotbar.pending');
 await browser('click','#simple-menu');await browser('click','#open-workshop');await browser('click','#workshop-transform summary');
 for(const [id,value] of [['object-scale',1],['object-x',f.cube.groundPositions[0].position[0]],['object-z',f.cube.groundPositions[0].position[2]]])await evaluate(`(()=>{const e=document.getElementById('${id}');e.value=${JSON.stringify(String(value))};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
 await until("!document.querySelector('#object-apply').disabled");await browser('click','#object-apply');await until('window.__okazaki.getState().school.objects.length===1&&window.__okazaki.getState().school.pendingSaves===0');
 const object=await evaluate('window.__okazaki.getState().school.objects[0]');
 await browser('reload');await until('window.__okazaki?.getState().activityAllowed&&window.__okazaki.getState().school.objects.length===1');
 const restored=await evaluate('window.__okazaki.getState().school');
 check('STL and confirmed placement survive reload without any save checkpoint',restored.assets.length===1&&restored.objects[0].id===object.id&&JSON.stringify(restored.objects[0].position)===JSON.stringify(object.position)&&restored.snapshots.length===0);
 await browser('click','#school-button');check('student sees simple autosave account with no teacher controls',await evaluate("document.querySelector('#school-autosave').textContent.includes('自動保存 ON')&&!document.querySelector('#school-world-save')&&!document.querySelector('#student-issue')"));
 await browser('screenshot','test-results/simple-student-autosave.png');
 check('no uncaught browser exceptions',await browser('errors')==='');passed=true;
}finally{
 if(!passed)await browser('screenshot','test-results/simple-login-failure.png').catch(()=>{});
 await writeFile('test-results/simple-login-autosave.json',JSON.stringify({passed,checks,layouts,scope:'Native Chrome -> isolated real Worker/D1/R2. Google rendering stub only; no real Google OAuth or physical Quest acceptance.'},null,2));
 await browser('close').catch(()=>{});await server?.dispose();
}
