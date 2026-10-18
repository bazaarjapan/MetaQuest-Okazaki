// Run after a local built app has loaded with an emulated Quest Browser UA and
// a pre-existing creative preference. No physical Quest evidence is claimed.
(async()=>{
  const state=()=>window.__okazaki.getState(),results=[];
  const check=(ok,name,detail)=>{results.push({ok:Boolean(ok),name,detail});if(!ok)throw Error(name);};
  check(state().ready&&state().activityAllowed,'named-connected-user-ready');
  check(state().device.questBrowser,'Quest-browser-device-hint');
  check(state().creative.mode==='drone'&&document.querySelector('#control-mode').value==='drone','Quest-automatically-starts-in-drone');
  check(!state().free&&!state().creative.moving,'Quest-starts-stationary');
  check(localStorage.getItem('okazaki-control-mode-v2')==='creative','Quest-default-does-not-overwrite-PC-preference');
  const before=state().camera;await new Promise(r=>setTimeout(r,150));
  check(before.every((v,i)=>Math.abs(state().camera[i]-v)<1e-6),'no-movement-without-input');
  document.querySelector('#simple-menu').click();document.querySelector('#tab-observe').click();
  const note=document.querySelector('#device-control-note');
  check(!note.hidden&&note.textContent.includes('モード2')&&note.textContent.includes('全画面'),'Quest-note-explains-mode-and-VR');
  const original=localStorage.getItem('okazaki-control-mode-v2');
  const mode=document.querySelector('#control-mode');
  mode.value='creative';mode.dispatchEvent(new Event('change',{bubbles:true}));
  check(state().creative.mode==='creative'&&!state().free,'deliberate-manual-override-stops-first');
  mode.value='drone';mode.dispatchEvent(new Event('change',{bubbles:true}));
  check(state().creative.mode==='drone'&&!state().free&&localStorage.getItem('okazaki-control-mode-v2')===original,'mode-roundtrip-keeps-PC-preference-and-stays-stopped');
  if(!state().xr) {
    const supported=Boolean(navigator.xr&&await navigator.xr.isSessionSupported('immersive-vr'));
    check(document.querySelector('#enter-vr').disabled===!supported,'VR-capability-is-not-inferred-from-UA');
  }
  document.querySelector('#panel-close').click();
  return JSON.stringify({passed:true,environment:'actual browser with emulated Quest UA, NOT physical Quest',width:innerWidth,results});
})();
