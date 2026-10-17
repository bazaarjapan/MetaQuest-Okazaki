// Run through browser CDP after the real form flow, once logged out and once
// logged in with a named, connected local fixture. No auth bypass or setters.
(async () => {
  const state = () => window.__okazaki.getState();
  const before = state(), allowed = before.activityAllowed;
  if (document.querySelector('dialog[open]')) throw new Error('Close the account form first');
  for (const code of (allowed ? ['KeyW'] : ['KeyW','Space','KeyZ','Escape']))
    window.dispatchEvent(new KeyboardEvent('keydown',{code,key:code,bubbles:true}));
  await new Promise(resolve => setTimeout(resolve,450));
  for (const code of ['KeyW','Space','KeyZ','Escape'])
    window.dispatchEvent(new KeyboardEvent('keyup',{code,key:code,bubbles:true}));
  const after = state();
  const distance = Math.hypot(...after.creative.eye.map((value,i)=>value-before.creative.eye[i]));
  const checks = {
    gateVisibility: document.querySelector('#login-gate').hidden === allowed,
    movement: allowed ? distance > .1 : distance === 0,
    keysReleased: after.creative.pressedKeys.length === 0,
    activityStable: after.activityAllowed === allowed,
    surfaces: [...document.querySelectorAll('body > header,body > main,body > nav,body > footer')].every(el=>el.inert === !allowed),
    safety: allowed || (!after.free && !after.xr && !after.avatar.visible),
  };
  if (Object.values(checks).some(value=>!value)) throw new Error(JSON.stringify(checks));
  return JSON.stringify({passed:true,phase:allowed?'authenticated':'locked',checks});
})();
