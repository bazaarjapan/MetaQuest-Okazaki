// Run after native browser mouse-down on the right pad in a mobile viewport.
(async () => {
  const state=window.__okazaki.getState(), results=[];
  const assert=(ok,name)=>{results.push({ok:Boolean(ok),name});if(!ok)throw new Error(name);};
  assert(state.touch.enabled&&state.touch.activePointers===1,'native-pointer-owns-one-virtual-pad');
  const id=state.touch.pointers.right;
  assert(id!==null&&document.querySelector('.touch-stick-right').hasPointerCapture(id),
    'real-browser-pointer-capture-succeeds');
  assert(state.flight.horizontalSpeed>4&&state.flight.horizontalSpeed<6,'native-pointer-drives-partial-speed');
  assert(Math.hypot(...state.camera.map((v,i)=>v-[195,76,105][i]))>.1,'native-pointer-moves-camera');
  return JSON.stringify({passed:true,environment:'Native Chrome mouse with mobile viewport, NOT physical phone',results});
})();
