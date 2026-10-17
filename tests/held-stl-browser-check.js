// Run against the loopback school-browser-server only after importing and
// placing its cube through the actual UI. Never run against production data.
(async () => {
  if (location.origin !== "http://localhost:4174") throw Error("Local fixture only");
  const state=()=>window.__okazaki.getState(), results=[];
  const check=(ok,name)=>{results.push({ok:Boolean(ok),name});if(!ok)throw Error(name);};
  const wait=ms=>new Promise(r=>setTimeout(r,ms));
  const until=async fn=>{const end=performance.now()+10000;while(!fn()&&performance.now()<end)await wait(50);if(!fn())throw Error("UI did not settle");};
  const click=id=>document.getElementById(id).click();
  const key=code=>window.dispatchEvent(new KeyboardEvent("keydown",{code,bubbles:true,cancelable:true}));
  check(state().creative.viewMode==="back"&&state().avatar.visible,"signed-in-rear-view");
  check(Math.abs(state().creative.eye[2]-105)<1e-6,"server-pose-not-shifted-by-rear-camera");
  check(state().workshop.committed===1&&!state().heldSTL.visible,"server-confirmed-placement-removes-held-copy");
  const rotation=document.getElementById("object-ry"); rotation.value=30;rotation.dispatchEvent(new Event("change"));
  await wait(150);check(!state().heldSTL.visible,"editing-placed-object-does-not-create-held-inventory");
  click("object-cancel"); click("object-remove");
  await until(()=>state().workshop.committed===0&&!state().workshop.busy);
  click("object-reuse"); await until(()=>state().heldSTL.visible);
  check(state().avatar.holding&&state().heldSTL.parent==="held-stl-hand","reused-STL-attached-to-raised-avatar-hand");
  click("workshop-close");document.querySelector("#viewport > canvas").focus();
  await until(()=>!state().creative.blocked);
  key("F5"); await wait(100);check(state().creative.viewMode==="front"&&state().heldSTL.visible,"front-view-keeps-model");
  key("F5"); await wait(100);check(state().creative.viewMode==="first"&&state().heldSTL.visible&&!state().avatar.holding,"first-person-has-hand-corner-model");
  check(state().heldSTL.armVisible&&state().heldSTL.armHolding,"first-person-arm-supports-selected-STL");
  key("F5"); await wait(100);check(state().heldSTL.parent==="held-stl-hand","rear-view-restores-hand-parent");
  check(!state().heldSTL.armVisible,"rear-view-has-no-duplicate-first-person-arm");
  click("open-workshop");click("object-cancel");await until(()=>!state().heldSTL.visible);
  check(!state().avatar.holding,"cancel-clears-held-model-and-arm-pose");
  click("object-reuse");await until(()=>state().heldSTL.visible);click("workshop-close");
  return {passed:true,environment:"actual local production build and real Worker/D1/R2; not Google sign-in or physical Quest",results};
})();
