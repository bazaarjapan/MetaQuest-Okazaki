(async () => {
  const s=()=>window.__okazaki.getState(), results=[],wait=ms=>new Promise(r=>setTimeout(r,ms));
  const assert=(ok,name)=>{results.push({ok:Boolean(ok),name});if(!ok)throw new Error(name);};
  while(!s().ready&&!s().error)await wait(100);
  assert(s().quality.id==='balanced'&&s().quality.terrainSize[0]===1536,'newly-selected-quality-restored-after-navigation');
  assert(localStorage.getItem('okazaki-webxr-quality-v2')==='balanced'&&localStorage.getItem('okazaki-webxr-quality-v1')==='balanced',
    'new-preference-stored-without-mutating-legacy-value');
  assert(document.querySelector('#quality-shortcut').textContent==='標準（くっきり）','restored-choice-shown-on-visible-badge');
  return JSON.stringify({passed:true,environment:'Actual browser reload and preference persistence',results});
})();
