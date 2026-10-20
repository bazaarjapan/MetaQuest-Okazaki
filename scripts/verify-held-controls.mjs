// Local fixture only. Uses the production build, real Worker/D1/R2 and native
// browser clicks so a stale button focus cannot be hidden by canvas.focus().
// The Windows agent-browser CLI emits code:"" for letter keys. Send DOM
// keyboard events to the actual focused element with a real physical code.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startSchoolBrowserServer } from "./school-browser-server.mjs";
import { createServer } from "vite";

const run = promisify(execFile), session = "held-controls-62";
const cli = process.platform === "win32" ? resolve(`node_modules/agent-browser/bin/agent-browser-win32-${process.arch}.exe`) : process.execPath;
const prefix = process.platform === "win32" ? [] : [resolve("node_modules/agent-browser/bin/agent-browser.js")];
async function browser(...args) {
  try {
    const { stdout } = await run(cli, [...prefix, "--session", session, ...args],
      { windowsHide:true, encoding:"utf8", timeout:45000, maxBuffer:4*1024*1024 });
    return stdout.trim();
  } catch { throw Error(`Browser ${args[0]} failed; cookie values are not logged`); }
}
async function evaluate(source) {
  let value = JSON.parse(await browser("eval", `JSON.stringify(${source})`));
  return typeof value === "string" ? JSON.parse(value) : value;
}
const state = () => evaluate("window.__okazaki.getState()");
const key = (code,type="keydown") => evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent(${JSON.stringify(type)},{
  code:${JSON.stringify(code)},key:${JSON.stringify(code.startsWith("Key")?code.slice(3).toLowerCase():code)},bubbles:true,cancelable:true}))`);
async function until(expression) {
  const deadline = Date.now()+30000;
  while (!await evaluate(`Boolean(${expression})`)) {
    if(Date.now()>deadline) throw Error(`Timed out: ${expression}`);
    await delay(100);
  }
}
const checks=[];
function check(name,value) { assert.ok(value,name);checks.push(name);console.log(`PASS ${name}`); }
let server, xrServer, passed=false;
await mkdir("test-results",{recursive:true});
try {
  server=await startSchoolBrowserServer({singleClassroom:true});
  const fixtures=JSON.parse(await readFile(".cache/school-browser-fixtures.json","utf8"));
  assert.equal(fixtures.origin,"http://localhost:4174");
  await browser("--executable-path","C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "--args","--use-angle=swiftshader,--enable-unsafe-swiftshader","open",fixtures.origin);
  await browser("cookies","set",fixtures.teacher.browserCookie.name,fixtures.teacher.browserCookie.value,
    "--url",fixtures.origin+"/","--path","/","--secure","--httpOnly","--sameSite","Lax");
  await browser("reload");await until("window.__okazaki?.getState().activityAllowed");
  await browser("set","viewport","1280","800");
  check("production UI has no uncaught exceptions",await browser("errors")==="");
  await browser("upload","#stl-hotbar input[type=file]",fixtures.cubeFile);
  await until("window.__okazaki.getState().heldSTL.visible && !window.__okazaki.getState().hotbar.pending");
  check("real upload saves one reusable STL",(await state()).workshop.ownAssets.length===1);
  await browser("click","#stash-held-item");
  await until("!window.__okazaki.getState().heldSTL.visible");
  await browser("click","#stl-hotbar button");
  await until("window.__okazaki.getState().heldSTL.visible");
  check("slot click returns keyboard focus to canvas",await evaluate("document.activeElement===document.querySelector('#viewport > canvas')"));
  const before=await state();
  await key("KeyW");
  try { await until(`Math.hypot(...window.__okazaki.getState().creative.anchor.map((v,i)=>v-${JSON.stringify(before.creative.anchor)}[i]))>.1`); }
  catch(error) {
    await writeFile("test-results/held-controls-input-diagnosis.json",JSON.stringify({before,after:await state(),
      focus:await evaluate("({id:document.activeElement.id,tag:document.activeElement.tagName,hidden:document.hidden})")},null,2));
    throw error;
  } finally { await key("KeyW","keyup"); }
  const after=await state();
  check("W moves with held STL without an extra canvas click",Math.hypot(...after.creative.anchor.map((v,i)=>v-before.creative.anchor[i]))>.1 && after.heldSTL.visible);
  await key("F5");await key("F5","keyup");await until(`window.__okazaki.getState().creative.viewMode!==${JSON.stringify(after.creative.viewMode)}`);
  check("F5 changes view while holding",(await state()).creative.viewMode!==after.creative.viewMode && (await state()).heldSTL.visible);
  await browser("screenshot","test-results/held-controls-desktop.png");
  await key("KeyQ");await key("KeyQ","keyup");await until("!window.__okazaki.getState().heldSTL.visible");
  check("Q stashes without deleting saved STL",(await state()).workshop.ownAssets.length===1 && !(await state()).hotbar.aiming);
  await browser("click","#stl-hotbar button");await until("window.__okazaki.getState().heldSTL.visible");
  await browser("click","#stl-hotbar button");await until("!window.__okazaki.getState().heldSTL.visible");
  check("same slot toggles to empty hands",!(await state()).hotbar.aiming);
  await browser("click","#stl-hotbar button");await until("window.__okazaki.getState().heldSTL.visible");
  await key("Escape");await key("Escape","keyup");await delay(100);
  await key("KeyQ");await key("KeyQ","keyup");
  check("menu protects held item and stops movement",(await state()).heldSTL.visible && (await state()).creative.blocked);
  await key("Escape");await key("Escape","keyup");
  await browser("set","viewport","390","844");await delay(150);
  await browser("screenshot","test-results/held-controls-mobile.png");
  check("stash button fits narrow screen",await evaluate("(()=>{const r=document.querySelector('#stash-held-item').getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;})()"));
  if((await state()).free) await browser("click","#mobile-flight");
  await browser("click","#stash-held-item");await until("!window.__okazaki.getState().heldSTL.visible");
  check("touch layout button stashes without resuming flight",!(await state()).free);
  check("browser remains free of uncaught exceptions",await browser("errors")==="");
  // Same authenticated local classroom, with the repository's dev-only IWER
  // runtime. Production output is separately checked to exclude that runtime.
  const rewriteOrigin=(proxyRequest,request)=>{
    if(request.headers.origin==="http://localhost:4173") proxyRequest.setHeader("Origin",fixtures.origin);
  };
  xrServer=await createServer({server:{host:"127.0.0.1",port:4173,strictPort:true,proxy:{
    "/api":{target:fixtures.origin,ws:true,changeOrigin:true,configure(proxy){
      proxy.on("proxyReq",rewriteOrigin);proxy.on("proxyReqWs",rewriteOrigin);
    }}
  }}});
  await xrServer.listen();
  await browser("set","viewport","1280","800");
  await browser("open","http://localhost:4173/?testxr");
  await until("window.__okazaki?.getState().activityAllowed && window.__xrTestDevice");
  await browser("click","#stl-hotbar button");await until("window.__okazaki.getState().heldSTL.visible");
  const draft=(await state()).workshop.current.id;
  await browser("click","#simple-menu");
  await until("!document.querySelector('#enter-vr').disabled");
  await browser("click","#enter-vr");await until("window.__okazaki.getState().xr");
  check("XR hides PC hand controls",await evaluate("document.querySelector('#held-item-controls').hidden") && !(await state()).heldSTL.visible);
  check("XR hides the 2D people radar",await evaluate("document.querySelector('#world-radar').hidden"));
  await key("KeyQ");await key("KeyQ","keyup");
  check("Q in XR preserves held draft",(await state()).workshop.current.id===draft);
  await evaluate('window.__xrTestDevice.controllers.left.updateButtonValue("x-button",0) ?? true');
  await delay(600);
  await evaluate('window.__xrTestDevice.controllers.left.updateButtonValue("x-button",1) ?? true');
  await until("!window.__okazaki.getState().xr");
  await evaluate('window.__xrTestDevice.controllers.left.updateButtonValue("x-button",0) ?? true');
  await until("window.__okazaki.getState().heldSTL.visible");
  check("XR return preserves draft and leaves movement OFF",(await state()).workshop.current.id===draft && !(await state()).free);
  await until("!document.querySelector('#world-radar').hidden");
  check("XR return restores the people radar",await evaluate("document.querySelector('.radar-legend').textContent.includes('先生')"));
  passed=true;
} finally {
  if(!passed) await browser("screenshot","test-results/held-controls-failure.png").catch(()=>{});
  await writeFile("test-results/held-controls.json",JSON.stringify({passed,checks,
    scope:"Chrome UI -> production Worker -> ephemeral D1/R2; IWER transitions; no production writes or physical Quest"},null,2));
  await browser("close").catch(()=>{});
  await xrServer?.close();
  await server?.dispose();
}
