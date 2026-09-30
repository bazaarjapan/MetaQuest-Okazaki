(async () => {
  const s = () => window.__okazaki.getState(), results = [];
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const assert = (ok, name, detail) => { results.push({ok:Boolean(ok),name,detail}); if(!ok) throw new Error(name+': '+JSON.stringify(detail)); };
  const visible = el => Boolean(el && el.getBoundingClientRect().width && getComputedStyle(el).visibility !== 'hidden');
  const inside = el => { const r=el.getBoundingClientRect(); return r.left>=0 && r.top>=0 && r.right<=innerWidth+1 && r.bottom<=innerHeight+1; };
  assert(s().ready && !s().ui.mobile && s().version==='1.6.0','compact-desktop-ready');
  assert(document.documentElement.scrollHeight<=innerHeight+1 && document.documentElement.scrollWidth<=innerWidth+1,
    'entire-workspace-fits-one-window',{width:innerWidth,height:innerHeight,scrollHeight:document.documentElement.scrollHeight});
  assert(['#viewport','#control-panel','#home','#fullscreen','#free-move','#enter-vr','.control-tabs'].every(id=>inside(document.querySelector(id))),
    'main-scene-and-primary-actions-inside-screen');
  for(const id of ['observe','region','settings']) {
    document.querySelector('#tab-'+id).click();
    assert(s().ui.active===id && visible(document.querySelector('#panel-'+id)) &&
      ['observe','region','settings'].filter(key=>visible(document.querySelector('#panel-'+key))).length===1,
      'only-selected-tab-shown-'+id);
  }
  document.querySelector('#tab-observe').click();
  document.querySelector('#tab-observe').focus();
  document.querySelector('#tab-observe').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
  assert(s().ui.active==='region' && document.activeElement.id==='tab-region','keyboard-arrow-switches-tab-and-focus');
  document.querySelector('#quality-shortcut').click();
  assert(s().ui.active==='settings' && visible(document.querySelector('#quality-select')),'quality-badge-opens-settings');
  const selector=document.querySelector('#quality-select');
  selector.value='high';selector.dispatchEvent(new Event('change',{bubbles:true}));
  while(s().qualityLoading) await wait(100);
  assert(s().quality.id==='high' && s().quality.shadows && s().quality.terrainSize[0]===3072 &&
    document.querySelector('#quality-shortcut').textContent==='高精細','high-detail-real-renderer-settings');
  assert(!s().touch.enabled && !visible(document.querySelector('#mobile-toolbar')),'mobile-input-hidden-on-desktop');
  document.querySelector('#tab-observe').click();
  return JSON.stringify({passed:true,environment:'Desktop viewport layout, not device FPS',results});
})();
