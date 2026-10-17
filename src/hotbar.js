import * as THREE from "three";

export const hotbarSlot = code => /^Digit[0-9]$/.test(code) ? (Number(code.at(-1)) + 9) % 10 : -1;
const typing = target => target?.matches?.("input,textarea,select,[contenteditable=true]");

// Normalize wheels and trackpads, preserve proportions, and stay within the
// workshop/server transform limits. Ctrl/Meta wheel belongs to browser zoom.
export function placementScaleFactor(event, scale) {
  if (event.ctrlKey || event.metaKey || event.altKey || !Number.isFinite(event.deltaY) ||
    ![0,1,2].includes(event.deltaMode ?? 0) || !Array.isArray(scale) || scale.length!==3 ||
    !scale.every(value=>Number.isFinite(value) && value>=1e-6 && value<=100)) return 1;
  const pixels=event.deltaY * ([1,16,800][event.deltaMode ?? 0]);
  const desired=Math.exp(-Math.max(-240,Math.min(240,pixels))*Math.log(1.1)/100);
  return Math.max(1e-6/Math.min(...scale),Math.min(100/Math.max(...scale),desired));
}

export function createHotbar({ workshop, client, camera, canvas, scene, getEnvironment, getObstacles = () => [], isXR, menu, isLooking = () => false, isCreative = () => true }) {
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
  let pointerKnown = false, renderSignature = "";
  const currentState = () => workshop.getState();
  const locked = () => document.pointerLockElement === canvas;
  const blocked = () => isXR() || document.hidden || menu.getState().open || Boolean(document.querySelector("dialog[open]"));
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
    const token = `${state.userId}:${state.worldId}:${state.current.id}`;
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
    const state = currentState();
    if (!state.canEdit) { loginButton.click(); return; }
    active = index;
    const asset = state.ownAssets[index];
    if (!asset) { document.exitPointerLock?.(); file.click(); render(); return; }
    const placed = state.objects.find(item => item.assetId === asset.id && item.committed);
    if (placed) {
      workshop.cancelDraft(); aiming = false; footprint.visible = false;
      report("設置済みです。自分の作品をねらってRを押すと回収できます。"); render(); return;
    }
    pending = true;
    try { aiming = await workshop.useAsset(asset.id); lastPreview = -Infinity; if(aiming) document.exitPointerLock?.(); }
    finally { pending = false; render(); }
  }
  for (let index=0; index<10; index++) {
    const button = document.createElement("button"); button.type = "button";
    button.onclick = () => void select(index); button.setAttribute("aria-label", `${(index+1)%10} STLを追加`);
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
      const badge = document.createElement("small"); badge.textContent = placed ? "設置済" : asset ? "置けます" : "追加";
      button.append(key,name,badge); button.classList.toggle("selected", index===active); button.classList.toggle("placed",Boolean(placed));
      button.setAttribute("aria-pressed",String(index===active)); button.title = asset?.name ?? "STLを追加";
      button.setAttribute("aria-label",`${(index+1)%10} ${asset?.name ?? "STLを追加"} ${placed ? "設置済み" : ""}`);
    });
  }
  function preview(event) {
    footprint.visible = false;
    if (canvas.style) canvas.style.cursor = "";
    if (!aiming || pending || blocked() || !currentState().canEdit) return false;
    const hit = isLooking() ? null : groundHit(event);
    const draftMesh = workshop.group.children.find(mesh=>mesh.userData.isDraft);
    if (!hit) { if (draftMesh) draftMesh.visible = false; if(canvas.style)canvas.style.cursor=isLooking()?"grabbing":"crosshair"; report("右ドラッグ：見回す · ホイール：サイズ · 地面をねらって左クリック：設置"); return false; }
    if(canvas.style) canvas.style.cursor="crosshair";
    if (draftMesh) draftMesh.visible = true;
    const result = workshop.moveSelected(hit.point.toArray());
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
    const size = draftMesh ? new THREE.Box3().setFromObject(draftMesh).getSize(new THREE.Vector3()) : null;
    const dimensions = size ? `幅${size.x.toFixed(1)} × 高さ${size.y.toFixed(1)} × 奥行${size.z.toFixed(1)}m · ` : "";
    report(dimensions + (result.valid ? "左クリック：置く · ホイール：サイズ · 右ドラッグ：見回す · R：回収" : currentState().message));
    return result.valid;
  }
  async function place(event) {
    if (blocked() || !currentState().canEdit || !aiming || pending || !preview(event)) return;
    pending = true;
    try { if (await workshop.commitSelected()) { aiming = false; footprint.visible = false; } report(currentState().message); }
    finally { pending = false; render(); }
  }
  canvas.addEventListener("pointermove", event => { if (!locked()) cast(event); });
  canvas.addEventListener("pointerdown", event => {
    if (blocked() || pending || event.pointerType === "touch" || !currentState().canEdit) return;
    // A click closing an open menu is blocked above. If pointer lock is denied,
    // ordinary cursor aiming/placement remains available instead of a dead end.
    if (event.button===0 && !isLooking()) void place(event);
  });
  canvas.addEventListener("wheel", event => {
    const state=currentState();
    if (blocked() || pending || state.busy || state.picking || !aiming || !state.canEdit ||
      !state.current || state.current.committed || !state.current.editable || isLooking()) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    // Capture before OrbitControls: a held STL changes size, never camera zoom.
    event.preventDefault(); event.stopImmediatePropagation();
    const scaleFactor=placementScaleFactor(event,state.current.scale);
    if (scaleFactor!==1) workshop.adjustSelected({scaleFactor});
    lastPreview=-Infinity; preview(event);
  }, {passive:false,capture:true});
  const forgetPointer=()=>{pointerKnown=false;footprint.visible=false;if(canvas.style)canvas.style.cursor="";};
  window.addEventListener("blur",forgetPointer);
  canvas.addEventListener("pointercancel",forgetPointer);
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
  async function retrieve() {
    if (pending || blocked() || isLooking() || !currentState().canEdit || currentState().busy) return;
    const target=ownHit();
    if (!target) { report("自分が置いた作品をねらってRを押してください。"); return; }
    pending=true; aiming=false; footprint.visible=false;
    try {
      workshop.selectObject(target.id);
      const ok=await workshop.removeSelected();
      if(ok) active=currentState().ownAssets.findIndex(asset=>asset.id===target.assetId);
      report(ok ? "ホットバーに戻しました。同じ枠を選ぶと置き直せます。" : currentState().message);
    } finally {pending=false;render();}
  }
  function update(time) {
    const xr = isXR();
    root.hidden = hint.hidden = crosshair.hidden = menuButton.hidden = loginButton.hidden = xr;
    // The PC UI is absent in VR. Avoid cloning classroom/geometry snapshots on
    // every headset frame and leave the draft under the VR workshop's control.
    if (xr) { aiming = false; footprint.visible = false; return; }
    const state = currentState(), identity = `${state.userId}:${state.worldId}:${state.canEdit}`;
    if (aiming && !pending && (!state.current || state.current.committed)) aiming=false;
    if (identity !== previousIdentity) { previousIdentity=identity; active=-1; aiming=false; footprint.visible=false; renderSignature=""; }
    render();
    if (blocked() || !state.canEdit) {
      footprint.visible=false; if(canvas.style)canvas.style.cursor="";
      const mesh=workshop.group.children.find(mesh=>mesh.userData.isDraft); if(mesh && aiming) mesh.visible=false;
      return;
    }
    if (time-lastPreview>=120) { lastPreview=time; preview(); }
    if (!aiming && !pending) footprint.visible=false;
  }
  report("1〜0：STL選択 · 左クリック：置く · 右ドラッグ：見回す · ホイール：サイズ · R：回収 · Esc：メニュー");
  return { update, place, pointerContext, getState:()=>({active,aiming,pending,footprintVisible:footprint.visible}) };
}
