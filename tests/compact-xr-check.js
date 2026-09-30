// Enter IWER VR from the mobile settings sheet before running this check.
(async () => {
  const s=()=>window.__okazaki.getState(), results=[],wait=ms=>new Promise(r=>setTimeout(r,ms));
  const assert=(ok,name,detail)=>{results.push({ok:Boolean(ok),name,detail});if(!ok)throw new Error(name);};
  assert(s().xr&&s().ui.mobile&&s().version==='1.6.0','mobile-settings-vr-entry-works');
  assert(!s().touch.enabled&&s().touch.activePointers===0,'immersive-vr-disables-html-virtual-sticks');
  const before=s().quality.id;
  assert(before==='high'&&s().quality.xrScale===1.2&&document.querySelector('#quality-select').disabled,
    'high-detail-xr-framebuffer-profile-and-quality-lock');
  const select=document.querySelector('#quality-select');select.value='performance';select.dispatchEvent(new Event('change',{bubbles:true}));
  await wait(300);
  assert(s().quality.id===before&&s().quality.xrScale===1.2,'programmatic-change-cannot-resize-live-xr-framebuffer');
  select.value=before; // Restore the deliberately altered DOM fixture.
  assert(['left','right'].every(hand=>s().hud.hands[hand].spatialVisible&&!s().hud.hands[hand].previewVisible),
    'mobile-css-does-not-hide-real-spatial-controller-huds');
  return JSON.stringify({passed:true,environment:'IWER mobile viewport, NOT physical Quest or smartphone',results});
})();
