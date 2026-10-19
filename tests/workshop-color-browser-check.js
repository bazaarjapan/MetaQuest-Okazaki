// Isolated real workerd classroom; first upload/commit the generated cube using UI.
// Only DOM controls are mutated. __okazaki is read-only observation.
(async () => {
  const results=[], state=()=>window.__okazaki.getState();
  const check=(ok,name)=>{results.push({ok:!!ok,name});if(!ok)throw Error(name);};
  const until=async(fn,name)=>{const end=performance.now()+10000;while(!fn()&&performance.now()<end)await new Promise(r=>setTimeout(r,60));check(fn(),name);};
  const work=state().workshop.objects.find(item=>item.committed&&item.editable);
  check(work,"owned-committed-STL");
  const index=state().workshop.ownAssets.findIndex(asset=>asset.id===work.assetId);
  const slot=document.querySelectorAll('#stl-hotbar button')[index];
  check(slot.textContent.includes('右クリック'),'placed-slot-context-label');slot.click();
  check(!document.querySelector('#workshop-dialog').open,'left-click-selects-only');
  slot.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));
  check(document.querySelector('#hotbar-actions').open,'right-click-opens-actions');
  document.querySelector('#hotbar-actions [data-action="details"]').click();
  check(document.querySelector('#workshop-dialog').open,'context-opens-details');
  check(state().workshop.selected===work.id,'slot-selects-correct-work');
  check(document.querySelector('#object-location').textContent.includes('水平距離'),'station-direction-and-distance');
  document.querySelector('#object-color').value='#e85f32';document.querySelector('#object-paint').click();
  await until(()=>!state().workshop.busy&&state().workshop.current?.color==='#e85f32','paint-server-acknowledged');
  check(JSON.stringify(state().school.objects.find(item=>item.id===work.id).position)===JSON.stringify(work.position),'painting-preserves-authoritative-position');
  const before=state().creative.eye;
  document.querySelector('#object-locate').click();
  await until(()=>!document.querySelector('#workshop-dialog').open,'locate-closes-dialog');
  const next=state();
  check(JSON.stringify(before)!==JSON.stringify(next.creative.eye),'locate-moves-viewer');
  check(next.creative.viewMode==='first'&&!next.free,'locate-first-person-stops-movement');
  check(Math.hypot(next.creative.eye[0]-work.position[0],next.creative.eye[2]-work.position[2])>2,'viewer-beside-selected-work');
  check(Math.hypot(next.creative.eye[0]-work.position[0],next.creative.eye[2]-work.position[2])<6,'orbit-minimum-does-not-shift-landing');
  check(Math.abs(next.creative.anchor[1]-work.position[1])<1,'viewer-feet-near-ground-not-overhead');
  check(JSON.stringify(next.workshop.current.position)===JSON.stringify(work.position),'navigation-never-moves-work');
  check(next.workshop.locatedName===work.name,'location-marker-target');
  return {passed:true,results,expected:{id:work.id,position:work.position,color:'#e85f32'}};
})();
