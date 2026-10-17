// Run in the isolated local classroom after uploading the generated cube via
// the real hotbar file chooser. Uses DOM input only, never application setters.
(async () => {
  const results=[],state=()=>window.__okazaki.getState(),canvas=document.querySelector('#viewport > canvas');
  const wait=ms=>new Promise(r=>setTimeout(r,ms));
  const check=(ok,name)=>{results.push({ok:!!ok,name});if(!ok)throw Error(name);};
  const point=(type,x,y,button=0,buttons=0)=>canvas.dispatchEvent(new PointerEvent(type,{pointerType:'mouse',pointerId:61,clientX:x,clientY:y,button,buttons,bubbles:true,cancelable:true}));
  const up=(x,y,button)=>window.dispatchEvent(new PointerEvent('pointerup',{pointerId:61,clientX:x,clientY:y,button,bubbles:true}));
  const key=code=>window.dispatchEvent(new KeyboardEvent('keydown',{code,bubbles:true,cancelable:true}));
  const until=async(fn,name)=>{const end=performance.now()+10000;while(!fn()&&performance.now()<end)await wait(60);check(fn(),name);};
  check(state().workshop.canEdit&&state().hotbar.aiming,'authenticated-owned-draft');
  const rect=canvas.getBoundingClientRect(),x=rect.left+rect.width/2,y=rect.top+rect.height/2;
  const heading=state().creative.yaw,initialCount=state().workshop.committed;
  point('pointerdown',x,y,2,2);point('pointermove',x+40,y+240,2,2);up(x+40,y+240,2);
  check(state().creative.yaw<heading&&state().creative.pitch<-.4,'right-drag-looks-with-held-STL');
  check(!state().creative.pointerLocked&&state().workshop.committed===initialCount,'right-drag-never-places-or-locks');
  const original=state().workshop.current.scale[0],eye=JSON.stringify(state().creative.eye);
  const wheel=(deltaY,extra={})=>canvas.dispatchEvent(new WheelEvent('wheel',{clientX:x,clientY:y,deltaY,deltaMode:0,bubbles:true,cancelable:true,...extra}));
  wheel(-100);check(Math.abs(state().workshop.current.scale[0]/original-1.1)<1e-9,'wheel-up-enlarges-ten-percent');
  wheel(100);check(Math.abs(state().workshop.current.scale[0]/original-1)<1e-9,'wheel-down-reverses');
  check(JSON.stringify(state().creative.eye)===eye,'wheel-does-not-zoom-camera');
  wheel(-100,{ctrlKey:true});check(Math.abs(state().workshop.current.scale[0]/original-1)<1e-9,'Ctrl-wheel-preserved');
  // Scale down to make a small test model fit in genuine empty spaces.
  for(let i=0;i<8;i++)wheel(240);
  let target=null;
  for(const fy of [.55,.7,.85,.4]) {
    for(const fx of [.5,.4,.6,.3,.7,.2,.8]) {
      const px=rect.left+rect.width*fx,py=rect.top+rect.height*fy;
      point('pointermove',px,py);await wait(150);
      if(state().hotbar.footprintVisible&&state().workshop.current.valid){target=[px,py];break;}
    }
    if(target)break;
  }
  check(target,'valid-real-terrain-preview');
  window.__placementMouseTarget=target;
  const scale=[...state().workshop.current.scale];
  check(document.querySelector('#hotbar-hint').textContent.includes('幅'),'actual-dimensions-visible');
  point('pointerdown',...target,0,1);up(...target,0);
  await until(()=>state().workshop.committed===initialCount+1,'server-acknowledged-placement');
  check(state().workshop.objects.some(o=>o.committed&&JSON.stringify(o.scale)===JSON.stringify(scale)),'placed-scale-preserved');
  wheel(-100);check(state().workshop.objects.some(o=>o.committed&&JSON.stringify(o.scale)===JSON.stringify(scale)),'committed-STL-not-resized');
  point('pointermove',...target);key('KeyR');
  await until(()=>state().workshop.committed===initialCount,'R-retrieval-server-acknowledged');
  check(state().workshop.ownAssets.length>0,'retrieval-preserves-cloud-asset');
  check(!state().workshop.busy,'no-pending-operation');
  return {passed:true,results,scale,target};
})();
