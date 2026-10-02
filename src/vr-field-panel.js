export const vrFieldPanelLayout = Object.freeze({
  position: Object.freeze([0, 0, -1.8]),
  size: Object.freeze([1.4, 1.12]),
  canvas: Object.freeze([1280, 1024]),
  compactHeight: 384,
  maxRefreshHz: 15,
});

const tabs = [
  { action: "tab-observe", tab: "observe", label: "見学", x: 40, y: 94, w: 384, h: 76 },
  { action: "tab-region", tab: "region", label: "広域", x: 448, y: 94, w: 384, h: 76 },
  { action: "tab-workshop", tab: "workshop", label: "作品", x: 856, y: 94, w: 384, h: 76 },
];
export const fieldRegionMapRect = Object.freeze({ x: 40, y: 196, w: 922, h: 584 });
const workshopRect = Object.freeze({ x: 40, y: 186, w: 1184, h: 638.25 });
const within = (rect, x, y) => x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;

/** One shared texture and mesh own every visible in-headset control. */
export function createVRFieldPanel(THREE, { camera, controllerHud, vrWorkshop,
  getViewState = () => ({}), onAction = () => {}, drawMap = () => {},
  documentTarget = globalThis.document } = {}) {
  const canvas = documentTarget.createElement("canvas");
  [canvas.width, canvas.height] = vrFieldPanelLayout.canvas;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = false; texture.minFilter = THREE.LinearFilter;
  const geometry = new THREE.PlaneGeometry(...vrFieldPanelLayout.size);
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true,
    depthTest: false, depthWrite: false, toneMapped: false });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "vr-field-note-panel"; mesh.position.fromArray(vrFieldPanelLayout.position);
  mesh.renderOrder = 1001; mesh.frustumCulled = false; mesh.visible = false;
  camera.add(mesh);
  let tab = "observe", expanded = true, interactive = false, hovered = null;
  let progress = 0, exiting = false, lastKey = "", lastDraw = -Infinity, redraws = 0, disposed = false;

  function returnRect() {
    return { action: "return", label: "2Dに戻る", x: 40, y: expanded ? 838 : 194,
      w: 1184, h: 148, enabled: !exiting };
  }
  function actions() {
    const view = getViewState(), result = [returnRect()];
    if (!expanded) return [...result, { action: "expand", label: "パネルを開く", x: 40, y: 94,
      w: 1184, h: 76, enabled: !exiting }];
    result.push(...tabs.map((entry) => ({ ...entry, enabled: !exiting })));
    if (tab === "observe") result.push(
      ...[["overview", "上空", 40], ["east", "東側", 448], ["west", "西側", 856]]
        .map(([action, label, x]) => ({ action, label, x, y: 198, w: 384, h: 110, enabled: !exiting })),
      { action: "free", label: `自由移動 ${view.free ? "ON" : "OFF"}`, x: 40, y: 330,
        w: 1184, h: 96, enabled: !exiting });
    if (tab === "region") result.push(
      { action: "map", ...fieldRegionMapRect, enabled: Boolean(view.regionReady && !exiting) },
      { action: "region-east", label: "駅へ戻る", x: 984, y: 196, w: 240, h: 110, enabled: !exiting });
    if (tab === "workshop") {
      const state = vrWorkshop.getState(), sx = workshopRect.w / state.canvas[0], sy = workshopRect.h / state.canvas[1];
      result.push(...state.actions.map((entry) => ({ ...entry,
        x: workshopRect.x + entry.x * sx, y: workshopRect.y + entry.y * sy,
        w: entry.w * sx, h: entry.h * sy, enabled: Boolean(entry.enabled && interactive && !exiting) })));
    }
    return result;
  }
  function synchronizeContent(time) {
    controllerHud.setEmbeddedVisible(mesh.visible && expanded && tab === "observe");
    vrWorkshop.update({ xr: mesh.visible, visible: interactive && expanded && tab === "workshop",
      hover: hovered, time: time / 1000 });
  }
  function draw(time, force = false) {
    const view = getViewState(), hud = controllerHud.getState(), workshop = vrWorkshop.getState();
    const key = JSON.stringify({ visible: mesh.visible, expanded, tab, hovered, exiting,
      progress: Math.round(progress * 100), free: view.free,
      horizontal: Number(view.horizontalSpeed ?? 0).toFixed(1), vertical: Number(view.verticalSpeed ?? 0).toFixed(1),
      regionReady: view.regionReady, mapSecond: tab === "region" ? Math.floor(time / 1000) : 0,
      hud: tab === "observe" ? hud.renderCount : 0, workshop: tab === "workshop" ? workshop.redraws : 0 });
    if (!force && (key === lastKey || time - lastDraw < 1000 / vrFieldPanelLayout.maxRefreshHz)) return;
    lastKey = key; lastDraw = time; redraws++;
    const c = canvas.getContext("2d");
    if (!c) return;
    c.clearRect(0, 0, canvas.width, canvas.height);
    c.fillStyle = "rgba(8,20,35,.96)"; c.beginPath();
    c.roundRect(2, 2, canvas.width - 4, canvas.height - 4, 28); c.fill();
    c.strokeStyle = "#83cfbf"; c.lineWidth = 3; c.stroke();
    c.textAlign = "left"; c.fillStyle = "white"; c.font = "bold 38px sans-serif";
    c.fillText("岡崎まち フィールドノート", 40, 58, 1184);

    const drawButton = (entry, selected = false) => {
      const active = entry.enabled !== false;
      c.fillStyle = active ? hovered === entry.action ? "#386f85" :
        entry.action === "return" ? "#1b665b" : selected ? "#33675e" : "#244253" : "#172a38";
      c.beginPath(); c.roundRect(entry.x, entry.y, entry.w, entry.h, 16); c.fill();
      c.strokeStyle = active && hovered === entry.action ? "white" : selected ? "#9bf3d5" : "#547789";
      c.lineWidth = hovered === entry.action ? 4 : 2; c.stroke();
      c.fillStyle = active ? "white" : "#7d929d"; c.font = "bold 34px sans-serif"; c.textAlign = "center";
      c.fillText(entry.label, entry.x + entry.w / 2, entry.y + entry.h / 2 + 12, entry.w - 32);
    };
    const list = actions();
    if (expanded) {
      for (const entry of tabs) drawButton(entry, tab === entry.tab);
      if (tab === "observe") {
        for (const entry of list.filter((entry) => ["overview", "east", "west", "free"].includes(entry.action))) drawButton(entry);
        const canvases = controllerHud.getCanvases();
        c.drawImage(canvases.left, 40, 442, 540, 380);
        c.drawImage(canvases.right, 684, 442, 540, 380);
      } else if (tab === "region") {
        if (view.regionReady) drawMap(c, fieldRegionMapRect);
        else {
          c.fillStyle = "#c5dce5"; c.font = "28px sans-serif"; c.textAlign = "left";
          c.fillText("広域マップを読み込んでいます。", 40, 260, 920);
        }
        drawButton(list.find((entry) => entry.action === "region-east"));
        c.fillStyle = "#c5dce5"; c.font = "24px sans-serif"; c.textAlign = "left";
        for (const [i, text] of ["地図を指して", "トリガーで移動", "灰：建物区画", "緑：駅", "橙：現在地"].entries()) {
          c.fillText(text, 984, 358 + i * 56, 240);
        }
      } else c.drawImage(vrWorkshop.getCanvas(), workshopRect.x, workshopRect.y, workshopRect.w, workshopRect.h);
    } else drawButton(list.find((entry) => entry.action === "expand"));
    const exit = returnRect();
    drawButton({ ...exit, label: exiting ? "2Dに戻っています…" : hovered === "return" ?
      "2Dに戻る · トリガーで選択" : "2Dに戻る · Xを1.5秒長押し" });
    if (progress > 0) {
      c.fillStyle = "#94f5ce"; c.fillRect(exit.x + 8, exit.y + exit.h - 10, (exit.w - 16) * progress, 5);
    }
    texture.needsUpdate = true;
  }
  function changeExpanded(value) {
    expanded = Boolean(value);
    canvas.height = expanded ? vrFieldPanelLayout.canvas[1] : vrFieldPanelLayout.compactHeight;
    mesh.scale.y = canvas.height / vrFieldPanelLayout.canvas[1];
    hovered = null; synchronizeContent(performance.now()); draw(performance.now(), true);
  }
  function selectTab(value) {
    if (!tabs.some((entry) => entry.tab === value)) return false;
    tab = value; hovered = null;
    synchronizeContent(performance.now()); draw(performance.now(), true); return true;
  }
  function actionAt(x, y, { handedness = "right" } = {}) {
    if (disposed || !mesh.visible || !interactive || exiting) return null;
    const entry = actions().find((entry) => within(entry, x, y) && entry.enabled);
    if (!entry || tab === "workshop" && !["return", "expand", "tab-observe", "tab-region", "tab-workshop"].includes(entry.action) && handedness !== "right") return null;
    // Embedded workshop coordinates are validated by its live permission gate.
    if (tab === "workshop" && !entry.action.startsWith("tab-") && !["return", "expand"].includes(entry.action)) {
      return vrWorkshop.actionAt((x - workshopRect.x) * vrWorkshop.getCanvas().width / workshopRect.w,
        (y - workshopRect.y) * vrWorkshop.getCanvas().height / workshopRect.h);
    }
    return entry.action;
  }
  function hit(raycaster, options) {
    if (disposed || !mesh.visible) return null;
    mesh.updateWorldMatrix(true, false);
    const intersection = raycaster.intersectObject(mesh, false)[0];
    if (!intersection?.uv) return null;
    const x = intersection.uv.x * canvas.width, y = (1 - intersection.uv.y) * canvas.height;
    return { ...intersection, x, y, action: actionAt(x, y, options) };
  }
  async function activate(action, { x, y, handedness = "right" } = {}) {
    if (disposed || !mesh.visible || !interactive || exiting) return false;
    const entry = actions().find((entry) => entry.action === action && entry.enabled);
    if (!entry) return false;
    if (action === "expand") { changeExpanded(true); return true; }
    if (action.startsWith("tab-")) return selectTab(entry.tab);
    if (tab === "workshop" && action !== "return") {
      if (handedness !== "right") return false;
      return vrWorkshop.activate(action);
    }
    await onAction(action, { x, y, rect: { ...entry } }); return true;
  }
  function getState() {
    const list = actions().map(({ action, x, y, w, h, enabled }) => ({ action, x, y, w, h, enabled }));
    return { name: mesh.name, visible: mesh.visible, position: mesh.position.toArray(),
      size: [vrFieldPanelLayout.size[0], vrFieldPanelLayout.size[1] * mesh.scale.y],
      canvas: [canvas.width, canvas.height], tab, expanded, guideExpanded: expanded,
      hovered, redraws, meshCount: disposed ? 0 : 1, panelCount: Number(mesh.visible && !disposed),
      rendered: { panelCount: Number(mesh.visible && !disposed) },
      hudRects: { left: { x: 40, y: 442, w: 540, h: 380 }, right: { x: 684, y: 442, w: 540, h: 380 } },
      actions: list, actionRects: Object.fromEntries(list.map((entry) => [entry.action, { ...entry }])),
      progress, exiting, interactive };
  }
  function getReturnState() {
    const rect = returnRect(), size = getState().size;
    return { position: [mesh.position.x + ((rect.x + rect.w / 2) / canvas.width - .5) * size[0],
      mesh.position.y + (.5 - (rect.y + rect.h / 2) / canvas.height) * size[1], mesh.position.z],
      size: [rect.w / canvas.width * size[0], rect.h / canvas.height * size[1]],
      rect: { ...rect }, visible: mesh.visible, progress, exiting, hovered: hovered === "return" };
  }
  draw(0, true);
  return { mesh, hit, actionAt, activate, selectTab, setExpanded: changeExpanded,
    toggleExpanded: () => changeExpanded(!expanded), getState, getReturnState,
    update({ xr = mesh.visible, interactive: nextInteractive = interactive, hovered: nextHover = hovered,
      progress: nextProgress = progress, exiting: nextExiting = exiting, time = performance.now() } = {}) {
      if (disposed) return;
      const changed = mesh.visible !== Boolean(xr);
      mesh.visible = Boolean(xr); interactive = Boolean(mesh.visible && nextInteractive);
      progress = Number.isFinite(nextProgress) ? Math.max(0, Math.min(1, nextProgress)) : 0;
      exiting = Boolean(nextExiting); hovered = interactive && !exiting ? nextHover : null;
      synchronizeContent(time); draw(time, changed);
    },
    dispose() {
      if (disposed) return;
      disposed = true; mesh.visible = false; mesh.removeFromParent();
      controllerHud.setEmbeddedVisible(false); vrWorkshop.update({ xr: false });
      texture.dispose(); material.dispose(); geometry.dispose();
    } };
}
