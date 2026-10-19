import * as THREE from "three";

export const hotbarSlot = code => /^Digit[0-9]$/.test(code) ? (Number(code.at(-1)) + 9) % 10 : -1;
const typing = target => target?.matches?.("input,textarea,select,[contenteditable=true]");

// Normalize wheels and trackpads, preserve proportions, and stay within the
// workshop/server transform limits. Ctrl/Meta wheel belongs to browser zoom.
export function placementScaleFactor(event, scale) {
  if (event.ctrlKey || event.metaKey || event.altKey || !Number.isFinite(event.deltaY) ||
    ![0,1,2].includes(event.deltaMode ?? 0) || !Array.isArray(scale) || scale.length!==3 ||
    !scale.every(value=>Number.isFinite(value) && value>0) || event.deltaY===0) return 1;
  const pixels=event.deltaY * ([1,16,800][event.deltaMode ?? 0]);
  const desired=Math.exp(-Math.max(-240,Math.min(240,pixels))*Math.log(1.1)/100);
  const lower=1e-6/Math.min(...scale),upper=100/Math.max(...scale);
  if(lower>upper || (lower>1 && desired<=1) || (upper<1 && desired>=1)) return 1;
  return Math.max(lower,Math.min(upper,desired));
}

export function createHotbar({ workshop, client, camera, canvas, scene, getEnvironment, getObstacles = () => [], isXR, isXRPending = () => false, menu, isLooking = () => false, isCreative = () => true }) {
  const root = document.createElement("div"); root.id = "stl-hotbar"; root.setAttribute("aria-label", "自分のSTL 10枠");
  const hint = document.createElement("div"); hint.id = "hotbar-hint"; hint.setAttribute("role", "status");
  const crosshair = document.createElement("div"); crosshair.id = "placement-crosshair"; crosshair.textContent = "+";
  const menuButton = document.createElement("button"); menuButton.id = "simple-menu"; menuButton.textContent = "メニュー Esc";
  menuButton.onclick = () => { document.exitPointerLock?.(); menu.show("observe"); };
  const loginButton = document.createElement("button"); loginButton.id = "simple-login"; loginButton.textContent = "ログイン";
  loginButton.onclick = () => document.querySelector("#school-button").click();
  canvas.parentElement.append(root, hint, crosshair, menuButton, loginButton);
  const file = document.createElement("input"); file.type = "file"; file.accept = ".stl"; file.multiple = true; file.hidden = true; root.append(file);
  const slots = [], ray = new THREE.Raycaster(), pointer = new THREE.Vector2();
  const footprint = new THREE.Mesh(new THREE.PlaneGeometry(1,1,4,4), new THREE.MeshBasicMaterial({ color: "#32cda5", transparent: true, opacity: .35, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
  footprint.name = "placement-footprint"; footprint.visible = false; scene.add(footprint);
  let active = -1, pending = false, aiming = false, lastPreview = -Infinity, previousIdentity = null;
  let pointerKnown = false, renderSignature = "", queuedWheel = null;
  let retrievalHold = null, rightClick = null, consumeLeftClick = false, placementFailure = null;
  let previewToken = null, previewFootprint = false;
  const actions = document.createElement("dialog"); actions.id = "hotbar-actions";
  actions.setAttribute("aria-label", "設置した作品の操作");
  const actionTitle = document.createElement("strong");
  actions.append(actionTitle); canvas.parentElement.append(actions);
  let actionTarget = null, longPress = null, suppressSlotClick = -1;
  const stopLongPress = () => { if(longPress) clearTimeout(longPress.timer); longPress=null; };
  function closeActions() { stopLongPress(); actionTarget=null; if(actions.open) actions.close(); }
  function openActions(index) {
    if(pending || blocked() || currentState().busy) return;
    const state=currentState(), asset=state.ownAssets[index];
    const item=state.objects.find(o=>o.assetId===asset?.id && o.committed && o.editable);
    if(!state.canEdit || !item) return;
    cancelGestures(); queuedWheel=null; document.exitPointerLock?.();
    actionTarget={id:item.id,index,identity:identityToken()}; actionTitle.textContent=item.name ?? asset.name;
    actions.showModal();
  }
  for(const [action,label] of [["locate","📍 作品のところへ移動"],["retrieve","✋ 回収して手に持つ"],["details","🎨 色・大きさ・回転を変更"]]) {
    const button=document.createElement("button"); button.type="button"; button.dataset.action=action; button.textContent=label;
    button.onclick=async()=>{
      const target=actionTarget; closeActions();
      if(!target || target.identity!==identityToken() || blocked() || pending || currentState().busy) return;
      const item=currentState().objects.find(o=>o.id===target.id && o.committed && o.editable);
      if(!item || !currentState().canEdit) return;
      active=target.index;
      if(!workshop.selectObject(item.id)) return;
      aiming=false; footprint.visible=false;
      if(action==="details") { workshop.open(); render(); return; }
      pending=true;
      try {
        if(action==="locate") await workshop.locateSelected();
        else { aiming=await workshop.retrieveSelected(); lastPreview=-Infinity; }
        report(currentState().message);
      } finally { pending=false; render(); }
    };
    actions.append(button);
  }
  const closeButton=document.createElement("button"); closeButton.type="button"; closeButton.textContent="閉じる"; closeButton.onclick=closeActions; actions.append(closeButton);
  actions.addEventListener("cancel",closeActions);
  actions.addEventListener("click",event=>{ if(event.target!==actions) return; const r=actions.getBoundingClientRect();
    if(event.clientX<r.left || event.clientX>r.right || event.clientY<r.top || event.clientY>r.bottom) closeActions(); });
  const identityToken = () => { const s=currentState(); return `${s.userId}:${s.worldId}:${s.canEdit}`; };
  const cancelGestures = () => { retrievalHold=null; rightClick=null; };
  const currentState = () => workshop.getState();
  const locked = () => document.pointerLockElement === canvas;
  const blocked = () => isXR() || isXRPending() || document.hidden || menu.getState().open || Boolean(document.querySelector("dialog[open]")) || currentState().picking;
  const draftToken = state => `${state.userId}:${state.worldId}:${state.current?.id}`;
  function report(text) { if (hint.textContent !== text) hint.textContent = text; }
  function cast(event) {
    if (!locked()) {
      if (event) {
        const rect = canvas.getBoundingClientRect();
        if (![event.clientX,event.clientY].every(Number.isFinite) || rect.width<=0 || rect.height<=0 ||
          event.clientX<rect.left || event.clientX>rect.left+rect.width || event.clientY<rect.top || event.clientY>rect.top+rect.height) return false;
        pointer.set((event.clientX-rect.left)/rect.width*2-1, -(event.clientY-rect.top)/rect.height*2+1); pointerKnown = true;
      }
      if (!pointerKnown) return false;
    } else pointer.set(0,0);
    camera.updateWorldMatrix(true,false); ray.setFromCamera(pointer,camera); ray.far = 600; return true;
  }
  function groundHit(event) {
    if (!cast(event)) return null;
    const hit = ray.intersectObjects(getEnvironment().terrainMeshes ?? [],false)[0];
    const obstacle = ray.intersectObjects([...getObstacles(), ...workshop.group.children.filter(mesh=>!mesh.userData.isDraft)], false)[0];
    return hit && (!obstacle || obstacle.distance >= hit.distance-.05) ? hit : null;
  }
  function pointerContext() {
    const state = currentState();
    if (!aiming || !state.current || state.current.committed || !state.canEdit) return null;
    const token = draftToken(state);
    if (pending || state.busy || blocked()) return {mode:"blocked",token};
    // Gesture routing depends on the button, not terrain. Do not raycast the
    // entire city on every look event; place() validates the actual hit afresh.
    return {mode:"place",token};
  }
  function ownHit(event) {
    if (!cast(event)) return null;
    const hits = ray.intersectObjects(workshop.group.children.filter(mesh => !mesh.userData.isDraft),false);
    const hit = hits[0];
    if (!hit) return null;
    // Do not retrieve through nearer terrain or another person's object.
    const terrain = ray.intersectObjects(getEnvironment().terrainMeshes ?? [],false)[0];
    if (terrain && terrain.distance < hit.distance - .05) return null;
    const wall = ray.intersectObjects(getObstacles(),false)[0];
    if (wall && wall.distance < hit.distance - .05) return null;
    return currentState().objects.find(item => item.id === hit.object.userData.creationId && item.editable && item.committed) ?? null;
  }
  async function select(index) {
    if (pending || blocked()) return;
    cancelGestures(); placementFailure=null;
    const state = currentState();
    if (!state.canEdit) { loginButton.click(); return; }
    active = index; queuedWheel=null;
    const asset = state.ownAssets[index];
    if (!asset) { document.exitPointerLock?.(); file.click(); render(); return; }
    const placed = state.objects.find(item => item.assetId === asset.id && item.committed);
    if (placed) {
      workshop.cancelDraft(); aiming = false; footprint.visible = false;
      workshop.selectObject(placed.id); document.exitPointerLock?.();
      report("設置済み作品を選択しました · 枠を右クリック（スマホは長押し）で移動・回収・色の変更"); render(); return;
    }
    pending = true;
    try { aiming = await workshop.useAsset(asset.id); lastPreview = -Infinity; if(aiming) document.exitPointerLock?.(); }
    finally { pending = false; render(); }
  }
  for (let index=0; index<10; index++) {
    const button = document.createElement("button"); button.type = "button";
    button.onclick = () => { if(suppressSlotClick===index) { suppressSlotClick=-1; return; } void select(index); }; button.setAttribute("aria-label", `${(index+1)%10} STLを追加`);
    button.setAttribute("aria-haspopup","dialog");
    button.addEventListener("contextmenu",event=>{event.preventDefault(); stopLongPress(); if(!actions.open)openActions(index);});
    button.addEventListener("keydown",event=>{if(event.key==="ContextMenu" || (event.shiftKey && event.key==="F10")) {event.preventDefault();openActions(index);}});
    button.addEventListener("pointerdown",event=>{
      stopLongPress(); suppressSlotClick=-1;
      if(event.pointerType!=="touch" || blocked()) return;
      longPress={id:event.pointerId,x:event.clientX,y:event.clientY,timer:setTimeout(()=>{longPress=null;suppressSlotClick=index;openActions(index);},550)};
    });
    button.addEventListener("pointermove",event=>{if(longPress && Math.hypot(event.clientX-longPress.x,event.clientY-longPress.y)>8)stopLongPress();});
    for(const event of ["pointerup","pointercancel","pointerleave"]) button.addEventListener(event,stopLongPress);
    slots.push(button); root.append(button);
  }
  file.onchange = async () => {
    if (pending || !file.files?.length) return;
    const files = [...file.files]; file.value = ""; pending = true;
    try {
      await workshop.importFiles(files);
      const state = currentState(); active = state.ownAssets.findIndex(asset => asset.id === state.current?.assetId);
      aiming = Boolean(state.current && !state.current.committed); lastPreview = -Infinity;
      if(aiming) document.exitPointerLock?.();
      report(state.message);
    } finally { pending = false; render(); }
  };
  function render() {
    const state = currentState(), user = client.getState().user;
    loginButton.textContent = user ? `${user.namePending ? "名前を決める" : user.name} · ログイン中` : "ログイン";
    const signature = JSON.stringify([active, state.canEdit, state.ownAssets, state.objects.filter(item=>item.committed).map(item=>item.assetId)]);
    if (signature === renderSignature) return; renderSignature = signature;
    slots.forEach((button,index) => {
      const asset = state.ownAssets[index], placed = asset && state.objects.some(item=>item.committed && item.assetId===asset.id);
      button.replaceChildren();
      const key = document.createElement("kbd"); key.textContent = String((index+1)%10);
      const name = document.createElement("span"); name.textContent = asset ? asset.name.replace(/\.stl$/i,"") : "+ STL";
      const badge = document.createElement("small"); badge.textContent = placed ? "右クリック ⋯" : asset ? "置けます" : "追加";
      button.append(key,name,badge); button.classList.toggle("selected", index===active); button.classList.toggle("placed",Boolean(placed));
      button.setAttribute("aria-pressed",String(index===active)); button.title = asset?.name ?? "STLを追加";
      button.setAttribute("aria-label",`${(index+1)%10} ${asset?.name ?? "STLを追加"} ${placed ? "設置済み" : ""}`);
    });
  }
  function preview(event) {
    const state=currentState(), wheel=queuedWheel; queuedWheel=null;
    const scaleFactor=wheel && wheel.token===draftToken(state) && wheel.baseScale===JSON.stringify(state.current?.scale) ? wheel.factor : 1;
    if(aiming && !pending && !state.busy && !blocked() && state.canEdit && isLooking()) {
      // Keep the last ghost while looking; a right-button press must not make
      // the held object appear to vanish. Release revalidates the cursor hit.
      if(canvas.style)canvas.style.cursor="grabbing";
      report("見回し中 · STLは手元に保持しています · 離して置き場所を選び、右クリックで設置");
      return false;
    }
    footprint.visible = false;
    if (canvas.style) canvas.style.cursor = "";
    if (!aiming || pending || state.busy || blocked() || !state.canEdit) return false;
    const hit = isLooking() ? null : groundHit(event ?? wheel?.event);
    const draftMesh = workshop.group.children.find(mesh=>mesh.userData.isDraft);
    if (!hit) {
      if(scaleFactor!==1) { workshop.adjustSelected({scaleFactor}); previewFootprint=false; }
      const retained=previewToken===draftToken(state);
      if (draftMesh) {
        draftMesh.visible=retained;
        if(retained) { draftMesh.material.color.set("#e4ac38"); draftMesh.material.opacity=.35; }
      }
      footprint.visible=retained && previewFootprint;
      footprint.material.color.set("#e4ac38");
      if(canvas.style)canvas.style.cursor="crosshair";
      report(retained ? "黄色は最後のプレビュー（未設置） · 今の位置には置けません · 空いている地面を選んでください" :
        "STLは手元に保持中 · 空いている地面をねらうとプレビューが出ます · 右クリック：設置");
      return false;
    }
    if(canvas.style) canvas.style.cursor="crosshair";
    if (draftMesh) draftMesh.visible = true;
    const result = scaleFactor===1 ? workshop.moveSelected(hit.point.toArray()) :
      workshop.adjustSelected({scaleFactor,position:hit.point.toArray()});
    if (draftMesh) {
      // Full-size translucent ghost is distinct from the solid hand-held copy.
      draftMesh.material.opacity = .22;
      const box = new THREE.Box3().setFromObject(draftMesh), positions = footprint.geometry.attributes.position;
      // Conform the shadow's grid to the real terrain; no fabricated zero floor.
      const down = new THREE.Raycaster(); down.ray.direction.set(0,-1,0); down.far = 2500;
      let complete = true;
      for (let row=0; row<=4; row++) for (let col=0; col<=4; col++) {
        const x=box.min.x+(box.max.x-box.min.x)*col/4, z=box.min.z+(box.max.z-box.min.z)*row/4;
        down.ray.origin.set(x,1500,z);
        const ground = down.intersectObjects(getEnvironment().terrainMeshes ?? [],false)[0];
        if (!ground) complete = false;
        positions.setXYZ(row*5+col,x,(ground?.point.y ?? hit.point.y)+.06,z);
      }
      positions.needsUpdate = true; footprint.geometry.computeBoundingSphere();
      footprint.material.color.set(result.valid ? "#32cda5" : "#f25353"); footprint.visible = complete;
    }
    previewToken=draftToken(state); previewFootprint=footprint.visible;
    const size = draftMesh ? new THREE.Box3().setFromObject(draftMesh).getSize(new THREE.Vector3()) : null;
    const dimensions = size ? `幅${size.x.toFixed(1)} × 高さ${size.y.toFixed(1)} × 奥行${size.z.toFixed(1)}m · ` : "";
    report(placementFailure && placementFailure.token===draftToken(state) && performance.now()<placementFailure.until ? placementFailure.message :
      dimensions + (result.valid ? "右クリック：置く · ホイール：サイズ · 右ドラッグ：見回す · 左長押し / R：回収" : currentState().message));
    return result.valid;
  }
  async function place(event) {
    if (blocked() || !currentState().canEdit || !aiming || pending || !preview(event)) return;
    pending = true;
    placementFailure=null;
    report("配置を保存中… · 確定するまでSTLを保持します");
    try {
      if (await workshop.commitSelected()) { aiming = false; footprint.visible = false; report(currentState().message); }
      else {
        placementFailure={token:draftToken(currentState()),until:performance.now()+5000,message:`STLは手元に保持しています。${currentState().message}`};
        report(placementFailure.message);
      }
    }
    finally { pending = false; render(); }
  }
  canvas.addEventListener("pointermove", event => {
    if (!locked()) cast(event);
    for (const gesture of [retrievalHold,rightClick]) {
      if (!gesture || event.pointerId!==gesture.pointerId) continue;
      gesture.distance += locked() ? Math.hypot(event.movementX??0,event.movementY??0) : 0;
      if ((event.buttons & gesture.buttons)===0 || gesture.distance>5 ||
        Math.hypot(event.clientX-gesture.x,event.clientY-gesture.y)>5) cancelGestures();
    }
  });
  canvas.addEventListener("pointerdown", event => {
    cancelGestures();
    if(event.button===0)consumeLeftClick=false;
    if (blocked() || pending || currentState().busy || event.pointerType !== "mouse" || !currentState().canEdit || isLooking()) return;
    const gesture={pointerId:event.pointerId,x:event.clientX,y:event.clientY,distance:0,identity:identityToken()};
    if (event.button===0) {
      const target=ownHit(event); if(!target) return;
      retrievalHold={...gesture,buttons:1,targetId:target.id,start:performance.now(),checked:-Infinity};
      consumeLeftClick=true;
      report("回収中 0% · 左ボタンを押し続けてください（0.8秒）");
      event.preventDefault?.(); event.stopImmediatePropagation?.();
    } else if(event.button===2 && (!isCreative() || locked()) && pointerContext()?.mode==="place") {
      // Creative cursor gestures are routed by creative-controls. Orbit/locked
      // input uses the same release-only rule here, with a fresh ground check.
      rightClick={...gesture,buttons:2,token:draftToken(currentState())};
      event.preventDefault?.();
    }
  },true);
  window.addEventListener("pointerup",event=>{
    if(event.button===0 && retrievalHold?.pointerId===event.pointerId) retrievalHold=null;
    const gesture=rightClick;
    if(!gesture || event.pointerId!==gesture.pointerId || event.button!==2) return;
    rightClick=null;
    if(!blocked() && gesture.identity===identityToken() && gesture.token===draftToken(currentState()) &&
      Math.hypot(event.clientX-gesture.x,event.clientY-gesture.y)<=5) void place(event);
  });
  canvas.addEventListener("click",event=>{
    if(!consumeLeftClick) return;
    consumeLeftClick=false; event.preventDefault?.(); event.stopImmediatePropagation?.();
  },true);
  canvas.addEventListener("wheel", event => {
    const state=currentState();
    if (blocked() || pending || state.busy || state.picking || !aiming || !state.canEdit ||
      !state.current || state.current.committed || !state.current.editable || isLooking()) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    // Capture before OrbitControls: a held STL changes size, never camera zoom.
    event.preventDefault(); event.stopImmediatePropagation();
    const token=draftToken(state),baseScale=JSON.stringify(state.current.scale);
    const previous=queuedWheel?.token===token && queuedWheel.baseScale===baseScale ? queuedWheel.factor : 1;
    const factor=previous*placementScaleFactor(event,state.current.scale.map(value=>value*previous));
    queuedWheel={token,baseScale,factor,event:{clientX:event.clientX,clientY:event.clientY}};
  }, {passive:false,capture:true});
  const forgetPointer=()=>{cancelGestures();queuedWheel=null;pointerKnown=false;footprint.visible=false;if(canvas.style)canvas.style.cursor="";};
  window.addEventListener("blur",()=>{forgetPointer();closeActions();});
  document.addEventListener("visibilitychange",()=>{if(document.hidden)forgetPointer();});
  canvas.addEventListener("pointercancel",forgetPointer);
  canvas.addEventListener("lostpointercapture",forgetPointer);
  canvas.addEventListener("pointerleave", () => {
    if (!locked()) forgetPointer();
  });
  canvas.addEventListener("contextmenu", event=>event.preventDefault());
  window.addEventListener("keydown",event=>{
    if (typing(event.target) || event.repeat || event.ctrlKey || event.metaKey || event.altKey || blocked()) return;
    if (event.code==="KeyR") { if(isCreative() && currentState().canEdit) { event.preventDefault(); void retrieve(); } return; }
    const index=hotbarSlot(event.code); if (index<0) return;
    event.preventDefault(); void select(index);
  });
  async function retrieve(expectedId) {
    if (pending || blocked() || isLooking() || !currentState().canEdit || currentState().busy) return;
    cancelGestures();
    const target=ownHit();
    if (!target || (expectedId && target.id!==expectedId)) { report("自分が置いた作品をねらって左長押し、またはRを押してください。"); return; }
    pending=true; aiming=false; footprint.visible=false;
    try {
      workshop.selectObject(target.id);
      const ok=await workshop.retrieveSelected();
      if(ok) active=currentState().ownAssets.findIndex(asset=>asset.id===target.assetId);
      aiming=ok; lastPreview=-Infinity;
      report(currentState().message);
    } finally {pending=false;render();}
  }
  function update(time) {
    const xr = isXR();
    root.hidden = hint.hidden = crosshair.hidden = menuButton.hidden = loginButton.hidden = xr;
    // The PC UI is absent in VR. Avoid cloning classroom/geometry snapshots on
    // every headset frame and leave the draft under the VR workshop's control.
    if (xr) { closeActions();cancelGestures();queuedWheel=null; aiming = false; footprint.visible = false; return; }
    const state = currentState(), identity = `${state.userId}:${state.worldId}:${state.canEdit}`;
    if(actionTarget && (identity!==actionTarget.identity || !state.objects.some(o=>o.id===actionTarget.id && o.committed && o.editable) || isXRPending() || document.hidden)) closeActions();
    if (aiming && !pending && (!state.current || state.current.committed)) aiming=false;
    if (identity !== previousIdentity) { cancelGestures();queuedWheel=null; previousIdentity=identity; active=-1; aiming=false; footprint.visible=false; renderSignature=""; }
    // Drafts can also originate in the detailed workshop or survive leaving VR.
    // The hand-held item, not the route used to import it, enables placement.
    if (!aiming && !pending && state.canEdit && !state.busy && workshop.getHeldDraft?.()) {
      aiming=true; active=state.ownAssets.findIndex(asset=>asset.id===state.current?.assetId);
      lastPreview=-Infinity;
    }
    render();
    if (blocked() || !state.canEdit) {
      cancelGestures();
      queuedWheel=null; footprint.visible=false; if(canvas.style && !state.picking)canvas.style.cursor="";
      const mesh=workshop.group.children.find(mesh=>mesh.userData.isDraft); if(mesh && aiming) mesh.visible=false;
      return;
    }
    if(retrievalHold) {
      const hold=retrievalHold,now=performance.now();
      if(pending || state.busy || isLooking() || hold.identity!==identity) cancelGestures();
      else if(now-hold.checked>=80) {
        hold.checked=now;
        if(ownHit()?.id!==hold.targetId) cancelGestures();
        else if(now-hold.start>=800) { retrievalHold=null; void retrieve(hold.targetId); }
        else report(`回収中 ${Math.floor((now-hold.start)/8)}% · 左ボタンを押し続けてください`);
      }
      if(retrievalHold || pending) return;
    }
    if (queuedWheel || time-lastPreview>=120) { lastPreview=time; preview(); }
    if (!aiming && !pending) {
      footprint.visible=false;
      if (state.locatedName) report(`📍 ${state.locatedName} · 黄色い枠が作品の場所です${isCreative() ? " · F5で視点切替" : ""}`);
    }
  }
  report("1〜0：STL選択 · 右クリック：置く · 左長押し：回収 · 右ドラッグ：見回す · ホイール：サイズ · Esc：メニュー");
  return { update, place, pointerContext, getState:()=>({active,aiming,pending,footprintVisible:footprint.visible}) };
}
