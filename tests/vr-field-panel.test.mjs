import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createVRFieldPanel, vrFieldPanelLayout } from "../src/vr-field-panel.js";
import { createControllerHud } from "../src/controller-hud.js";
import { createVRWorkshop } from "../src/vr-workshop.js";

function fixture() {
  const paintEvents = [], allocations = {};
  let currentRect = null;
  const context = new Proxy({}, { get(target, name) {
    if (name === "roundRect") return (...values) => { currentRect = values.slice(0, 4); };
    if (name === "stroke") return () => paintEvents.push({ rect: currentRect, color: target.strokeStyle });
    return target[name] ?? (() => {});
  }, set(target, name, value) { target[name] = value; return true; } });
  const tracedThree = { ...THREE };
  for (const name of ["CanvasTexture", "PlaneGeometry", "MeshBasicMaterial", "Mesh"]) {
    allocations[name] = 0;
    tracedThree[name] = new Proxy(THREE[name], { construct(target, args, newTarget) {
      allocations[name]++; return Reflect.construct(target, args, newTarget);
    } });
  }
  const documentTarget = { createElement: () => ({ style: {}, hidden: false,
    setAttribute() {}, append() {}, getContext: () => context }) };
  const originalDocument = globalThis.document;
  globalThis.document = documentTarget;
  const camera = new THREE.PerspectiveCamera(), viewport = { children: [], append(child) { this.children.push(child); } };
  const hud = createControllerHud(tracedThree, camera, viewport, { spatial: false });
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
  let state = { user: { id: "own", role: "student" }, world: { id: "class" }, connection: "connected" };
  let workshopState = { canEdit: true, busy: false, ownAssets: [{ id: "asset" }],
    current: { id: "creation", ownerId: "own", editable: true, valid: true,
      committed: false, rotation: [0, 0, 0], scale: [1, 1, 1] } };
  const calls = [], workshop = { getState: () => workshopState,
    cycleOwnAsset: () => { calls.push("asset"); return true; },
    adjustSelected: () => { calls.push("adjust"); return true; },
    commitSelected: () => { calls.push("commit"); return true; },
    cancelDraft: () => { calls.push("cancel"); return true; } };
  const vrWorkshop = createVRWorkshop(tracedThree, { camera, workshop, client: { getState: () => state },
    documentTarget, embedded: true });
  let view = { free: false, regionReady: true };
  const panel = createVRFieldPanel(tracedThree, { camera, controllerHud: hud, vrWorkshop, documentTarget,
    getViewState: () => view, onAction: (action, details) => calls.push({ action, details }) });
  hud.setXR(true); panel.update({ xr: true, interactive: true, time: 1000 });
  return { panel, camera, hud, vrWorkshop, workshop, viewport, calls, paintEvents, allocations,
    setState: (next) => { state = { ...state, ...next }; },
    setWorkshop: (next) => { workshopState = { ...workshopState, ...next }; },
    setView: (next) => { view = { ...view, ...next }; },
    center(action) { const rect = panel.getState().actionRects[action]; return [rect.x + rect.w / 2, rect.y + rect.h / 2]; },
    cleanup() { panel.dispose(); vrWorkshop.dispose(); } };
}

test("all VR UI shares one centered mesh, while PC controller preview canvases remain available", () => {
  const f = fixture();
  assert.equal(f.camera.children.length, 1);
  assert.equal(f.camera.children[0], f.panel.mesh);
  assert.equal(f.vrWorkshop.meshes.length, 0);
  assert.equal(f.viewport.children.length, 2);
  const state = f.panel.getState();
  assert.deepEqual(state.position, [0, 0, -1.8]);
  assert.deepEqual(state.size, [...vrFieldPanelLayout.size]);
  assert.deepEqual(state.canvas, [1280, 1024]);
  assert.equal(state.panelCount, 1);
  for (const hand of ["left", "right"]) {
    assert.equal(f.hud.getState().hands[hand].spatialVisible, false);
    assert.equal(f.hud.getState().hands[hand].embeddedVisible, true);
  }
  f.hud.setXR(false); f.panel.update({ xr: false, time: 1100 });
  assert.ok(f.viewport.children.every((child) => !child.hidden));
  assert.equal(f.panel.getState().panelCount, 0);
  f.cleanup();
});

test("primary button surfaces have deliberate gaps, larger physical targets, and match their ray hit rects", () => {
  const f = fixture(), state = f.panel.getState();
  for (const entry of state.actions) {
    assert.ok(entry.x >= 0 && entry.y >= 0 && entry.x + entry.w <= state.canvas[0] && entry.y + entry.h <= state.canvas[1]);
    assert.ok(entry.h / state.canvas[1] * state.size[1] >= .08);
    assert.equal(f.panel.actionAt(...f.center(entry.action)), entry.action);
  }
  assert.equal(f.panel.actionAt(436, 240), null, "the gap between east and overview is not clickable");
  assert.ok(state.hudRects.left.y >= state.actionRects.free.y + state.actionRects.free.h);
  const ray = new THREE.Raycaster();
  ray.set(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, -.44, -1.8).normalize());
  assert.equal(f.panel.hit(ray).action, "return");
  const exit = f.panel.getReturnState();
  assert.ok(exit.size[1] >= .16, "return button is at least the previous standalone physical height");
  assert.ok(exit.size[0] * exit.size[1] > .82 * .16, "return button area also increases");
  f.panel.update({ hovered: "east", time: 1200 });
  assert.equal(f.panel.getState().hovered, "east");
  const detached = f.panel.getState(); detached.actionRects.east.x = -1;
  assert.equal(f.panel.getState().actionRects.east.x, 448);
  f.cleanup();
});

test("2D return persists in every tab, compact mode and region loading; collapse keeps the same mesh", async () => {
  const f = fixture(), mesh = f.panel.mesh;
  for (const tab of ["observe", "region", "workshop"]) {
    f.panel.selectTab(tab);
    assert.equal(f.panel.actionAt(...f.center("return")), "return");
    assert.equal(await f.panel.activate("return"), true);
  }
  f.setView({ regionReady: false }); f.panel.selectTab("region");
  assert.equal(f.panel.getState().actionRects.map.enabled, false);
  assert.equal(f.panel.actionAt(...f.center("map")), null);
  assert.equal(f.panel.actionAt(...f.center("return")), "return");
  f.panel.selectTab("workshop"); f.panel.toggleExpanded();
  assert.equal(f.panel.mesh, mesh); assert.equal(f.camera.children.length, 1);
  assert.deepEqual(f.panel.getState().canvas, [1280, 384]);
  assert.equal(f.panel.getState().size[0], 1.4);
  assert.ok(Math.abs(f.panel.getState().size[1] - .42) < 1e-9);
  assert.equal(f.panel.getState().actions.length, 2);
  assert.equal(f.panel.actionAt(...f.center("expand"), { handedness: "left" }), "expand");
  assert.equal(f.panel.actionAt(...f.center("return")), "return");
  assert.equal(f.vrWorkshop.getState().visible, false);
  assert.equal(f.hud.getState().hands.left.embeddedVisible, false);
  assert.equal(await f.panel.activate("expand"), true);
  assert.equal(f.panel.getState().expanded, true);
  f.cleanup();
});

test("progress and exit updates never re-enable interaction after focus/input loss or pending entry", () => {
  const f = fixture();
  f.panel.update({ interactive: false, time: 1300 });
  f.panel.update({ progress: .3, time: 1400 });
  assert.equal(f.panel.getState().interactive, false);
  assert.equal(f.panel.actionAt(...f.center("return")), null);
  f.panel.update({ exiting: true, time: 1500 });
  f.panel.update({ exiting: false, progress: 0, time: 1600 });
  assert.equal(f.panel.getState().interactive, false);
  f.panel.update({ xr: false, time: 1700 });
  f.panel.update({ xr: true, time: 1800 });
  assert.equal(f.panel.getState().interactive, false, "entry waits for the caller's validated XR frame");
  f.panel.update({ interactive: true, time: 1900 });
  assert.equal(f.panel.actionAt(...f.center("return")), "return");
  f.cleanup();
});

test("both workshop hands retain live guest, room, owner and pending-server gates", async () => {
  const f = fixture(); f.panel.selectTab("workshop");
  assert.equal(f.vrWorkshop.getState().embedded, true);
  assert.equal(f.vrWorkshop.getState().spatialVisible, false);
  const position = f.center("rotate-x+");
  assert.equal(f.panel.actionAt(...position), "rotate-x+");
  assert.equal(f.panel.actionAt(...position, { handedness: "left" }), "rotate-x+");
  assert.equal(await f.panel.activate("rotate-x+", { handedness: "left" }), true);
  assert.equal(f.panel.actionAt(...position, { handedness: "none" }), null);
  assert.equal(await f.panel.activate("rotate-x+", { handedness: "none" }), false);
  assert.equal(await f.panel.activate("rotate-x+"), true);
  f.setWorkshop({ current: { id: "other", ownerId: "peer", editable: true, valid: true } });
  for (const handedness of ["left", "right"]) {
    assert.equal(f.panel.actionAt(...position, { handedness }), null);
    assert.equal(await f.panel.activate("rotate-x+", { handedness }), false);
  }
  f.setWorkshop({ current: { id: "own", ownerId: "own", valid: true } });
  f.setState({ connection: "reconnecting" });
  assert.equal(await f.panel.activate("rotate-x+", { handedness: "left" }), false);
  f.setState({ connection: "connected", world: null });
  assert.equal(f.panel.actionAt(...position, { handedness: "left" }), null);
  f.setState({ world: { id: "class" } });
  let resolve;
  f.workshop.commitSelected = () => new Promise((done) => { resolve = done; });
  const pending = f.panel.activate("commit", { handedness: "left" });
  assert.equal(f.vrWorkshop.getState().pending, true);
  assert.equal(f.panel.actionAt(...position), null);
  assert.equal(await f.panel.activate("commit"), false);
  f.setState({ user: null }); resolve(true);
  assert.equal(await pending, false);
  assert.equal(await f.panel.activate("asset-next"), false);
  assert.equal(f.panel.actionAt(...f.center("return")), "return");
  f.cleanup();
});

test("each hand highlights its own exact button rect and both outlines survive on one target", () => {
  const f = fixture();
  f.paintEvents.length = 0;
  f.panel.update({ hovered: "west", hoveredHands: { left: "east", right: "west" }, time: 2000 });
  let state = f.panel.getState();
  assert.equal(state.hovered, "west", "legacy diagnostic remains available");
  assert.deepEqual(state.hoveredActions, ["east", "west"]);
  assert.equal(state.perHand.left.hovered, "east");
  assert.equal(state.perHand.right.hovered, "west");
  for (const [hand, color, inset, action] of [["left", "#6fe7ff", 3, "east"], ["right", "#ffce75", 8, "west"]]) {
    const rect = state.actionRects[action];
    assert.ok(f.paintEvents.some((event) => event.color === color &&
      event.rect[0] === rect.x + inset && event.rect[1] === rect.y + inset &&
      event.rect[2] === rect.w - inset * 2 && event.rect[3] === rect.h - inset * 2), `${hand} has its own visible outline`);
  }
  state.hoveredHands.left = "return"; state.perHand.right.hovered = "return";
  assert.equal(f.panel.getState().perHand.left.hovered, "east", "diagnostics cannot mutate live slots");
  f.paintEvents.length = 0;
  f.panel.update({ hoveredHands: { left: "east", right: "east" }, time: 2100 });
  assert.deepEqual(f.panel.getState().hoveredActions, ["east"]);
  assert.ok(f.paintEvents.some((event) => event.color === "#6fe7ff"));
  assert.ok(f.paintEvents.some((event) => event.color === "#ffce75"));
  f.panel.update({ hoveredHands: { left: null, right: "west" }, time: 2200 });
  assert.equal(f.panel.getState().perHand.left.hovered, null);
  assert.equal(f.panel.getState().perHand.right.hovered, "west");
  assert.equal(f.panel.actionAt(436, 240, { handedness: "left" }), null, "highlights add no click padding");
  f.cleanup();
});

test("both embedded workshop highlights clear immediately when live permissions disable actions", () => {
  const f = fixture(); f.panel.selectTab("workshop"); f.paintEvents.length = 0;
  f.panel.update({ hoveredHands: { left: "rotate-x+", right: "scale+" }, time: 2000 });
  assert.deepEqual(f.panel.getState().hoveredActions, ["rotate-x+", "scale+"]);
  for (const color of ["#6fe7ff", "#ffce75"]) assert.ok(f.paintEvents.some((event) => event.color === color));
  f.setState({ user: null });
  f.panel.update({ hoveredHands: { left: "rotate-x+", right: "scale+" }, time: 2100 });
  assert.deepEqual(f.panel.getState().hoveredActions, []);
  assert.equal(f.panel.getState().hovered, null);
  f.cleanup();
});

test("accepted clicks flash for a bounded interval without a frame-by-frame canvas animation", async () => {
  const f = fixture();
  f.panel.update({ hoveredHands: { left: "east", right: "west" }, time: 2000 });
  assert.equal(await f.panel.activate("east", { handedness: "left" }), true);
  assert.equal(f.panel.getState().perHand.left.flashAction, "east");
  assert.equal(f.panel.getState().perHand.left.flashUntil, 2180);
  f.panel.update({ time: 2070 });
  const flashedDraw = f.panel.getState().redraws;
  for (let time = 2071; time < 2180; time += 11) f.panel.update({ time });
  assert.equal(f.panel.getState().redraws, flashedDraw, "the flash key has no continuous fade value");
  f.panel.update({ time: 2180 });
  assert.equal(f.panel.getState().perHand.left.flashAction, null);
  assert.equal(f.panel.getState().redraws, flashedDraw + 1);
  assert.equal(await f.panel.activate("west", { handedness: "right" }), true);
  f.panel.update({ interactive: false, time: 2200 });
  assert.deepEqual(f.panel.getState().hoveredActions, []);
  assert.equal(f.panel.getState().perHand.right.flashAction, null);
  f.panel.update({ interactive: true, hoveredHands: { left: "east", right: "west" }, time: 2300 });
  await f.panel.activate("east", { handedness: "left" });
  f.panel.update({ exiting: true, time: 2400 });
  assert.deepEqual(f.panel.getState().hoveredActions, []);
  assert.equal(f.panel.getState().perHand.left.flashAction, null);
  f.panel.update({ exiting: false, xr: false, time: 2500 });
  assert.deepEqual(f.panel.getState().hoveredActions, []);
  f.cleanup();
});

test("two rays allocate no new spatial resources and their dirty redraws remain capped at 15 Hz", () => {
  const f = fixture(), allocations = { ...f.allocations };
  assert.deepEqual(allocations, { CanvasTexture: 1, PlaneGeometry: 1, MeshBasicMaterial: 1, Mesh: 1 });
  f.panel.update({ hoveredHands: { left: "east", right: "west" }, time: 2000 });
  const first = f.panel.getState().redraws;
  for (let time = 2001; time <= 3000; time++) f.panel.update({
    hoveredHands: { left: time % 2 ? "overview" : "east", right: time % 3 ? "west" : "free" }, time });
  assert.ok(f.panel.getState().redraws - first <= vrFieldPanelLayout.maxRefreshHz);
  assert.deepEqual(f.allocations, allocations);
  assert.equal(f.camera.children.length, 1);
  f.cleanup();
});

test("disabled and blank panel hits remain consumed, and lost interactivity cancels placement picking", async () => {
  const f = fixture(); f.panel.selectTab("workshop");
  assert.equal(await f.panel.activate("pick"), true);
  assert.equal(f.vrWorkshop.getState().picking, true);
  f.panel.update({ interactive: false, time: 1300 });
  assert.equal(f.vrWorkshop.getState().picking, false);
  const ray = new THREE.Raycaster(new THREE.Vector3(), new THREE.Vector3(0, 0, -1));
  const hit = f.panel.hit(ray);
  assert.ok(hit, "inactive panel surface must consume the world ray");
  assert.equal(hit.action, null);
  assert.equal(await f.panel.activate("return"), false);
  f.panel.update({ interactive: true, time: 1400 });
  await f.panel.activate("pick"); f.panel.selectTab("observe");
  assert.equal(f.vrWorkshop.getState().picking, false);
  f.panel.update({ exiting: true, time: 1500 });
  assert.equal(f.panel.getState().actionRects.return.enabled, false);
  assert.equal(await f.panel.activate("return"), false);
  f.cleanup();
});

test("neutral shared canvas drawing is stable and dirty changes are throttled", () => {
  const f = fixture();
  f.panel.update({ time: 1500 }); const initial = f.panel.getState().redraws;
  for (let i = 1; i <= 10; i++) f.panel.update({ time: 1500 + i * 100 });
  assert.equal(f.panel.getState().redraws, initial);
  f.panel.update({ hovered: "east", time: 2600 }); const changed = f.panel.getState().redraws;
  f.panel.update({ hovered: "west", time: 2601 });
  assert.equal(f.panel.getState().redraws, changed);
  f.panel.update({ hovered: "west", time: 2700 });
  assert.equal(f.panel.getState().redraws, changed + 1);
  f.cleanup();
});
