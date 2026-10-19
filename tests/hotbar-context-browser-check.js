// Isolated local classroom, after workshop-color-browser-check.js.
(async()=>{
  const results=[],s=()=>window.__okazaki.getState();
  const check=(ok,name)=>{results.push({ok:!!ok,name});if(!ok)throw Error(name);};
  const until=async(fn,name)=>{const end=performance.now()+10000;while(!fn()&&performance.now()<end)await new Promise(r=>setTimeout(r,60));check(fn(),name);};
  const slot=document.querySelector('#stl-hotbar button'),menu=document.querySelector('#hotbar-actions');
  const open=()=>slot.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));
  open();check(menu.open,'context-menu-opens');
  menu.dispatchEvent(new MouseEvent('click',{clientX:0,clientY:0,bubbles:true}));check(!menu.open,'outside-click-closes');
  slot.dispatchEvent(new PointerEvent('pointerdown',{pointerType:'touch',pointerId:88,clientX:100,clientY:650,bubbles:true}));
  await until(()=>menu.open,'touch-long-press-opens');
  slot.dispatchEvent(new PointerEvent('pointerup',{pointerType:'touch',pointerId:88,bubbles:true}));slot.click();
  check(menu.open&&!document.querySelector('#workshop-dialog').open,'synthetic-click-does-not-open-details');
  menu.querySelector('[data-action="details"]').click();
  const rotation=document.querySelector('#object-ry');rotation.value='25';rotation.dispatchEvent(new Event('change',{bubbles:true}));
  check(s().workshop.current.valid,'rotated-draft-valid');document.querySelector('#object-apply').click();
  await until(()=>!s().workshop.busy&&s().workshop.current.committed,'rotation-saved');
  document.querySelector('#workshop-close').click();
  const before=s().workshop.current;open();menu.querySelector('[data-action="retrieve"]').click();
  await until(()=>!s().hotbar.pending&&!s().workshop.busy&&!s().workshop.current?.committed,'recall-server-acknowledged');
  const held=s().workshop.current;
  check(s().workshop.committed===0&&s().school.objects.length===0,'recall-removes-server-placement');
  check(s().heldSTL.visible&&s().hotbar.aiming,'recalled-object-in-hand');
  for(const key of ['color','scale','rotation'])check(JSON.stringify(held[key])===JSON.stringify(before[key]),`recall-preserves-${key}`);
  // Use real transform form to re-place on the original verified ground.
  document.querySelector('#open-workshop').click();
  for(const [id,value] of [['object-x',before.position[0]],['object-z',before.position[2]]]) {
    const field=document.querySelector('#'+id);field.value=value;field.dispatchEvent(new Event('change',{bubbles:true}));
  }
  check(s().workshop.current.valid,'recalled-draft-can-be-placed');document.querySelector('#object-apply').click();
  await until(()=>!s().workshop.busy&&s().workshop.current.committed,'replaced-server-acknowledged');
  for(const key of ['color','scale','rotation'])check(JSON.stringify(s().school.objects[0][key])===JSON.stringify(before[key]),`server-retains-${key}`);
  document.querySelector('#workshop-close').click();
  return {passed:true,results};
})();
