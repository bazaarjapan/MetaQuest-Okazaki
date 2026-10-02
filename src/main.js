import * as THREE from "three";
import "./xr-dev.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  viewpoints, clampPosition, stickAxes, flightConfig,
  createFlightState, resetFlight, updateFlight,
} from "./motion.js";
import { createControllerHud } from "./controller-hud.js";
import { qualityProfile, readQuality, saveQuality } from "./quality.js";
import { createRegionStreamer } from "./region-stream.js";
import { clampToRegion, regionProfiles } from "./region-plan.js";
import { drawRegionMap, mapToWorld } from "./region-map.js";
import { createAdaptiveUi } from "./ui-layout.js";
import { createTouchControls } from "./touch-controls.js";
import { createVRFieldPanel, fieldRegionMapRect } from "./vr-field-panel.js";
import { createExitHold, updateExitHold, cancelExitHold } from "./xr-exit-hold.js";
import { captureView, captureXRView, alignRigToView, resolveXRExitView, resolveXREntryView } from "./vr-view.js";
import { createSurfaceIndex } from "./placement.js";
import { createWorkshop } from "./workshop.js";
import { createCreativeControls, constrainCreativeFeet, readControlMode, controlPreferenceKey, initialPCMovement } from "./creative-controls.js";
import { createBlockAvatar } from "./block-avatar.js";
import { createSchoolClient } from "./school-client.js";
import { createSchoolUI } from "./school-ui.js";
import { createSchoolPresence } from "./school-presence.js";
import { createVRWorkshop } from "./vr-workshop.js";
import { createVRControllerPointer } from "./vr-controller-pointer.js";
import "./style.css";
import "./layout.css";

const $ = (s) => document.querySelector(s),
  viewport = $("#viewport");
const adaptiveUi = createAdaptiveUi();
const touchControls = createTouchControls(viewport);
let touchUiKey = "";
let mobileAvatarControls = false;
function syncTouchControls() {
  const ui = adaptiveUi.getState();
  if (creative && ui.mobile && !mobileAvatarControls && !state.xr && !xrEntering && !creative.getState().suspendedXR && creative.getState().mode === "creative") {
    creative.setMode("drone"); setFree(false);
    $("#control-mode").value = "drone"; $("#creative-help").hidden = true;
  }
  const enabled = ui.mobile && state.free && !state.xr && !xrEntering && !ui.open && !document.querySelector("dialog[open]");
  touchControls.setEnabled(enabled);
  const key = `${enabled}:${state.free}`;
  if (key !== touchUiKey) {
    touchUiKey = key;
    document.body.dataset.touchFlight = String(enabled);
    $("#mobile-flight").setAttribute("aria-pressed", String(state.free));
    $("#mobile-flight").textContent = state.free ? "移動 ON" : "移動 OFF";
  }
}
let preferenceStorage;
try { preferenceStorage = window.localStorage; } catch { /* Optional preference only. */ }
let quality = readQuality(preferenceStorage);
const state = {
  ready: false,
  current: "overview",
  free: false,
  xr: false,
  error: null,
  triangles: 0,
  parts: 0,
  qualityLoading: false,
  regionReady: false,
  regionError: null,
};
let initialMovementInterrupted = false;
const scene = new THREE.Scene();
scene.background = new THREE.Color("#dce9ee");
scene.fog = new THREE.Fog("#dce9ee", 800, 1700);
const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 2300),
  rig = new THREE.Group();
rig.add(camera);
scene.add(rig);
let renderer, controls;
try {
  renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: "high-performance",
  });
} catch (e) {
  fail(
    new Error(
      "この端末で3D表示を開始できませんでした。ブラウザーの更新、または別のPCでお試しください。",
    ),
  );
  throw e;
}
renderer.setPixelRatio(Math.min(devicePixelRatio, quality.dpr));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType("local-floor");
renderer.xr.setFramebufferScaleFactor(quality.xrScale);
renderer.xr.setFoveation(quality.foveation);
viewport.prepend(renderer.domElement);
renderer.domElement.setAttribute("aria-label", "岡崎駅周辺の3D街並み");
controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 12;
controls.maxDistance = 1100;
controls.maxPolarAngle = Math.PI * 0.485;
scene.add(new THREE.HemisphereLight(0xdff2ff, 0x879080, 2.1));
const sun = new THREE.DirectionalLight(0xfff2da, 2.3);
sun.position.set(-200, 400, 150);
sun.castShadow = true;
sun.shadow.camera.left = sun.shadow.camera.bottom = -480;
sun.shadow.camera.right = sun.shadow.camera.top = 480;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 1100;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.5;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;
scene.add(sun);
const city = new THREE.Group();
scene.add(city);
const regionGroup = new THREE.Group();
regionGroup.name = "streamed-okazaki-region";
scene.add(regionGroup);
const regionStreamer = createRegionStreamer(THREE, regionGroup);
let regionManifest = null, regionUiTime = 0;
const textures = new Map();
let detail = null, terrainMesh = null, terrainFile = "Texture-001.png";
const raycaster = new THREE.Raycaster(),
  down = new THREE.Vector3(0, -1, 0),
  temp = new THREE.Vector3();
const keys = new Set();
let frameTime = 0,
  nextGroundCheck = 0,
  ground = 16.5;
const controllers = [],
  previousButtons = new Map();
const controllerPointers = {
  left: createVRControllerPointer(THREE, { parent: scene, handedness: "left" }),
  right: createVRControllerPointer(THREE, { parent: scene, handedness: "right" }),
};
const controllerRaycaster = new THREE.Raycaster();
const hoveredHands = { left: null, right: null };
function hideControllerPointers() { controllerPointers.left.hide(); controllerPointers.right.hide(); }
function controllerInteractionActive(session = renderer.xr.getSession()) {
  return state.xr && !xrExitPending && !pendingXRView && session?.visibilityState === "visible";
}
function trackedControllerSource(controller, session) {
  const hand = controller.userData.handedness;
  if (!controller.visible || (hand !== "left" && hand !== "right")) return null;
  for (const source of session?.inputSources ?? []) {
    if (source.handedness === hand && source.targetRayMode === "tracked-pointer") return source;
  }
  return null;
}
function setControllerRay(controller) {
  controller.updateWorldMatrix(true, false);
  const { origin, direction } = controllerRaycaster.ray;
  origin.setFromMatrixPosition(controller.matrixWorld);
  direction.set(0, 0, -1).transformDirection(controller.matrixWorld);
  return Number.isFinite(origin.x) && Number.isFinite(origin.y) && Number.isFinite(origin.z) &&
    Number.isFinite(direction.x) && Number.isFinite(direction.y) && Number.isFinite(direction.z) && direction.lengthSq() > 0;
}
function updateControllerPointer(controller, source, hit, time) {
  return controllerPointers[controller.userData.handedness].update({ enabled: true,
    origin: controllerRaycaster.ray.origin, direction: controllerRaycaster.ray.direction,
    hit, pressed: Boolean(source.gamepad?.buttons[0]?.pressed), time });
}
function acceptedControllerSelection(controller, source, session) {
  if (!controllerInteractionActive(session) || renderer.xr.getSession() !== session ||
    trackedControllerSource(controller, session) !== source) return;
  controllerPointers[source.handedness].flash(performance.now());
  const actuator = source.gamepad?.hapticActuators?.[0];
  if (typeof actuator?.pulse === "function") {
    try { Promise.resolve(actuator.pulse(.25, 25)).catch(() => {}); } catch { /* Haptics are optional. */ }
  }
}
const flight = createFlightState();
const schoolClient = createSchoolClient();
let schoolUI;
let placementEnvironment = { terrain: null, obstacles: [], bounds: [-320, -381, 315, 372], terrainMeshes: [] };
const workshop = createWorkshop(THREE, { scene, domElement: renderer.domElement, camera,
  getEnvironment: () => placementEnvironment, getViewPosition: userPosition,
  schoolClient, isXR: () => state.xr,
  onRequireLogin: () => schoolUI?.open(),
  onChange: () => { renderer.shadowMap.needsUpdate = true; } });
const ownAvatar = createBlockAvatar(THREE);
let ownIdentity = null, ownColor = null;
scene.add(ownAvatar.group);
renderer.domElement.tabIndex = 0;
let creative = null;
renderer.domElement.addEventListener("pointerdown", () => {
  if (creative?.getState().mode === "creative" && !state.xr) renderer.domElement.focus();
});
const terrainRay = new THREE.Raycaster();
function terrainOnlySample(x, z) {
  if (!terrainMesh) return null;
  terrainRay.set(new THREE.Vector3(x, 2500, z), down);
  return terrainRay.intersectObjects([terrainMesh, ...regionStreamer.getGroundMeshes()], false)[0]?.point.y ?? null;
}
creative = createCreativeControls(THREE, { camera, rig, domElement: renderer.domElement,
  getControls: () => controls, avatar: ownAvatar, groundHeight: terrainOnlySample,
  cameraObstacles: () => [...city.children, ...regionStreamer.getMeshes()],
  onChange: () => syncAvatarViewButtons(),
  constrainPosition: (feet) => constrainCreativeFeet(feet, constrainPosition) });
$("#control-mode").onchange = (event) => {
  if (state.xr || xrEntering || creative.getState().suspendedXR) { event.target.value = creative.getState().mode; return; }
  const mobile = adaptiveUi.getState().mobile;
  if (mobile) mobileAvatarControls = event.target.value === "creative";
  setFree(false); creative.setMode(event.target.value);
  try { if (!mobile) preferenceStorage?.setItem(controlPreferenceKey, event.target.value); } catch { /* Optional preference. */ }
  syncMovementHelp();
  $("#canvas-hint").textContent = event.target.value === "creative"
    ? "自由移動ONでWASD · 3D画面をクリックして見回す · Escでマウス解除 · F5で視点切替" : "ドラッグで回転 · ホイールで拡大";
};
function syncAvatarViewButtons() {
  const current = creative?.getState();
  const label = current?.mode === "creative" ? { first: "一人称", back: "三人称・後ろ", front: "三人称・前" }[current.viewMode] : "一人称";
  for (const [id, text] of [["avatar-view", `視点：${label}`], ["mobile-avatar-view", label]]) {
    const button = $(`#${id}`); if (!button) continue;
    if (button.textContent !== text) button.textContent = text;
    button.setAttribute("aria-label", `視点を切り替える（現在：${label}）`);
    button.disabled = !state.ready || state.xr || xrEntering || current?.suspendedXR;
  }
}
for (const id of ["avatar-view", "mobile-avatar-view"]) $(`#${id}`).onclick = () => {
  if (!state.ready || state.xr || xrEntering || creative.getState().suspendedXR || document.querySelector("dialog[open]")) return;
  if (adaptiveUi.getState().mobile) { mobileAvatarControls = true; adaptiveUi.close(); }
  if (creative.getState().mode !== "creative") {
    $("#control-mode").value = "creative";
    $("#control-mode").dispatchEvent(new Event("change"));
  }
  creative.cycleView(); renderer.domElement.focus({ preventScroll: true }); syncAvatarViewButtons();
};
const exitHold = createExitHold();
let vrFieldPanel = null;
const vrReturnButton = {
  update: (next = {}) => vrFieldPanel?.update({ ...next,
    ...(Object.hasOwn(next, "hovered") ? { hovered: next.hovered ? "return" : null } : {}) }),
  setVisible: (value) => vrFieldPanel?.update({ xr: value, interactive: false }),
  getState: () => vrFieldPanel.getReturnState(),
};
let xrExitPending = false, xrEntering = false, hasVRResume = false;
let lastXRView = null, pendingXRView = null;
let panel;
let simulationSeconds = 0;
schoolUI = createSchoolUI({ client: schoolClient, button: $("#school-button"),
  onBeforeOpen: () => {
    if (state.xr || xrEntering) return false;
    setFree(false); creative.clearInput({ release: true }); return true;
  } });
const presence = createSchoolPresence(THREE, { scene, client: schoolClient });
const vrWorkshop = createVRWorkshop(THREE, { camera, workshop, client: schoolClient,
  embedded: true,
  onShadowChange: () => { renderer.shadowMap.needsUpdate = true; } });
let schoolState = schoolClient.getState(), lastSchoolSnapshot = 0, restoredWorld = null;
function adoptSchoolPose() {
  if (!state.ready || !schoolState.world || schoolState.connection !== "connected" ||
      schoolState.snapshotSeq === lastSchoolSnapshot) return;
  lastSchoolSnapshot = schoolState.snapshotSeq;
  const member = schoolState.participants.find((p) => p.id === schoolState.user?.id);
  if (!Array.isArray(member?.position) || !member.position.every(Number.isFinite) || !Number.isFinite(member.yaw)) return;
  const view = { position: [...member.position], quaternion: new THREE.Quaternion()
    .setFromEuler(new THREE.Euler(0, member.yaw, 0, "YXZ")).toArray() };
  setFree(false); vrWorkshop.cancelPicking();
  updateLabels("school");
  if (state.xr || xrEntering) pendingXRView = view;
  if (!state.xr) { restoreDesktopView(view); creative.syncFromCamera(); }
  restoredWorld = schoolState.world.id;
}
schoolClient.subscribe((next, event) => {
  schoolState = next;
  if (event === "pose") return;
  $("#open-workshop").textContent = next.user && next.world ? "自分のSTL作品" : "STL作品（ログイン）";
  if (ownIdentity !== (next.user?.id ?? null)) {
    ownIdentity = next.user?.id ?? null; ownAvatar.setIdentity(ownIdentity); setFree(false);
  }
  if (next.user?.color && ownColor !== next.user.color) { ownColor = next.user.color; ownAvatar.setColor(ownColor); }
  if (!next.user) { ownColor = null; ownAvatar.group.visible = false; }
  if (!next.world || next.connection !== "connected") { vrWorkshop.cancelPicking(); restoredWorld = null; }
  adoptSchoolPose();
});
schoolClient.init().catch(() => { /* School failure never blocks anonymous city/VR viewing. */ });
function resize() {
  const w = viewport.clientWidth,
    h = viewport.clientHeight;
  if (renderer.xr.isPresenting) return;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(viewport);
resize();
function fail(error) {
  state.error = error.message;
  $("#loading").hidden = false;
  $("#loading h2").textContent = "街を読み込めませんでした";
  $("#load-message").textContent = error.message;
  $("#retry").hidden = false;
  $("#loading .loader").style.display = "none";
  $("#status").textContent = "読み込みエラー";
  console.error(error);
}
$("#retry").onclick = () => location.reload();
async function fetchChecked(url, type) {
  const response = await fetch(url, { signal: AbortSignal.timeout(45000) });
  if (!response.ok)
    throw new Error(
      `モデルの取得に失敗しました（${response.status}）。再読み込みをお試しください。`,
    );
  return type === "json" ? response.json() : response.arrayBuffer();
}
async function loadCity() {
  const manifest = await fetchChecked("/city/manifest.json", "json");
  // Detail assets are optional: the original published atlas remains a fallback.
  try { detail = await fetchChecked("/city/detail.json", "json"); } catch { detail = null; }
  for (const [i, p] of manifest.parts.entries()) {
    $("#load-message").textContent =
      `街のデータを読み込み中 ${i + 1} / ${manifest.parts.length}`;
    const data = await fetchChecked("/city/" + p.file, "buffer"),
      n = p.vertices;
    if (data.byteLength !== n * 32 + p.indices * 4)
      throw new Error(
        "モデルデータのサイズが一致しません。再読み込みしてください。",
      );
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(data, 0, n * 3), 3),
    );
    geometry.setAttribute(
      "normal",
      new THREE.BufferAttribute(new Float32Array(data, n * 12, n * 3), 3),
    );
    geometry.setAttribute(
      "uv",
      new THREE.BufferAttribute(new Float32Array(data, n * 24, n * 2), 2),
    );
    geometry.setIndex(
      new THREE.BufferAttribute(new Uint32Array(data, n * 32, p.indices), 1),
    );
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();
    let map = null;
    if (p.texture) {
      const isTerrain = p.texture === "Texture-001.png";
      const preferred = isTerrain ? terrainVariant(quality.id) : p.texture;
      try { map = await loadTexture(preferred); }
      catch {
        map = await loadTexture(p.texture);
        $("#quality-note").textContent = "高解像度写真を取得できなかったため、元の写真で表示しています。";
      }
      if (isTerrain) terrainFile = [...textures.entries()].find(([, t]) => t === map)[0];
    }
    const color = map
      ? new THREE.Color(1, 1, 1)
      : new THREE.Color(...p.color).multiplyScalar(0.84);
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({
        color,
        map,
        roughness: 1,
        metalness: 0,
      }),
    );
    mesh.name = p.name;
    mesh.castShadow = p.texture !== "Texture-001.png";
    mesh.receiveShadow = true;
    if (p.texture === "Texture-001.png") terrainMesh = mesh;
    // Real geometry edges improve readability without inventing facade detail.
    if (!p.texture && p.vertices > 30000) {
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 35),
        new THREE.LineBasicMaterial({ color: 0x4d6574, transparent: true,
          opacity: 0.18, depthWrite: false }));
      edges.name = "building-outline";
      edges.visible = quality.id !== "performance";
      mesh.add(edges);
    }
    city.add(mesh);
  }
  applyRenderQuality();
  placementEnvironment = { terrain: createSurfaceIndex(terrainMesh.geometry.attributes.position.array,
      terrainMesh.geometry.index?.array),
    obstacles: city.children.filter((mesh) => mesh !== terrainMesh).map((mesh) =>
      createSurfaceIndex(mesh.geometry.attributes.position.array, mesh.geometry.index?.array)),
    bounds: coreBounds(), terrainMeshes: [terrainMesh] };
  $("#open-workshop").disabled = false;
  state.ready = true;
  $("#quality-select").disabled = false;
  state.triangles = manifest.triangles;
  state.parts = city.children.length;
  $("#loading").hidden = true;
  document
    .querySelectorAll("[data-view],#home,#free-move,#mobile-flight")
    .forEach((b) => (b.disabled = false));
  goTo("overview");
  $("#control-mode").disabled = false;
  // Let the change handler apply a mobile fallback without persisting it over
  // the user's PC choice. A narrow window must not change desktop preference.
  $("#control-mode").value = adaptiveUi.getState().mobile ? "drone" : readControlMode(preferenceStorage);
  $("#control-mode").dispatchEvent(new Event("change"));
  adoptSchoolPose();
  if (initialPCMovement({ ready: state.ready, mobile: adaptiveUi.getState().mobile,
    hidden: document.hidden, interrupted: initialMovementInterrupted,
    dialogOpen: Boolean(document.querySelector("dialog[open]")), xr: state.xr,
    xrEntering, restoredWorld })) {
    // This only enables input. Never request pointer lock, replay held keys,
    // or teleport the initial view (including a remembered drone preference).
    setFree(true, { preserveView: true });
  }
  addStationLabel(manifest.station);
  await checkVR();
  loadRegion().catch((error) => {
    state.regionError = error.message;
    $("#region-summary").textContent = "広域データを取得できません。駅周辺は引き続き利用できます。";
  });
}
function userPosition() {
  if (!state.xr && creative?.getState().mode === "creative") return new THREE.Vector3().fromArray(creative.getState().eye);
  return camera.getWorldPosition(new THREE.Vector3());
}
function coreBounds() {
  const b = terrainMesh?.geometry.boundingBox;
  return b ? [b.min.x, b.min.z, b.max.x, b.max.z] : [-320, -381, 315, 372];
}
function constrainPosition(position) {
  if (!regionManifest) return clampPosition(position);
  const p = clampToRegion(position, regionManifest.bounds, 1200);
  position.set(p.x, p.y, p.z);
  return position;
}
async function loadRegion() {
  const [buildings, terrain] = await Promise.all([
    fetchChecked("/region/buildings.json", "json"),
    fetchChecked("/region/terrain.json", "json"),
  ]);
  if (!Array.isArray(buildings.tiles) || !buildings.tiles.length ||
      !Array.isArray(terrain.tiles) || !terrain.tiles.length ||
      !Array.isArray(buildings.bounds) || buildings.bounds.length !== 4 ||
      !buildings.bounds.every(Number.isFinite)) throw new Error("広域データの形式が不正です");
  regionManifest = { bounds: buildings.bounds, buildings: buildings.tiles,
    terrain: terrain.tiles, tiles: [...buildings.tiles, ...terrain.tiles],
    source: buildings.source, year: buildings.year,
    geographicBounds: buildings.geographicBounds,
    totalTriangles: buildings.totalTriangles };
  regionStreamer.setManifest(regionManifest);
  state.regionReady = true;
  state.regionError = null;
  const width = (buildings.bounds[2] - buildings.bounds[0]) / 1000,
    height = (buildings.bounds[3] - buildings.bounds[1]) / 1000;
  $("#region-summary").textContent = `モデル収録範囲 約${width.toFixed(1)} × ${height.toFixed(1)} km · ${buildings.tiles.length}建物区画`;
  const selector = $("#region-cell");
  selector.replaceChildren(new Option("移動先の区画を選択…", ""));
  const tiles = [...buildings.tiles].sort((a, b) => a.bounds[1] - b.bounds[1] || a.bounds[0] - b.bounds[0]);
  for (const tile of tiles) {
    const x = (tile.bounds[0] + tile.bounds[2]) / 2, z = (tile.bounds[1] + tile.bounds[3]) / 2;
    const dx = x - 95.92456, dz = z - 49.00273;
    selector.append(new Option(`駅から ${dx >= 0 ? "東" : "西"}${(Math.abs(dx) / 1000).toFixed(1)}km / ${dz >= 0 ? "南" : "北"}${(Math.abs(dz) / 1000).toFixed(1)}km · ${tile.id}`, tile.id));
  }
  selector.disabled = false;
  $("#region-go").disabled = false;
  applyRegionViewRange();
  regionStreamer.update(userPosition(), quality.id, performance.now());
  drawDesktopRegionMap();
  if (panel) drawPanel();
}
function applyRegionViewRange() {
  if (!regionManifest) return;
  const radius = regionProfiles[quality.id].radius;
  camera.far = radius + 1200;
  camera.updateProjectionMatrix();
  scene.fog.near = radius * 0.65;
  scene.fog.far = radius + 500;
  controls.maxDistance = radius + 500;
}
function drawDesktopRegionMap() {
  if (!regionManifest) return;
  const canvas = $("#region-map");
  drawRegionMap(canvas.getContext("2d"), { x: 0, y: 0, w: canvas.width, h: canvas.height },
    regionManifest, userPosition(), coreBounds());
}
function visitRegionPoint(x, z) {
  if (!regionManifest || !Number.isFinite(x) || !Number.isFinite(z)) return;
  let height = 0;
  const containing = regionManifest.buildings.filter((tile) => x >= tile.bounds[0] && x <= tile.bounds[2] && z >= tile.bounds[1] && z <= tile.bounds[3]);
  for (const tile of containing) height = Math.max(height, tile.heightRange?.[1] ?? 0);
  // Start above the local roofs, not at an assumed flat ground elevation.
  // A map point with no building-height sample may be a mountain, so use a
  // conservative aerial start while live DEM is loading instead of starting
  // underground. Building districts keep their lower, roof-relative viewpoint.
  const aerialHeight = containing.length ? Math.max(150, height + 100) : 850;
  const position = constrainPosition(new THREE.Vector3(x, Math.min(1100, aerialHeight), z));
  const target = new THREE.Vector3(position.x, Math.max(10, position.y - 100), position.z - 250);
  resetFlight(flight);
  touchControls.releaseAll();
  setFree(false);
  state.current = "region";
  if (state.xr) teleport(position, target);
  else {
    setDesktopView(position, target);
  }
  updateLabels("region");
  adaptiveUi.close();
  regionStreamer.update(userPosition(), quality.id, performance.now() + 500);
  drawDesktopRegionMap();
  drawPanel();
}
$("#region-map").addEventListener("click", (event) => {
  if (!regionManifest) return;
  const rect = event.currentTarget.getBoundingClientRect();
  const p = mapToWorld((event.clientX - rect.left) / rect.width,
    (event.clientY - rect.top) / rect.height, regionManifest.bounds);
  visitRegionPoint(p.x, p.z);
});
$("#region-go").onclick = () => {
  const tile = regionManifest?.buildings.find((entry) => entry.id === $("#region-cell").value);
  if (tile) visitRegionPoint((tile.bounds[0] + tile.bounds[2]) / 2, (tile.bounds[1] + tile.bounds[3]) / 2);
};
function terrainVariant(id) {
  const variant = id === "high" ? "high" : id === "balanced" ? "standard" : null;
  return detail?.profiles?.[variant]?.file ?? "Texture-001.png";
}
async function loadTexture(file) {
  if (textures.has(file)) return textures.get(file);
  const t = await new THREE.TextureLoader().loadAsync("/city/" + file);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = Math.min(quality.anisotropy, renderer.capabilities.getMaxAnisotropy());
  textures.set(file, t);
  return t;
}
function applyRenderQuality() {
  // XR framebuffer changes are legal only between sessions, never while worn.
  if (state.xr) return;
  renderer.setPixelRatio(Math.min(devicePixelRatio, quality.dpr));
  renderer.xr.setFramebufferScaleFactor(quality.xrScale);
  renderer.xr.setFoveation(quality.foveation);
  renderer.shadowMap.enabled = quality.id === "high";
  if (!renderer.shadowMap.enabled && sun.shadow.map) {
    sun.shadow.map.dispose();
    sun.shadow.map = null;
  }
  sun.shadow.mapSize.set(2048, 2048);
  renderer.shadowMap.needsUpdate = true;
  $("#quality-shortcut").textContent = quality.label;
  for (const t of textures.values()) {
    t.anisotropy = Math.min(quality.anisotropy, renderer.capabilities.getMaxAnisotropy());
    t.needsUpdate = true;
  }
  for (const mesh of city.children) {
    mesh.material.needsUpdate = true;
    for (const child of mesh.children) child.visible = quality.id !== "performance";
  }
  applyRegionViewRange();
  resize();
}
$("#quality-select").value = quality.id;
$("#quality-note").textContent = quality.hint;
$("#quality-select").onchange = async (event) => {
  if (state.xr || state.qualityLoading) return;
  const previous = quality;
  quality = qualityProfile(event.target.value);
  state.qualityLoading = true;
  $("#quality-select").disabled = true;
  $("#enter-vr").disabled = true;
  $("#quality-note").textContent = "画質と空中写真を切り替え中…";
  try {
    if (terrainMesh) {
      const nextFile = terrainVariant(quality.id);
      const map = await loadTexture(nextFile);
      const oldFile = terrainFile;
      terrainMesh.material.map = map;
      terrainMesh.material.needsUpdate = true;
      terrainFile = nextFile;
      // Keep only the active terrain atlas to bound decoded GPU memory.
      if (oldFile !== nextFile) {
        textures.get(oldFile)?.dispose();
        textures.delete(oldFile);
      }
    }
    applyRenderQuality();
    saveQuality(preferenceStorage, quality.id);
    $("#quality-note").textContent = quality.hint;
  } catch {
    quality = previous;
    $("#quality-select").value = previous.id;
    $("#quality-note").textContent = "画質を切り替えられませんでした。現在の設定で続けます。";
  } finally {
    state.qualityLoading = false;
    $("#quality-select").disabled = false;
    if (state.ready) await checkVR();
  }
};
function addStationLabel(position) {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 128;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#112b3dee";
  ctx.fillRect(0, 0, 512, 128);
  ctx.fillStyle = "#b4e9db";
  ctx.fillRect(0, 0, 9, 128);
  ctx.fillStyle = "white";
  ctx.font = "bold 46px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("JR 岡崎駅", 256, 61);
  ctx.font = "23px sans-serif";
  ctx.fillStyle = "#c7dce5";
  ctx.fillText("2020年度モデル", 256, 101);
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  const label = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, depthTest: false }),
  );
  label.position.set(position[0], 55, position[2]);
  label.scale.set(55, 13.75, 1);
  scene.add(label);
}
function updateLabels(id) {
  const v = viewpoints[id] ?? (id === "region" ? {
    title: "岡崎市の広域を探索", description: "現在地の周辺だけを読み込んで観察",
    question: "市街地と周辺で、建物の集まり方はどう違う？",
    detail: "広域マップで移動して比較しよう。収録範囲は行政界ではなく、2020年度モデルの範囲です。",
  } : id === "school" ? {
    title: "共同教室でまちづくり", description: "保存された位置から再開 · 移動はOFF",
    question: "この街にどんな作品を加えたい？",
    detail: "自分のSTLを空いている実地面へ配置しよう。元の街と他の人の作品は変更できません。",
  } : null);
  if (!v) return;
  state.current = id;
  $("#view-title").textContent = v.title;
  $("#view-description").textContent = v.description;
  $("#question").textContent = v.question;
  $("#question-detail").textContent = v.detail;
  document.querySelectorAll("[data-view]").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === id);
    b.setAttribute("aria-pressed", String(b.dataset.view === id));
  });
  $("#status").textContent =
    `${state.xr ? "VR" : "PC"}で観察中 · ${state.free ? "自由移動" : "地点から見学"}`;
}
function goTo(id) {
  if (!viewpoints[id]) return;
  vrFieldPanel?.selectTab("observe");
  resetFlight(flight);
  touchControls.releaseAll();
  adaptiveUi.close();
  setFree(false);
  const v = viewpoints[id];
  if (state.xr) {
    const position = new THREE.Vector3(...v.position);
    if (id === "overview") position.set(220, 170, 250);
    const target = new THREE.Vector3(...v.target);
    teleport(position, target);
  } else {
    setDesktopView(new THREE.Vector3(...v.position), new THREE.Vector3(...v.target));
  }
  ground = 16.5;
  updateLabels(id);
  if (panel) drawPanel();
}
function setDesktopView(position, target, up = new THREE.Vector3(0, 1, 0), maxPolarAngle = Math.PI * 0.485) {
  // Recreate controls to discard stale orbit damping/pan and its cached up axis.
  controls.dispose();
  rig.position.set(0, 0, 0); rig.rotation.set(0, 0, 0);
  camera.up.copy(up); camera.position.copy(position);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.08;
  controls.minDistance = 12; controls.maxDistance = 1100;
  controls.maxPolarAngle = maxPolarAngle;
  camera.position.copy(position); controls.target.copy(target); controls.update();
  camera.updateMatrixWorld(true);
  creative?.syncFromCamera();
}
function restoreDesktopView(view) {
  const position = new THREE.Vector3().fromArray(view.position);
  const orientation = new THREE.Quaternion().fromArray(view.quaternion);
  const target = position.clone().add(new THREE.Vector3(0, 0, -60).applyQuaternion(orientation));
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(orientation);
  setDesktopView(position, target, up, Math.PI);
}
async function returnTo2D() {
  const session = renderer.xr.getSession();
  if (!state.xr || !session || xrExitPending) return;
  lastXRView = resolveXRExitView(pendingXRView, lastXRView, () => captureView(camera));
  xrExitPending = true;
  hideControllerPointers();
  setFree(false);
  keys.clear(); touchControls.releaseAll();
  vrReturnButton.update({ exiting: true });
  try {
    await session.end();
  } catch (error) {
    // A failed shutdown must leave the escape control usable for a retry.
    if (state.xr) {
      xrExitPending = false;
      cancelExitHold(exitHold);
      vrReturnButton.update({ exiting: false, progress: 0 });
      console.warn("XR exit failed", error.name);
    }
  }
}
function teleport(position, target) {
  const head = camera;
  head.getWorldPosition(temp);
  const local = rig.worldToLocal(temp.clone());
  const q = head.getWorldQuaternion(new THREE.Quaternion());
  const facing = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
  const currentYaw = Math.atan2(-facing.x, -facing.z);
  const desiredYaw = Math.atan2(position.x - target.x, position.z - target.z);
  rig.rotation.y += desiredYaw - currentYaw;
  const offset = local.applyQuaternion(rig.quaternion);
  rig.position.copy(position).sub(offset);
  rig.updateMatrixWorld(true);
}
function syncMovementHelp() {
  const creativeMode = creative?.getState().mode === "creative";
  $("#creative-help").hidden = !creativeMode;
  $("#move-help").hidden = !state.free || creativeMode;
  $("#free-move-state").textContent = state.free ? "ON" : "OFF";
  $("#movement-controls").dataset.free = String(state.free);
}
function setFree(value, { preserveView = false } = {}) {
  value = Boolean(value);
  if (value && !state.ready) value = false;
  if (value && !state.xr && (document.hidden || document.querySelector("dialog[open]"))) value = false;
  if (state.xr && vrWorkshop?.getState().picking) value = false;
  if (xrEntering && !state.xr) value = false;
  if (value && !preserveView && !state.xr && creative?.getState().mode !== "creative" && state.current !== "region" && !hasVRResume && !restoredWorld) goTo("east");
  keys.clear();
  creative?.clearInput({ release: !value });
  resetFlight(flight);
  touchControls.releaseAll();
  state.free = value;
  $("#free-move").checked = value;
  syncMovementHelp();
  updateLabels(state.current);
  syncTouchControls();
  if (panel) drawPanel();
}
document
  .querySelectorAll("[data-view]")
  .forEach((b) => (b.onclick = () => goTo(b.dataset.view)));
$("#home").onclick = () => goTo(state.xr ? "east" : "overview");
$("#free-move").onchange = (e) => setFree(e.target.checked);
$("#mobile-flight").onclick = () => {
  if (!state.ready) return;
  adaptiveUi.close(); setFree(!state.free);
  if (state.free && creative.getState().mode === "creative") renderer.domElement.focus({ preventScroll: true });
};
$("#help").onclick = () => { setFree(false); $("#help-dialog").showModal(); };
$("#close-help").onclick = () => $("#help-dialog").close();
$("#help-dialog").addEventListener("click", (e) => {
  if (e.target === $("#help-dialog")) $("#help-dialog").close();
});
$("#fullscreen").onclick = async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await viewport.requestFullscreen();
  } catch {
    $("#status").textContent = "このブラウザーでは全画面表示を利用できません";
  }
};
window.addEventListener("keydown", (e) => {
  if (!state.xr && creative?.getState().mode === "creative") {
    if (e.code === "Home" && state.ready && !document.querySelector("dialog[open]") &&
        !document.activeElement?.matches("input,textarea,select,button,[contenteditable=true]")) {
      e.preventDefault(); goTo("overview");
    }
    return;
  }
  if (
    document.querySelector("dialog[open]") ||
    document.activeElement?.matches(
      "input:not([type=checkbox]),textarea,select",
    )
  )
    return;
  if (
    [
      "KeyW",
      "KeyA",
      "KeyS",
      "KeyD",
      "KeyQ",
      "KeyE",
      "KeyR",
      "KeyF",
      "Home",
    ].includes(e.code)
  ) {
    e.preventDefault();
    keys.add(e.code);
  }
  if (e.code === "Home" && state.ready) goTo("overview");
});
window.addEventListener("keyup", (e) => keys.delete(e.code));
window.addEventListener("blur", () => {
  initialMovementInterrupted = true;
  keys.clear();
  resetFlight(flight);
  setFree(false);
  if (state.xr) { cancelExitHold(exitHold); vrReturnButton.update({ progress: 0 }); }
});
document.addEventListener("visibilitychange", () => {
  keys.clear();
  if (document.hidden) {
    initialMovementInterrupted = true; setFree(false);
    if (state.xr) { cancelExitHold(exitHold); vrReturnButton.update({ progress: 0 }); }
  }
});
// All dialogs (including workshop and auth) stop input without restarting it
// when closed. The initial desktop default never overrides an open modal.
new MutationObserver(() => {
  if (document.querySelector("dialog[open]")) {
    initialMovementInterrupted = true; setFree(false);
  }
}).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["open"] });
async function checkVR() {
  const button = $("#enter-vr");
  try {
    const supported =
      !!navigator.xr && (await navigator.xr.isSessionSupported("immersive-vr"));
    if (supported) {
      button.disabled = false;
      button.textContent = hasVRResume ? "VRに戻る" : "QuestでVRを見る";
      $("#vr-note").textContent =
        hasVRResume ? "今見ている場所から再開。移動はOFFです。" :
          "安全なプレイエリアで使用してください。まずは地点ボタンで見学。";
    } else {
      button.textContent = "QuestのブラウザーでVR体験";
      button.disabled = true;
      $("#vr-note").textContent =
        "この端末ではPC用3D表示を利用できます。VRはQuestで同じURLを開いてください。";
    }
  } catch {
    button.textContent = "VRを利用できません";
    $("#vr-note").textContent =
      "ブラウザーの権限設定とHTTPS接続を確認してください。";
  }
}
$("#enter-vr").onclick = async () => {
  try {
    if (!state.ready || state.qualityLoading || state.xr || xrEntering) return;
    xrEntering = true;
    $("#control-mode").disabled = true;
    setFree(false);
    pendingXRView = resolveXREntryView(creative.getState().mode, hasVRResume, restoredWorld,
      () => creative.captureForXR(), () => captureView(camera));
    $("#enter-vr").disabled = true;
    const session = await navigator.xr.requestSession("immersive-vr", {
      optionalFeatures: ["local-floor"],
    });
    await renderer.xr.setSession(session);
  } catch (e) {
    $("#vr-note").textContent =
      "VRを開始できませんでした。権限を確認して、もう一度押してください。";
    $("#enter-vr").disabled = false;
    console.warn("XR request rejected", e.name);
    if (creative.getState().mode === "creative") creative.restoreAfterXR(pendingXRView);
    pendingXRView = null;
  } finally {
    xrEntering = false;
    if (!state.xr) $("#control-mode").disabled = false;
  }
};
renderer.xr.addEventListener("sessionstart", () => {
  hideControllerPointers();
  simulationSeconds = 0;
  state.xr = true;
  $("#control-mode").disabled = true;
  setFree(false);
  controllerHud.setXR(true);
  $("#quality-select").disabled = true;
  $("#quality-note").textContent = `${quality.label} · 画質変更は2D画面に戻ってから。`;
  resetFlight(flight);
  previousButtons.clear();
  cancelExitHold(exitHold);
  xrExitPending = false; lastXRView = null;
  vrReturnButton.update({ progress: 0, exiting: false, hovered: false });
  vrReturnButton.setVisible(true);
  const session = renderer.xr.getSession();
  session.addEventListener("visibilitychange", () => {
    if (session.visibilityState !== "visible") { setFree(false); hideControllerPointers(); }
    cancelExitHold(exitHold); vrReturnButton.update({ progress: 0 });
    syncButtons(session);
  });
  session.addEventListener("inputsourceschange", () => {
    hideControllerPointers();
    setFree(false);
    cancelExitHold(exitHold); vrReturnButton.update({ progress: 0 });
    syncButtons(session);
  });
  controls.enabled = false;
  keys.clear(); touchControls.releaseAll(); adaptiveUi.close();
  camera.position.set(0, 0, 0);
  camera.rotation.set(0, 0, 0);
  rig.position.set(195, 74.4, 105);
  rig.rotation.set(0, 0.95, 0);
  vrFieldPanel.setExpanded(true);
  drawPanel();
  updateLabels(pendingXRView ? state.current : "east");
});
renderer.xr.addEventListener("sessionend", () => {
  hideControllerPointers();
  const view = resolveXRExitView(pendingXRView, lastXRView, () => captureView(camera));
  state.xr = false;
  hasVRResume = true; xrExitPending = false; pendingXRView = null;
  cancelExitHold(exitHold);
  vrReturnButton.setVisible(false);
  vrReturnButton.update({ progress: 0, exiting: false, hovered: false });
  controllerHud.setXR(false);
  vrWorkshop.cancelPicking();
  vrWorkshop.update({ xr: false });
  $("#quality-select").disabled = false;
  $("#quality-note").textContent = quality.hint;
  controls.enabled = true;
  keys.clear();
  previousButtons.clear();
  resetFlight(flight);
  camera.fov = 55;
  camera.zoom = 1;
  setFree(false);
  restoreDesktopView(view);
  creative.restoreAfterXR(view);
  $("#control-mode").disabled = false;
  lastXRView = view;
  updateLabels(state.current);
  $("#status").textContent = "2Dで観察中 · 移動OFF · VRに戻れます";
  $("#vr-note").textContent = "今見ている場所から再開。移動はOFFです。";
  resize();
  checkVR();
});

// Controller inputs remain shared with the desktop preview, while VR draws them
// inside the single central field-note texture.
const controllerHud = createControllerHud(THREE, camera, viewport, { spatial: false });
const regionMapRect = fieldRegionMapRect;
vrFieldPanel = createVRFieldPanel(THREE, { camera, controllerHud, vrWorkshop,
  getViewState: () => ({ free: state.free, regionReady: Boolean(regionManifest),
    horizontalSpeed: flight.horizontalSpeed, verticalSpeed: flight.verticalSpeed }),
  drawMap: (context, rect) => {
    if (regionManifest) drawRegionMap(context, rect, regionManifest, userPosition(), coreBounds());
  },
  onAction: (action, { x, y, rect }) => {
    if (action === "return") return returnTo2D();
    if (action === "free") { setFree(!state.free); return; }
    if (action === "map" && regionManifest) {
      const point = mapToWorld((x - rect.x) / rect.w, (y - rect.y) / rect.h, regionManifest.bounds);
      visitRegionPoint(point.x, point.z); return;
    }
    goTo(action === "region-east" ? "east" : action);
  },
});
panel = vrFieldPanel.mesh;
function drawPanel() {
  vrFieldPanel?.update({ xr: state.xr, interactive: !xrExitPending && !pendingXRView &&
    renderer.xr.getSession()?.visibilityState === "visible" });
}
for (let i = 0; i < 2; i++) {
  const controller = renderer.xr.getController(i);
  controller.addEventListener("connected", (event) => { controller.userData.handedness = event.data.handedness; });
  controller.addEventListener("disconnected", () => {
    controllerPointers[controller.userData.handedness]?.hide();
    controller.userData.handedness = null; vrWorkshop.cancelPicking();
  });
  controller.addEventListener("selectstart", () => {
    const session = renderer.xr.getSession(), source = trackedControllerSource(controller, session);
    if (!controllerInteractionActive(session) || !source || !setControllerRay(controller)) return;
    // Never use the previous frame's hover: this is the current physical target ray.
    const hand = source.handedness, hit = vrFieldPanel.hit(controllerRaycaster, { handedness: hand });
    updateControllerPointer(controller, source, hit, performance.now());
    if (hit) {
      if (hit.action) {
        if (vrFieldPanel.getState().tab === "workshop" && !hit.action.startsWith("tab-") && hit.action !== "return") setFree(false);
        Promise.resolve(vrFieldPanel.activate(hit.action, { x: hit.x, y: hit.y,
          handedness: hand })).then(accepted => {
            if (accepted) acceptedControllerSelection(controller, source, session);
          }).catch(() => {});
      }
      // The visible surface consumes blank/disabled hits as well, preventing
      // a panel click from selecting or placing an object behind the canvas.
      return;
    }
    if (workshop.getState().canEdit) {
      if (vrWorkshop.getState().picking) {
        // Placement uses only verified station-core DEM, never roofs or a fake plane.
        const terrainHit = controllerRaycaster.intersectObjects(placementEnvironment.terrainMeshes, false)[0];
        if (terrainHit && workshop.moveSelected(terrainHit.point.toArray()).valid) {
          Promise.resolve(vrWorkshop.activate("picked")).then(accepted => {
            if (accepted) acceptedControllerSelection(controller, source, session);
          }).catch(() => {});
        }
        return;
      }
      const objectHit = controllerRaycaster.intersectObjects(workshop.group.children, false)[0];
      if (objectHit?.object.userData.creationId) {
        setFree(false);
        if (workshop.selectObject(objectHit.object.userData.creationId)) acceptedControllerSelection(controller, source, session);
      }
    }
  });
  rig.add(controller);
  controllers.push(controller);
}
function syncButtons(session) {
  previousButtons.clear();
  for (const source of session.inputSources) {
    for (const index of [4, 5]) {
      previousButtons.set(source.handedness + ":" + index,
        !!source.gamepad?.buttons[index]?.pressed);
    }
  }
}
function justPressed(source, index) {
  const key = source.handedness + ":" + index,
    value = !!source.gamepad?.buttons[index]?.pressed,
    last = previousButtons.get(key);
  previousButtons.set(key, value);
  return value && !last;
}
function xrMove(dt, now) {
  const session = renderer.xr.getSession();
  if (!session) return;
  simulationSeconds += dt;
  if (session.visibilityState !== "visible") {
    if (state.free) setFree(false);
    cancelExitHold(exitHold); vrReturnButton.update({ progress: 0, hovered: false });
    return;
  }
  if (xrExitPending || pendingXRView) return;
  const leftSource = [...session.inputSources].find((source) => source.handedness === "left" && source.gamepad);
  const action = updateExitHold(exitHold, { pressed: Boolean(leftSource?.gamepad.buttons[4]?.pressed),
    available: Boolean(leftSource), now });
  vrReturnButton.update({ progress: action.progress });
  if (action.toggleGuide) vrFieldPanel.toggleExpanded();
  if (action.exit) { returnTo2D(); return; }
  let left = [0, 0],
    right = [0, 0];
  for (const source of session.inputSources) {
    if (!source.gamepad) continue;
    if (source.handedness === "left") {
      left = stickAxes(source.gamepad);
      if (justPressed(source, 5)) goTo("east");
    }
    if (source.handedness === "right") {
      right = stickAxes(source.gamepad);
      if (justPressed(source, 5)) setFree(!state.free);
      if (justPressed(source, 4)) {
        const ids = Object.keys(viewpoints);
        goTo(ids[(ids.indexOf(state.current) + 1) % ids.length]);
      }
    }
  }
  if (!state.free) {
    resetFlight(flight);
    return;
  }
  const movement = updateFlight(flight, { left, right }, dt);
  const head = camera;
  // Yaw about the viewer, not the origin: room-scale head offsets must not orbit.
  if (movement.yaw) {
    head.getWorldPosition(temp);
    const offset = rig.position.clone().sub(temp);
    const yaw = movement.yaw * dt;
    rig.rotation.y += yaw;
    offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    rig.position.copy(temp).add(offset);
    rig.updateMatrixWorld(true);
  }
  // Drone heading is independent of looking around or looking straight up/down.
  temp.set(0, 0, -1).applyQuaternion(rig.quaternion);
  const side = new THREE.Vector3(-temp.z, 0, temp.x);
  rig.position
    .addScaledVector(temp, movement.forward * dt)
    .addScaledVector(side, movement.strafe * dt);
  rig.position.y += movement.rise * dt;
  constrainPosition(rig.position);
}
function desktopMove(dt) {
  if (!state.free || document.querySelector("dialog[open]") || workshop.getState().picking) { resetFlight(flight); return; }
  if (adaptiveUi.getState().mobile && adaptiveUi.getState().open) {
    resetFlight(flight); return;
  }
  const touchInput = touchControls.getState();
  // A compact layout does not imply a touch-only device. Keep keyboards usable
  // in small desktop windows; an actively held virtual stick takes precedence.
  if (touchInput.enabled && (touchInput.activePointers > 0 || keys.size === 0)) {
    const raw = touchControls.getAxes();
    const movement = updateFlight(flight, {
      left: stickAxes({ axes: raw.left }), right: stickAxes({ axes: raw.right }),
    }, dt);
    const facing = controls.target.clone().sub(camera.position);
    facing.y = 0;
    if (facing.lengthSq() < 0.00001) facing.set(0, 0, -1);
    facing.normalize();
    const side = new THREE.Vector3(-facing.z, 0, facing.x);
    const delta = facing.multiplyScalar(movement.forward * dt).addScaledVector(side, movement.strafe * dt);
    delta.y = movement.rise * dt;
    const before = camera.position.clone();
    camera.position.add(delta);
    if (delta.lengthSq() > 0) constrainPosition(camera.position);
    controls.target.add(camera.position.clone().sub(before));
    if (movement.yaw) {
      const direction = controls.target.clone().sub(camera.position).applyAxisAngle(new THREE.Vector3(0, 1, 0), movement.yaw * dt);
      controls.target.copy(camera.position).add(direction);
    }
    return;
  }
  camera.getWorldDirection(temp);
  temp.y = 0;
  temp.normalize();
  const side = new THREE.Vector3(-temp.z, 0, temp.x);
  const delta = new THREE.Vector3()
    .addScaledVector(
      temp,
      ((keys.has("KeyW") ? 1 : 0) - (keys.has("KeyS") ? 1 : 0)) * dt * 12,
    )
    .addScaledVector(
      side,
      ((keys.has("KeyD") ? 1 : 0) - (keys.has("KeyA") ? 1 : 0)) * dt * 12,
    );
  delta.y = ((keys.has("KeyR") ? 1 : 0) - (keys.has("KeyF") ? 1 : 0)) * dt * 8;
  const before = camera.position.clone();
  camera.position.add(delta);
  if (delta.lengthSq() > 0) constrainPosition(camera.position);
  controls.target.add(camera.position.clone().sub(before));
  const yaw =
    ((keys.has("KeyQ") ? 1 : 0) - (keys.has("KeyE") ? 1 : 0)) * dt * 0.6;
  if (yaw) {
    const d = controls.target
      .clone()
      .sub(camera.position)
      .applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    controls.target.copy(camera.position).add(d);
  }
}
renderer.setAnimationLoop((time, frame) => {
  const dt = Math.min(Math.max((time - frameTime) / 1000, 0), 0.05);
  frameTime = time;
  if (state.ready) {
    syncTouchControls();
    if (state.xr) {
      creative.step(0, { xr: true, enabled: false });
      if (pendingXRView && frame) {
        const pose = frame.getViewerPose(renderer.xr.getReferenceSpace());
        if (pose) {
          alignRigToView(rig, pendingXRView, pose.transform);
          pendingXRView = null;
        }
      }
      xrMove(dt, time);
    }
    else {
      const touch = touchControls.getState();
      creative.step(dt, { enabled: state.free, xr: false,
        touchAxes: touch.enabled && touch.activePointers > 0 ? touchControls.getAxes() : null,
        blocked: Boolean(document.querySelector("dialog[open]")) || workshop.getState().picking ||
          (adaptiveUi.getState().mobile && adaptiveUi.getState().open) });
      if (creative.getState().mode === "drone") { desktopMove(dt); controls.update(); }
      const dir = camera.getWorldDirection(new THREE.Vector3());
      $("#north span").style.transform =
        `rotate(${Math.atan2(dir.x, -dir.z)}rad)`;
    }
    regionStreamer.update(userPosition(), quality.id, time);
    adoptSchoolPose();
    if (schoolState.user && schoolState.world && schoolState.connection === "connected" &&
        restoredWorld === schoolState.world.id && !pendingXRView && !document.hidden &&
        (!state.xr || renderer.xr.getSession()?.visibilityState === "visible")) {
      const yaw = !state.xr && creative.getState().mode === "creative" ? creative.getState().yaw :
        new THREE.Euler().setFromQuaternion(camera.getWorldQuaternion(new THREE.Quaternion()), "YXZ").y;
      schoolClient.sendPose({ position: userPosition().toArray(), yaw });
    }
    presence.update(dt);
    if (!schoolState.user) ownAvatar.group.visible = false;
    syncAvatarViewButtons();
    if ((state.free || state.current === "region") && time > nextGroundCheck) {
      nextGroundCheck = time + 150;
      const p = camera.getWorldPosition(new THREE.Vector3());
      raycaster.set(new THREE.Vector3(p.x, 2500, p.z), down);
      const hit = raycaster.intersectObjects([...city.children, ...regionStreamer.getMeshes()], false)[0];
      ground = hit?.point.y ?? 16.5;
    }
    if ((state.free || state.current === "region") && (state.xr || creative.getState().mode === "drone")) {
      const p = state.xr ? rig.position : camera.position;
      if (p.y < ground + 2) {
        const delta = ground + 2 - p.y;
        p.y += delta;
        if (!state.xr) controls.target.y += delta;
      }
    }
  }
  if (regionManifest && time - regionUiTime > 1000) {
    regionUiTime = time;
    drawDesktopRegionMap();
    const status = regionStreamer.getState();
    $("#region-stream-status").textContent = `${status.resident}区画表示 · ${status.loading}読込中${status.errors ? " · 一部取得待ち" : ""} · 広域は軽量LOD1`;
  }
  controllerHud.update(renderer.xr.getSession()?.inputSources,
    { free: state.free, flight }, time);
  const session = renderer.xr.getSession(), panelInteractive = controllerInteractionActive(session);
  vrFieldPanel.update({ xr: state.xr, interactive: panelInteractive, time });
  let panelHover = null, leftSeen = false, rightSeen = false;
  hoveredHands.left = hoveredHands.right = null;
  if (panelInteractive) {
    for (const controller of controllers) {
      const source = trackedControllerSource(controller, session);
      if (!source || !setControllerRay(controller)) continue;
      const hand = source.handedness, hit = vrFieldPanel.hit(controllerRaycaster, { handedness: hand });
      if (updateControllerPointer(controller, source, hit, time)) {
        if (hand === "left") leftSeen = true; else rightSeen = true;
        hoveredHands[hand] = hit?.action ?? null;
      }
    }
    panelHover = hoveredHands.left === "return" || hoveredHands.right === "return" ? "return" :
      hoveredHands.right ?? hoveredHands.left;
  }
  if (!leftSeen) controllerPointers.left.hide();
  if (!rightSeen) controllerPointers.right.hide();
  vrFieldPanel.update({ xr: state.xr, interactive: panelInteractive, hovered: panelHover, hoveredHands, time });
  renderer.render(scene, camera);
  if (panelInteractive && frame) {
    const viewerPose = frame.getViewerPose(renderer.xr.getReferenceSpace());
    if (viewerPose) lastXRView = captureXRView(rig, viewerPose.transform);
  }
});
renderer.domElement.addEventListener("webglcontextlost", (e) => {
  e.preventDefault();
  fail(
    new Error(
      "3D表示が中断されました。ほかのタブを閉じて再読み込みしてください。",
    ),
  );
});
// Read-only diagnostics used by local and deployed acceptance checks.
window.__okazaki = {
  getState: () => ({
    ...state,
    school: schoolClient.getState(),
    presence: presence.getState(),
    vrWorkshop: vrWorkshop.getState(),
    workshop: workshop.getState(),
    creative: creative.getState(),
    avatar: ownAvatar.getState(),
    camera: camera.position.toArray(),
    cameraQuaternion: camera.quaternion.toArray(),
    rig: rig.position.toArray(),
    rigYaw: rig.rotation.y,
    head: state.xr
      ? camera.getWorldPosition(new THREE.Vector3()).toArray()
      : null,
    panelVisible: panel.visible && vrFieldPanel.getState().expanded,
    vrPanel: vrFieldPanel.getState(),
    pointers: { left: controllerPointers.left.getState(), right: controllerPointers.right.getState() },
    version: "1.7.0",
    vrReturn: { buttonVisible: vrReturnButton.getState().visible,
      holdProgress: vrReturnButton.getState().progress, exiting: xrExitPending,
      hasResume: hasVRResume, view: lastXRView ? {
        position: [...lastXRView.position], quaternion: [...lastXRView.quaternion],
      } : null,
      button: vrReturnButton.getState(), pendingResume: Boolean(pendingXRView), entering: xrEntering },
    ui: adaptiveUi.getState(),
    touch: touchControls.getState(),
    guide: { position: panel.position.toArray(), size: vrFieldPanel.getState().size },
    hud: controllerHud.getState(),
    quality: { ...quality, terrainFile, shadows: renderer.shadowMap.enabled,
      terrainSize: terrainMesh?.material.map?.image
        ? [terrainMesh.material.map.image.width, terrainMesh.material.map.image.height] : null,
      outline: quality.id !== "performance" },
    simulationSeconds,
    region: { ...regionStreamer.getState(), ready: state.regionReady,
      bounds: regionManifest?.bounds ?? null, geographicBounds: regionManifest?.geographicBounds ?? null,
      availableBuildings: regionManifest?.buildings.length ?? 0,
      availableTerrain: regionManifest?.terrain.length ?? 0,
      sourceTriangles: regionManifest?.totalTriangles ?? 0,
      panelMap: vrFieldPanel.getState().tab === "region", mapRect: { ...regionMapRect },
      terrainHeights: regionStreamer.getGroundMeshes().map((mesh) => ({
        id: mesh.userData.regionTileId, ...mesh.userData.heightStats,
      })),
      profile: { ...regionProfiles[quality.id] } },
    flight: {
      horizontalSpeed: flight.horizontalSpeed,
      verticalSpeed: flight.verticalSpeed,
      config: { ...flightConfig },
    },
    target: controls.target.toArray(),
    render: {
      calls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
    },
    assetSource: "PLATEAU 23202 2020",
  }),
};
goTo("overview");
loadCity().catch((error) =>
  fail(
    new Error(
      error.name === "TimeoutError"
        ? "読み込みに時間がかかっています。通信を確認して再読み込みしてください。"
        : error.message === "Failed to fetch"
          ? "モデルを取得できません。通信を確認して再読み込みしてください。"
          : error.message,
    ),
  ),
);
