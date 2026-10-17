(async () => {
  const state = () => window.__okazaki.getState(), results = [];
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const check = (ok, name) => { results.push({ ok: Boolean(ok), name }); if (!ok) throw Error(name); };
  const distance = (a,b) => Math.hypot(...a.map((v,i) => v-b[i]));
  const key = (code,type='keydown') => window.dispatchEvent(new KeyboardEvent(type,{code,bubbles:true,cancelable:true}));
  check(state().ready && state().ui.mobile, 'compact-creative-layout-ready');
  check(state().creative.mode === 'creative' && state().creative.viewMode === 'back' && state().avatar.visible,
    'fresh-mobile-rear-view-with-local-avatar');
  const canvas = document.querySelector('#viewport > canvas');
  const point = (type,id,x,y) => canvas.dispatchEvent(new PointerEvent(type,{pointerType:'touch',pointerId:id,clientX:x,clientY:y,bubbles:true,cancelable:true}));
  const idleEye = state().creative.eye, idleYaw = state().creative.yaw;
  point('pointerdown',71,100,100); point('pointermove',71,140,110); await wait(50);
  check(Math.abs(state().creative.yaw-idleYaw)>.1 && distance(idleEye,state().creative.eye)<1e-6,'idle-one-finger-camera-rotation-keeps-player');
  const beforePinch = state().creative.cameraDistance;
  point('pointerdown',72,240,110); point('pointermove',72,340,110); await wait(50);
  check(state().creative.cameraDistance < beforePinch && distance(idleEye,state().creative.eye)<1e-6,'idle-two-finger-zoom-keeps-player');
  point('pointerup',71,140,110); point('pointerup',72,340,110);
  document.querySelector('#mobile-avatar-view').click(); await wait(100);
  if (!state().free) document.querySelector('#mobile-flight').click(); await wait(100);
  document.querySelector('#viewport > canvas').focus();
  check(state().creative.mode === 'creative' && state().touch.enabled && state().touch.activePointers === 0,
    'compact-creative-has-idle-touch-sticks');
  const before = state().creative.eye; key('KeyW'); await wait(600); key('KeyW','keyup'); await wait(100);
  check(distance(before,state().creative.eye) > .1, 'idle-touch-sticks-do-not-suppress-physical-keyboard');
  const stopped = state().creative.eye; await wait(150);
  check(distance(stopped,state().creative.eye) < 1e-6, 'compact-key-release-stops-movement');
  document.querySelector('#mobile-flight').click(); await wait(100);
  return JSON.stringify({passed:true,environment:'compact browser keyboard events, not physical mobile',results});
})();
