export const vrWorkshopLayout = Object.freeze({ position: Object.freeze([-0.79, 0.02, -1.8]),
  size: Object.freeze([1.02, 0.55]), canvas: Object.freeze([1024, 552]), maxRefreshHz: 10 });

const rotationStep = Math.PI / 12;
const buttonDefinitions = Object.freeze([
  { action: "asset-prev", label: "◀", x: 24, y: 98, w: 110, h: 62, needs: "asset" },
  { action: "asset-next", label: "▶", x: 890, y: 98, w: 110, h: 62, needs: "asset" },
  ...["x", "y", "z"].flatMap((axis, i) => [
    { action: `rotate-${axis}-`, label: "−15°", x: 24 + i * 328, y: 226, w: 146, h: 58, needs: "selection" },
    { action: `rotate-${axis}+`, label: "+15°", x: 184 + i * 328, y: 226, w: 146, h: 58, needs: "selection" }]),
  { action: "scale-", label: "縮小 ×0.9", x: 24, y: 304, w: 248, h: 62, needs: "selection" },
  { action: "scale+", label: "拡大 ×1.1", x: 288, y: 304, w: 248, h: 62, needs: "selection" },
  { action: "pick", label: "地面を指して配置", x: 552, y: 304, w: 448, h: 62, needs: "selection" },
  { action: "commit", label: "配置を確定・共有", x: 24, y: 386, w: 480, h: 70, needs: "valid" },
  { action: "cancel", label: "下書きを取消", x: 520, y: 386, w: 480, h: 70, needs: "selection" },
]);

export function schoolEditingAllowed(state, workshopState) {
  return Boolean(state?.user?.id && ["teacher", "student"].includes(state.user.role) &&
    state.world?.id && state.connection === "connected" && workshopState?.canEdit);
}

function safeCaption(value, maximum = 60) {
  return [...String(value ?? "").replace(/[\u0000-\u001f\u007f]/gu, " ")].slice(0, maximum).join("");
}

// All entry points, including direct calls from XR input, recheck current signed
// identity + room membership. A disabled button is not an authorization boundary.
export function createVRWorkshopControl({ workshop, client, onShadowChange = () => {} }) {
  let picking = false, pending = false, disposed = false, message = "";
  function snapshot() {
    const clientState = client.getState(), workshopState = workshop.getState();
    const allowed = !disposed && schoolEditingAllowed(clientState, workshopState);
    if (!allowed) picking = false;
    const current = workshopState.current ?? workshopState.objects?.find((item) => item.id === workshopState.selected) ?? null;
    const selected = Boolean(current && current.ownerId === clientState?.user?.id && current.editable !== false);
    return { clientState, workshopState, current, allowed, selected,
      ready: allowed && !pending && !workshopState.busy,
      picking, pending, disposed, message };
  }
  function enabled(action, state = snapshot()) {
    if (!state.ready) return false;
    if (action === "asset-prev" || action === "asset-next") return Boolean(state.workshopState.ownAssets?.length);
    if (action === "commit") return state.selected && Boolean(state.current.valid) && !state.current.committed;
    if (action === "picked") return state.selected && picking;
    return buttonDefinitions.some((button) => button.action === action) && state.selected;
  }
  async function activate(action) {
    const state = snapshot();
    if (!enabled(action, state)) return false;
    message = "";
    if (action === "pick") { picking = !picking; return true; }
    if (action === "picked") { picking = false; return true; }
    pending = true;
    // Any subsequent async completion must still belong to the same room/user.
    const identity = `${state.clientState.user.id}:${state.clientState.world.id}`;
    try {
      let result;
      if (action === "asset-prev" || action === "asset-next") {
        result = await workshop.cycleOwnAsset(action === "asset-prev" ? -1 : 1); picking = false;
      } else if (action.startsWith("rotate-")) {
        result = await workshop.adjustSelected({ axis: action[7],
          radians: rotationStep * (action.endsWith("+") ? 1 : -1) });
      } else if (action.startsWith("scale")) {
        result = await workshop.adjustSelected({ scaleFactor: action === "scale+" ? 1.1 : 0.9 });
      } else if (action === "commit") {
        result = await workshop.commitSelected(); picking = false;
      } else if (action === "cancel") {
        result = await workshop.cancelDraft(); picking = false;
      }
      const next = snapshot();
      if (disposed || !next.allowed || `${next.clientState.user.id}:${next.clientState.world.id}` !== identity) return false;
      onShadowChange();
      return result !== false;
    } catch {
      // Error details can contain internal URLs; the workshop's own bounded
      // human-readable state provides placement failures and retry directions.
      message = "操作できませんでした。接続・配置位置を確認してください。";
      return false;
    } finally { pending = false; }
  }
  return { snapshot, enabled, activate,
    cancelPicking: () => { picking = false; },
    dispose: () => { disposed = true; picking = false; },
  };
}

// Embedded mode shares the field-note canvas and creates no spatial plane.
// Every action still passes through the same signed-room/owner permission gate.
export function createVRWorkshop(THREE, { camera, workshop, client, onShadowChange = () => {},
  documentTarget = globalThis.document, embedded = false } = {}) {
  const canvas = documentTarget.createElement("canvas");
  [canvas.width, canvas.height] = vrWorkshopLayout.canvas;
  const texture = embedded ? null : new THREE.CanvasTexture(canvas);
  let material = null, geometry = null, panel = null;
  const group = new THREE.Group(); group.name = "vr-school-workshop-hud";
  if (!embedded) {
    texture.colorSpace = THREE.SRGBColorSpace; texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    material = new THREE.MeshBasicMaterial({ map: texture, transparent: true,
      depthTest: false, depthWrite: false, toneMapped: false });
    geometry = new THREE.PlaneGeometry(...vrWorkshopLayout.size);
    panel = new THREE.Mesh(geometry, material); panel.name = "vr-school-workshop";
    panel.position.set(...vrWorkshopLayout.position); panel.renderOrder = 1000;
    group.add(panel); camera.add(group);
  }
  group.visible = false;
  const control = createVRWorkshopControl({ workshop, client, onShadowChange });
  let hover = null, lastKey = null, lastDraw = -Infinity, redraws = 0, disposed = false;

  function keyFor(state) {
    return JSON.stringify({ user: state.clientState?.user?.id, room: state.clientState?.world?.id,
      connected: state.clientState?.connection, allowed: state.allowed, current: state.current,
      assets: state.workshopState.ownAssets?.length, busy: state.workshopState.busy,
      pending: state.pending, picking: state.picking,
      message: safeCaption(state.message || state.workshopState.message), hover });
  }
  function draw(state, time, force = false) {
    const key = keyFor(state);
    if (!force && (key === lastKey || time - lastDraw < 1 / vrWorkshopLayout.maxRefreshHz)) return;
    const c = canvas.getContext("2d"); if (!c) return;
    lastKey = key; lastDraw = time; redraws++;
    c.clearRect(0, 0, canvas.width, canvas.height);
    c.fillStyle = "rgba(8,20,35,.94)";
    c.beginPath(); c.roundRect(2, 2, 1020, 548, 24); c.fill();
    c.strokeStyle = state.allowed ? "#6fd9c3" : "#54748a"; c.lineWidth = 3; c.stroke();
    c.textAlign = "left"; c.fillStyle = "#ffffff"; c.font = "bold 32px sans-serif";
    c.fillText(state.allowed ? "自分の作品を配置" : "見学中", 24, 44, 970);
    c.font = "23px sans-serif"; c.fillStyle = "#bdd5e3";
    const status = state.allowed ?
      state.pending || state.workshopState.busy ? "通信・確認中…" :
        state.picking ? "右トリガーで地面を選択 → 確定" : "右トリガーでボタンを選択" :
      !state.clientState?.user ? "作品配置は2D画面でログイン・教室参加" :
        state.clientState?.connection !== "connected" && state.clientState?.world ? "再接続待ち・作品の編集は停止しています" :
          "2D画面で先生の参加コードを入力してください";
    c.fillText(status, 24, 78, 970);
    if (state.allowed) {
      c.textAlign = "center"; c.font = "bold 27px sans-serif"; c.fillStyle = "white";
      c.fillText(safeCaption(state.current?.name || "2D画面でSTLをインポート", 40), 512, 135, 710);
      for (const [i, axis] of ["X", "Y", "Z"].entries()) {
        c.font = "23px sans-serif"; c.fillStyle = "#bdd5e3";
        const angle = Number(state.current?.rotation?.[i]);
        c.fillText(`${axis} 回転 ${Number.isFinite(angle) ? `${(angle * 180 / Math.PI).toFixed(0)}°` : "—"}`,
          176 + 328 * i, 200, 300);
      }
      for (const button of buttonDefinitions) {
        const enabled = control.enabled(button.action, state);
        c.fillStyle = enabled ? hover === button.action ? "#386f85" :
          button.action === "commit" ? "#1d6456" : button.action === "pick" && state.picking ? "#745923" : "#244253" : "#172a38";
        c.beginPath(); c.roundRect(button.x, button.y, button.w, button.h, 12); c.fill();
        c.strokeStyle = enabled && hover === button.action ? "white" : "#476374"; c.lineWidth = 2; c.stroke();
        c.fillStyle = enabled ? "white" : "#6d8795"; c.font = "bold 27px sans-serif";
        c.fillText(button.action === "pick" && state.picking ? "地面選択を取消" : button.label,
          button.x + button.w / 2, button.y + button.h / 2 + 9, button.w - 20);
      }
    } else {
      c.textAlign = "left"; c.fillStyle = "#c5dce5"; c.font = "26px sans-serif";
      c.fillText("街の見学はログインなしでできます。", 32, 154, 956);
      c.fillText("作品の配置・共同作業は教室参加後です。", 32, 202, 956);
      c.fillText("下の「2Dに戻る」から参加できます。", 32, 280, 956);
      c.fillText("Xボタン1.5秒長押しでも2Dに戻れます。", 32, 328, 956);
    }
    c.textAlign = "left"; c.font = "22px sans-serif";
    c.fillStyle = state.current?.valid === false ? "#ffaca0" : "#bdd5e3";
    c.fillText(safeCaption(state.message || state.workshopState.message ||
      "元の建物は編集されません。空き地の実地形に配置します。"), 24, 494, 970);
    c.font = "19px sans-serif"; c.fillStyle = "#92afbd";
    c.fillText("自分のSTLだけ編集可 · 確定はサーバー確認後に共有", 24, 526, 970);
    if (texture) texture.needsUpdate = true;
  }
  draw(control.snapshot(), 0, true);

  function actionAt(x, y) {
    if (disposed || !group.visible) return null;
    const state = control.snapshot();
    return buttonDefinitions.find((entry) => x >= entry.x && x <= entry.x + entry.w &&
      y >= entry.y && y <= entry.y + entry.h && control.enabled(entry.action, state))?.action ?? null;
  }
  return { group, meshes: panel ? [panel] : [],
    getCanvas: () => canvas,
    actionAt,
    update({ xr = false, visible = true, hover: nextHover = null,
      time = performance.now() / 1000 } = {}) {
      if (disposed) return;
      group.visible = Boolean(xr && visible);
      hover = typeof nextHover === "string" ? nextHover : nextHover?.action ?? null;
      if (!group.visible) { control.cancelPicking(); hover = null; return; }
      draw(control.snapshot(), Number.isFinite(time) ? time : performance.now() / 1000);
    },
    hit(raycaster) {
      if (disposed || !group.visible || !panel) return null;
      const state = control.snapshot();
      if (!state.ready) return null;
      group.updateWorldMatrix(true, true);
      const intersection = raycaster.intersectObject(panel, false)[0];
      if (!intersection?.uv) return null;
      const x = intersection.uv.x * canvas.width, y = (1 - intersection.uv.y) * canvas.height;
      const action = actionAt(x, y);
      return action ? { action, distance: intersection.distance, point: intersection.point } : null;
    },
    activate: (action) => disposed || !group.visible ? Promise.resolve(false) : control.activate(action?.action ?? action),
    cancelPicking: control.cancelPicking,
    getState() {
      const state = control.snapshot();
      return { visible: group.visible, embedded, spatialVisible: Boolean(panel && group.visible), canEdit: state.allowed, picking: state.picking,
        pending: state.pending, selected: state.current?.id ?? null, hovered: hover, disposed,
        redraws, position: [...vrWorkshopLayout.position], size: [...vrWorkshopLayout.size],
        canvas: [canvas.width, canvas.height],
        actions: buttonDefinitions.map((button) => ({ action: button.action, x: button.x, y: button.y,
          w: button.w, h: button.h, enabled: control.enabled(button.action, state) })) };
    },
    dispose() {
      if (disposed) return;
      disposed = true; control.dispose(); group.removeFromParent(); group.visible = false;
      texture?.dispose(); material?.dispose(); geometry?.dispose();
    } };
}
