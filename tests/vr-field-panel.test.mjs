import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createVRFieldPanel, vrFieldPanelLayout } from "../src/vr-field-panel.js";
import { createControllerHud } from "../src/controller-hud.js";
import { createVRWorkshop } from "../src/vr-workshop.js";

function fixture() {
  const context = new Proxy({}, { get: () => () => {}, set: () => true });
  const documentTarget = { createElement: () => ({ style: {}, hidden: false,
    setAttribute() {}, append() {}, getContext: () => context }) };
  const originalDocument = globalThis.document;
  globalThis.document = documentTarget;
  const camera = new THREE.PerspectiveCamera(), viewport = { children: [], append(child) { this.children.push(child); } };
  const hud = createControllerHud(THREE, camera, viewport, { spatial: false });
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
  const vrWorkshop = createVRWorkshop(THREE, { camera, workshop, client: { getState: () => state },
    documentTarget, embedded: true });
  let view = { free: false, regionReady: true };
  const panel = createVRFieldPanel(THREE, { camera, controllerHud: hud, vrWorkshop, documentTarget,
    getViewState: () => view, onAction: (action, details) => calls.push({ action, details }) });
  hud.setXR(true); panel.update({ xr: true, interactive: true, time: 1000 });
  return { panel, camera, hud, vrWorkshop, workshop, viewport, calls,
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

test("central workshop hit coordinates retain right-hand, guest, owner and pending-server gates", async () => {
  const f = fixture(); f.panel.selectTab("workshop");
  assert.equal(f.vrWorkshop.getState().embedded, true);
  assert.equal(f.vrWorkshop.getState().spatialVisible, false);
  const position = f.center("rotate-x+");
  assert.equal(f.panel.actionAt(...position), "rotate-x+");
  assert.equal(f.panel.actionAt(...position, { handedness: "left" }), null);
  assert.equal(await f.panel.activate("rotate-x+", { handedness: "left" }), false);
  assert.equal(await f.panel.activate("rotate-x+"), true);
  f.setWorkshop({ current: { id: "other", ownerId: "peer", editable: true, valid: true } });
  assert.equal(f.panel.actionAt(...position), null);
  assert.equal(await f.panel.activate("rotate-x+"), false);
  f.setWorkshop({ current: { id: "own", ownerId: "own", valid: true } });
  let resolve;
  f.workshop.commitSelected = () => new Promise((done) => { resolve = done; });
  const pending = f.panel.activate("commit");
  assert.equal(f.vrWorkshop.getState().pending, true);
  assert.equal(f.panel.actionAt(...position), null);
  assert.equal(await f.panel.activate("commit"), false);
  f.setState({ user: null }); resolve(true);
  assert.equal(await pending, false);
  assert.equal(await f.panel.activate("asset-next"), false);
  assert.equal(f.panel.actionAt(...f.center("return")), "return");
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
