import test from "node:test";
import assert from "node:assert/strict";
import { worldActivityAllowed,createActivityGate } from "../src/activity-gate.js";
const connected={user:{id:"student",name:"青"},world:{id:"world"},connection:"connected"};
test("world controls require named identity, connected room and ready model",()=>{
  assert.equal(worldActivityAllowed(connected),true);
  for(const state of [null,{}, {...connected,user:null},{...connected,user:{namePending:true}},
    {...connected,world:null},{...connected,connection:"reconnecting"},{...connected,connection:"offline"}]) assert.equal(worldActivityAllowed(state),false);
  assert.equal(worldActivityAllowed(connected,false),false);
});
test("gate blocks world inputs but leaves login and name form operable, and relocks on logout",()=>{
  const listeners=new Map(),button={addEventListener(){},removeEventListener(){}},message={},surfaces=[{},{}];
  const node={hidden:false,querySelector:s=>s==="p"?message:button};
  let locks=0;
  const gate=createActivityGate({documentTarget:{querySelector:()=>node,querySelectorAll:()=>surfaces},
    windowTarget:{addEventListener:(type,fn)=>listeners.set(type,fn),removeEventListener:type=>listeners.delete(type)},onOpen(){},onLock(){locks++;}});
  const dispatch=(type,inside=false,key="w")=>{let stopped=false;listeners.get(type)({type,key,target:{closest:()=>inside},preventDefault(){},stopImmediatePropagation(){stopped=true;}});return stopped;};
  for(const type of ["keydown","keyup","pointerdown","pointermove","wheel","click","touchstart"])assert.equal(dispatch(type),true,type);
  assert.equal(dispatch("keydown",true),false);assert.equal(dispatch("click",true),false);
  gate.update({user:null});assert.match(button.textContent,/ログイン/);assert.ok(surfaces.every(s=>s.inert));
  gate.update({...connected,user:{namePending:true}});assert.match(button.textContent,/名前/);
  gate.update(connected);assert.equal(gate.isAllowed(),true);assert.ok(node.hidden);assert.ok(surfaces.every(s=>!s.inert));assert.equal(dispatch("keydown"),false);
  gate.update({user:null});assert.equal(locks,1);assert.equal(gate.isAllowed(),false);assert.equal(dispatch("keydown"),true);
  gate.update({user:null});assert.equal(locks,1,"reset once per lock transition");
  gate.destroy();assert.equal(listeners.size,0);
});

test("model or WebGL failure has an operable retry without unlocking world controls",()=>{
  let click,retries=0;
  const button={addEventListener:(_,fn)=>{click=fn;},removeEventListener(){}},message={};
  const gate=createActivityGate({documentTarget:{querySelector:()=>({querySelector:s=>s==="p"?message:button}),querySelectorAll:()=>[]},
    windowTarget:{addEventListener(){},removeEventListener(){}},onOpen(){throw Error("must not open uninitialized account UI");},onRetry(){retries++;}});
  gate.setError("通信を確認してください。");
  assert.equal(gate.update(connected),false);
  assert.match(message.textContent,/通信/);assert.match(button.textContent,/再読み込み/);
  click();assert.equal(retries,1);
});
