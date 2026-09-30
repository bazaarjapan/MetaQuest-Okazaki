// Run after moving the captured native pointer outside the pad and releasing.
(async () => {
  const s=()=>window.__okazaki.getState(), results=[],wait=ms=>new Promise(r=>setTimeout(r,ms));
  const assert=(ok,name)=>{results.push({ok:Boolean(ok),name});if(!ok)throw new Error(name);};
  await wait(200);
  assert(s().touch.activePointers===0&&s().touch.axes.right.every(x=>x===0),'release-outside-pad-neutralizes-captured-pointer');
  assert(s().flight.horizontalSpeed===0,'native-pointer-release-stops-motion');
  const before=s().camera;await wait(250);
  assert(Math.hypot(...s().camera.map((v,i)=>v-before[i]))<.05,'camera-stays-still-after-release');
  document.querySelector('#mobile-flight').click();
  return JSON.stringify({passed:true,environment:'Native Chrome mouse with mobile viewport, NOT physical phone',results});
})();
