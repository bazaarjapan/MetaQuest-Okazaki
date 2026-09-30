(async () => {
  const s=()=>window.__okazaki.getState(),results=[],wait=ms=>new Promise(r=>setTimeout(r,ms));
  const assert=(ok,name,detail)=>{results.push({ok:Boolean(ok),name,detail});if(!ok)throw new Error(name+': '+JSON.stringify(detail));};
  const visible=el=>Boolean(el&&el.getBoundingClientRect().width&&getComputedStyle(el).visibility!=='hidden');
  const inside=el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1;};
  const distance=(a,b)=>Math.hypot(...a.map((v,i)=>v-b[i]));
  const pointer=(hand,type,id,x=0,y=0)=>{
    const pad=document.querySelector('.touch-stick-'+hand),r=pad.getBoundingClientRect(),radius=Math.min(r.width,r.height)/2;
    pad.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:id,pointerType:'touch',isPrimary:id===71,button:0,
      clientX:r.left+r.width/2+x*radius,clientY:r.top+r.height/2+y*radius}));
  };
  assert(s().ready&&s().ui.mobile,'mobile-layout-ready');
  assert(document.documentElement.scrollWidth<=innerWidth+1&&document.documentElement.scrollHeight<=innerHeight+1,
    'no-page-overflow-portrait-or-landscape',{width:innerWidth,height:innerHeight});
  assert(!s().ui.open && document.querySelector('#control-panel').inert && !visible(document.querySelector('#control-panel')),
    'initial-scene-unobscured-and-hidden-panel-not-focusable');
  assert([...document.querySelectorAll('#mobile-toolbar button')].every(el=>inside(el)&&el.getBoundingClientRect().height>=44),
    'bottom-toolbar-visible-with-44px-touch-targets');
  for(const id of ['observe','region','settings']){
    document.querySelector('[data-mobile-panel='+id+']').click();await wait(100);
    assert(s().ui.open&&s().ui.active===id&&inside(document.querySelector('#control-panel'))&&!document.querySelector('#control-panel').inert&&
      document.activeElement.id==='tab-'+id&&document.querySelector('.panel-body').getBoundingClientRect().height>=100,
      'mobile-panel-opens-and-fits-'+id);
    document.querySelector('[data-mobile-panel='+id+']').click();
    assert(!s().ui.open,'same-toolbar-button-closes-'+id);
  }
  document.querySelector('#mobile-flight').click(); await wait(200);
  assert(s().free&&s().touch.enabled&&!s().ui.open,'flight-button-enables-two-virtual-sticks');
  assert(['left','right'].every(hand=>inside(document.querySelector('.touch-stick-'+hand))), 'both-pads-contained-in-scene');
  pointer('right','pointerdown',71,0,-.59); await wait(600);
  const moving=s();
  assert(Math.abs(moving.flight.horizontalSpeed-6)<.05&&Math.abs(moving.touch.axes.right[1]+.59)<.02,
    'partial-touch-stick-drives-proportional-six-mps',moving.flight);
  const before=moving.camera; await wait(500);
  assert(distance(s().camera,before)>.1,'virtual-stick-moves-actual-camera-not-just-dot');
  pointer('left','pointerdown',72,.59,-.59);await wait(250);
  assert(s().touch.activePointers===2&&s().flight.verticalSpeed>2.9,'independent-two-finger-controls');
  pointer('right','pointerup',71);pointer('left','pointercancel',72);await wait(150);
  const stopped=s().camera;await wait(250);
  assert(s().touch.activePointers===0&&s().flight.horizontalSpeed===0&&s().flight.verticalSpeed===0&&distance(s().camera,stopped)<.05,
    'release-and-cancel-neutralize-and-stop-immediately');
  pointer('right','pointerdown',73,0,-1);await wait(150);
  document.querySelector('[data-mobile-panel=settings]').click();await wait(200);
  assert(!s().touch.enabled&&s().touch.activePointers===0&&s().flight.horizontalSpeed===0,'opening-panel-pauses-input-and-clears-owned-finger');
  document.querySelector('#panel-close').click();await wait(200);
  assert(s().touch.enabled&&s().touch.axes.right.every(x=>x===0),'closing-panel-does-not-revive-old-touch');
  pointer('right','pointerdown',74,0,-1);await wait(100);window.dispatchEvent(new Event('blur'));await wait(150);
  assert(s().touch.activePointers===0&&s().flight.horizontalSpeed===0,'browser-blur-clears-mobile-motion');
  document.querySelector('#mobile-flight').click();await wait(100);
  assert(!s().free&&!s().touch.enabled,'flight-off-hides-pads');
  document.querySelector('#home').click();
  return JSON.stringify({passed:true,environment:'Browser viewport and PointerEvent tests, NOT physical smartphone touch/FPS',results});
})();
