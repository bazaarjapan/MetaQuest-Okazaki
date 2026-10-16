import * as THREE from "three";

export const hotbarSlot = code => /^Digit[0-9]$/.test(code) ? (Number(code.at(-1)) + 9) % 10 : -1;
export const retrievalHoldMs = 700;
const typing = target => target?.matches?.("input,textarea,select,[contenteditable=true]");

export function createHotbar({ workshop, client, camera, canvas, scene, getEnvironment, getObstacles = () => [], isXR, menu }) {
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
  let active = -1, pending = false, aiming = false, hold = null, lastPreview = -Infinity, previousIdentity = null;
  let pointerKnown = false, previousLock = false, renderSignature = "";
  const currentState = () => workshop.getState();
  const locked = () => document.pointerLockElement === canvas;
  const blocked = () => isXR() || document.hidden || menu.getState().open || Boolean(document.querySelector("dialog[open]"));
  function report(text) { if (hint.textContent !== text) hint.textContent = text; }
  function cast(event) {
    if (!locked()) {
      if (event) { const rect = canvas.getBoundingClientRect(); pointer.set((event.clientX-rect.left)/rect.width*2-1, -(event.clientY-rect.top)/rect.height*2+1); pointerKnown = true; }
      if (!pointerKnown) return false;
    } else pointer.set(0,0);
    camera.updateWorldMatrix(true,false); ray.setFromCamera(pointer,camera); ray.far = 600; return true;
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
    active = index; hold = null;
    const asset = state.ownAssets[index];
    if (!asset) { document.exitPointerLock?.(); file.click(); render(); return; }
    const placed = state.objects.find(item => item.assetId === asset.id && item.committed);
    if (placed) {
      workshop.cancelDraft(); aiming = false; footprint.visible = false;
      report("設置済みです。作品をねらって右クリックを長押しすると回収できます。"); render(); return;
    }
    pending = true;
    try { aiming = await workshop.useAsset(asset.id); lastPreview = -Infinity; }
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
    if (!aiming || pending || blocked() || !currentState().canEdit || !cast(event)) return false;
    const hit = ray.intersectObjects(getEnvironment().terrainMeshes ?? [],false)[0];
    const obstacle = ray.intersectObjects([...getObstacles(), ...workshop.group.children.filter(mesh=>!mesh.userData.isDraft)], false)[0];
    const draftMesh = workshop.group.children.find(mesh=>mesh.userData.isDraft);
    if (!hit || (obstacle && obstacle.distance < hit.distance - .05)) { if (draftMesh) draftMesh.visible = false; report("建物のない駅周辺の地面をねらってください（建物の奥や空には置けません）。"); return false; }
    if (draftMesh) draftMesh.visible = true;
    const result = workshop.moveSelected(hit.point.toArray());
    if (draftMesh) {
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
    report(result.valid ? "左クリック：ここに置く · 右長押し：回収 · 1〜0：選択 · Esc：メニュー" : currentState().message);
    return result.valid;
  }
  async function place(event) {
    if (!aiming || pending || !preview(event)) return;
    pending = true; hold = null;
    try { if (await workshop.commitSelected()) { aiming = false; footprint.visible = false; } report(currentState().message); }
    finally { pending = false; render(); }
  }
  canvas.addEventListener("pointermove", event => { if (!locked()) cast(event); });
  canvas.addEventListener("pointerdown", event => {
    if (blocked() || pending || event.pointerType === "touch" || !currentState().canEdit) return;
    // A click closing an open menu is blocked above. If pointer lock is denied,
    // ordinary cursor aiming/placement remains available instead of a dead end.
    if (event.button===0) void place(event);
    if (event.button===2) { event.preventDefault(); const item=ownHit(event); hold=item ? { id:item.id, assetId:item.assetId, started:performance.now() } : null; }
  });
  const cancelHold = () => { if (hold) report("回収を取り消しました。回収するときは自分の作品を狙って押し続けます。"); hold=null; };
  window.addEventListener("pointerup",cancelHold); window.addEventListener("blur",cancelHold);
  canvas.addEventListener("pointercancel", cancelHold);
  canvas.addEventListener("pointerleave", () => {
    if (!locked()) { pointerKnown = false; footprint.visible = false; cancelHold(); }
  });
  canvas.addEventListener("contextmenu", event=>event.preventDefault());
  window.addEventListener("keydown",event=>{
    if (typing(event.target) || event.repeat || event.ctrlKey || event.metaKey || event.altKey || blocked()) return;
    const index=hotbarSlot(event.code); if (index<0) return;
    event.preventDefault(); void select(index);
  });
  function update(time) {
    const xr = isXR();
    root.hidden = hint.hidden = crosshair.hidden = menuButton.hidden = loginButton.hidden = xr;
    // The PC UI is absent in VR. Avoid cloning classroom/geometry snapshots on
    // every headset frame and leave the draft under the VR workshop's control.
    if (xr) { aiming = false; hold = null; footprint.visible = false; return; }
    const state = currentState(), identity = `${state.userId}:${state.worldId}:${state.canEdit}`;
    if (aiming && !pending && (!state.current || state.current.committed)) aiming=false;
    if (identity !== previousIdentity) { previousIdentity=identity; active=-1; aiming=false; hold=null; footprint.visible=false; renderSignature=""; }
    render();
    if (blocked() || !state.canEdit) {
      footprint.visible=false; hold=null;
      const mesh=workshop.group.children.find(mesh=>mesh.userData.isDraft); if(mesh && aiming) mesh.visible=false;
      return;
    }
    if (previousLock && !locked()) hold=null; previousLock=locked();
    if (hold && !pending) {
      const item=ownHit();
      if (item?.id!==hold.id) hold=null;
      else {
        const progress=Math.min(1,(performance.now()-hold.started)/retrievalHoldMs);
        report(`回収中 ${Math.round(progress*100)}%（右クリックを押したまま）`);
        if (progress===1) {
          const target=hold; hold=null; pending=true; aiming=false; footprint.visible=false;
          workshop.selectObject(target.id);
          void workshop.removeSelected().then(ok=>{
            if(ok) active=currentState().ownAssets.findIndex(asset=>asset.id===target.assetId);
            report(ok ? "ホットバーに戻しました。同じ枠を選ぶと置き直せます。" : currentState().message);
          }).finally(()=>{pending=false;render();});
        }
      }
    } else if (time-lastPreview>=120) { lastPreview=time; preview(); }
    if (!aiming && !pending && !hold) footprint.visible=false;
  }
  report("1〜0 / 枠をクリック：STLを選択 · 左クリック：置く · 右長押し：回収 · Esc：メニュー");
  return { update, getState:()=>({active,aiming,pending,footprintVisible:footprint.visible,hold:hold?.id??null}) };
}
