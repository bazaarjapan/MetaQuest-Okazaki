// End-to-end local gate: real Worker/D1/R2 and native Chrome UI. No production writes.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {startSchoolBrowserServer} from './school-browser-server.mjs';
const run=promisify(execFile),cli=resolve(`node_modules/agent-browser/bin/agent-browser-win32-${process.arch}.exe`);
let session='street-teacher-64',server,passed=false;
const sessions=['street-teacher-64','street-student-64'],checks=[];
async function browser(...args){if(['click','fill','select'].includes(args[0]))await browser('eval',`(()=>{document.querySelector(${JSON.stringify(args[1])})?.scrollIntoView({block:'center',inline:'nearest'});return true;})()`);try{return(await run(cli,['--session',session,...args],{windowsHide:true,encoding:'utf8',timeout:45000,maxBuffer:4*1024*1024})).stdout.trim();}catch{throw Error(`Browser ${args[0]} failed (private credentials omitted)`);}}
async function evaluate(expression){let value=JSON.parse(await browser('eval',`JSON.stringify(${expression})`));return typeof value==='string'?JSON.parse(value):value;}
const state=()=>evaluate('window.__okazaki.getState()');
async function until(expression,timeout=45000){const deadline=Date.now()+timeout;while(!await evaluate(`Boolean(${expression})`)){if(Date.now()>deadline)throw Error(`Timed out: ${expression}`);await delay(150);}}
const check=(name,ok)=>{assert.ok(ok,name);checks.push(name);console.log('PASS '+name);};
const launch=async origin=>browser('--executable-path','C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','--args','--use-angle=swiftshader,--enable-unsafe-swiftshader','open',origin);
async function field(id,value){await browser('fill','#'+id,String(value));await evaluate(`document.querySelector('#${id}').dispatchEvent(new Event('change',{bubbles:true}))`);}
await mkdir('test-results',{recursive:true});
try{
 server=await startSchoolBrowserServer({singleClassroom:true});
 const fixtures=JSON.parse(await readFile('.cache/school-browser-fixtures.json','utf8'));
 await launch(fixtures.origin);
 await browser('cookies','set',fixtures.teacher.browserCookie.name,fixtures.teacher.browserCookie.value,'--url',fixtures.origin+'/','--path','/','--secure','--httpOnly','--sameSite','Lax');
 await browser('reload');await until('window.__okazaki?.getState().activityAllowed');
 await browser('set','viewport','1440','900');
 await browser('click','#simple-menu');
 const menu=await evaluate(`(()=>{const p=document.querySelector('#control-panel'),b=p.querySelector('.panel-body'),r=p.getBoundingClientRect();return{width:r.width,top:r.top,bottom:r.bottom,height:innerHeight,scroll:b.scrollHeight,client:b.clientHeight,overflow:getComputedStyle(b).overflowY};})()`);
 check('wide desktop menu fits without scrolling',menu.width>=900&&menu.top>=0&&menu.bottom<=menu.height&&menu.scroll<=menu.client+1&&menu.overflow==='auto');
 await browser('screenshot','test-results/street-menu-desktop.png');
 for(const [w,h] of [[1280,800],[390,844],[844,390]]){
  await browser('set','viewport',String(w),String(h));await delay(100);
  if(!(await state()).ui.open)await browser('click',w<=800||h<=500?'[data-mobile-panel=observe]':'#simple-menu');
  const result=await evaluate(`(()=>{const p=document.querySelector('#control-panel'),b=p.querySelector('.panel-body'),r=p.getBoundingClientRect();return{fits:r.top>=0&&r.left>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1,scroll:b.scrollHeight>b.clientHeight+1,overflow:getComputedStyle(b).overflowY};})()`);
  check(`menu ${w}x${h} stays within screen with conditional overflow`,result.fits&&result.overflow==='auto'&&(w>800&&h>500||result.scroll));
  await browser('screenshot',`test-results/street-menu-${w}x${h}.png`);
 }
 await browser('set','viewport','1280','800');
 if(!(await state()).ui.open)await browser('click','#simple-menu');
 await browser('click','#tab-settings');await browser('select','#time-of-day','evening');
 check('evening lighting selector applies',(await state()).timeOfDay==='evening');
 await browser('reload');await until('window.__okazaki?.getState().activityAllowed');
 check('evening preference survives reload',(await state()).timeOfDay==='evening');
 await browser('click','#simple-menu');await browser('click','#tab-settings');await browser('select','#time-of-day','day');
 await browser('click','#tab-region');await until("document.querySelector('#landmark-select')?.options.length>=4");
 check('real mapped landmark choices are available',await evaluate("[...document.querySelector('#landmark-select').options].some(o=>o.textContent==='岡崎公園')"));
 await browser('click','#panel-close');
 await until('window.__okazaki.getState().streetScenery.trees>0',60000);
 check('verified terrain renders bounded trees and signals',(await state()).streetScenery.trees<=180&&(await state()).streetScenery.signals<=16);
 await browser('click','#school-button');await browser('click','#student-issue');
 await until("!document.querySelector('#student-issued-credentials').hidden");
 const secret=await evaluate("document.querySelector('#student-issued-credentials').value.split('\\n')[1].split('\\t')");
 session=sessions[1];await launch(fixtures.origin);await until("document.querySelector('#student-login-id')");
 if(!await evaluate("document.querySelector('#school-dialog').open"))await browser('click','#login-gate button');
 await browser('fill','#student-login-id',secret[0]);await browser('fill','#student-password',secret[1]);
 await browser('click','#school-dialog form button');await until("document.querySelector('#school-avatar-name')");
 await browser('fill','#school-avatar-name','レーダー検証生徒');await browser('click','#school-avatar-save');
 await until('window.__okazaki?.getState().activityAllowed');
 await browser('click','#school-close');await browser('set','viewport','1280','800');
 await browser('upload','#stl-hotbar input[type=file]',fixtures.cubeFile);
 await until('window.__okazaki.getState().workshop.current && !window.__okazaki.getState().hotbar.pending');
 await browser('click','#simple-menu');await browser('click','#open-workshop');
 const placement=fixtures.cube.groundPositions[0];
 await field('object-scale',1);await field('object-x',placement.position[0]);await field('object-z',placement.position[2]);
 await browser('fill','#exhibit-title','光の駅');await browser('fill','#exhibit-description','みんなが集まる、太陽光で動く駅です。');await browser('click','#exhibit-save');
 await until("!document.querySelector('#object-apply').disabled");
 await evaluate("(()=>{const b=document.querySelector('#object-apply');b.scrollIntoView({block:'center'});b.addEventListener('click',()=>window.__streetApplyClicked=true,{once:true});return true;})()");await delay(200);await browser('click','#object-apply');
 check('native placement confirmation reaches its button',await evaluate('window.__streetApplyClicked===true'));
 await until('window.__okazaki.getState().school.objects.length===1');
 const object=(await state()).school.objects[0];
 check('student placement stores exhibit title and description',object.title==='光の駅'&&object.description.includes('太陽光'));
 await browser('click','#workshop-close');await until("!document.querySelector('#workshop-dialog').open");if((await state()).ui.open)await browser('click','#panel-close');
 await until('window.__okazaki.getState().radar?.count===1');
 check('own placement is tracked by radar',(await state()).radar.markers[0].id===object.id);
 await browser('click','.radar-actions button');check('radar distance selector changes range',(await evaluate("document.querySelector('.radar-actions button').textContent")).includes('1,000'));
 await browser('screenshot','test-results/street-radar-student.png');
 session=sessions[0];
 await browser('click','#student-roster');await until("document.querySelector('.student-work')");
 check('teacher roster shows author, title and location',await evaluate("document.querySelector('#student-roster-list').textContent.includes('光の駅') && document.querySelector('#student-roster-list').textContent.includes('水平距離')"));
 await browser('screenshot','test-results/street-teacher-roster.png');
 await browser('click','.student-work button');
 await until("window.__okazaki.getState().workshop.locatedName!==null",60000);
 check('teacher can travel safely beside student work',!(await state()).free);
 await until('window.__okazaki.getState().exhibits.count===1');
 await browser('screenshot','test-results/street-exhibit.png');
 await browser('click','#school-button');await browser('click','.student-work button:nth-of-type(2)');
 await until('window.__okazaki.getState().school.objects.length===0');
 check('teacher roster updates after return',await evaluate("document.querySelector('#student-roster-list').textContent.includes('配置中の作品はありません')"));
 session=sessions[1];await until('window.__okazaki.getState().school.objects.length===0');
 check('student keeps STL in hotbar after teacher return',(await state()).workshop.ownAssets.length===1);
 await browser('click','#stl-hotbar button');await until('window.__okazaki.getState().heldSTL.visible');
 check('returned student STL can be held again',(await state()).workshop.current.assetId===object.assetId);
 await browser('click','#stash-held-item');await browser('click','#simple-menu');await browser('click','#tab-settings');
 await browser('select','#quality-select','performance');await until("!window.__okazaki.getState().qualityLoading && !window.__okazaki.getState().streetScenery.visible");
 check('performance profile hides decorative scenery',!(await state()).streetScenery.visible);
 for(const s of sessions){session=s;check(`${s} has no uncaught browser exceptions`,await browser('errors')==='');}
 passed=true;
}finally{
 if(!passed){await browser('screenshot','test-results/street-failure.png').catch(()=>{});await writeFile('test-results/street-failure-state.json',JSON.stringify(await state().catch(()=>null),null,2));}
 await writeFile('test-results/street-features.json',JSON.stringify({passed,checks,scope:'Local real Worker/D1/R2 plus Chrome; no production writes or physical Quest'},null,2));
 for(const s of sessions){session=s;await browser('close').catch(()=>{});}await server?.dispose();
}
