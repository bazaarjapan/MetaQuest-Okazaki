(async () => {
  const results=[],s=()=>window.__okazaki.getState(),wait=ms=>new Promise(r=>setTimeout(r,ms));
  const assert=(ok,name,detail)=>{results.push({ok:Boolean(ok),name,detail});if(!ok)throw new Error(name);};
  while(!s().ready&&!s().error) await wait(100);
  assert(s().ready && s().version==='1.7.0','new-ui-release-loaded');
  assert(localStorage.getItem('okazaki-webxr-quality-v1')==='balanced'&&localStorage.getItem('okazaki-webxr-quality-v2')===null,
    'old-choice-retained-and-new-preference-unset');
  assert(s().quality.id==='high'&&s().quality.shadows&&s().quality.terrainSize[0]===3072&&s().quality.xrScale===1.2,
    'updated-first-load-uses-real-high-detail-profile',s().quality);
  assert(document.querySelector('#quality-shortcut').textContent==='高精細','high-default-visible-in-compact-badge');
  return JSON.stringify({passed:true,environment:'Browser preference migration, not device FPS',results});
})();
