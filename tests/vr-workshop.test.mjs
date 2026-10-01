import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createVRWorkshopControl, createVRWorkshop, schoolEditingAllowed,
  vrWorkshopLayout } from "../src/vr-workshop.js";

function fixture() {
  const calls = []; let changes = 0;
  let state = { user: { id: "own", role: "student" }, world: { id: "class" }, connection: "connected" };
  let workshopState = { canEdit: true, busy: false, selected: "creation", ownAssets: [{ id: "asset" }],
    current: { id: "creation", ownerId: "own", editable: true, valid: true, committed: false,
      name: "object.stl", rotation: [0, 0, 0], scale: [1, 1, 1] } };
  const workshop = { getState: () => workshopState };
  for (const method of ["cycleOwnAsset", "adjustSelected", "commitSelected", "cancelDraft"]) {
    workshop[method] = (...args) => { calls.push({ method, args }); return true; };
  }
  const client = { getState: () => state };
  const options = { workshop, client, onShadowChange: () => { changes++; } };
  return { control: createVRWorkshopControl(options), options, workshop, calls,
    set: (next) => { state = { ...state, ...next }; },
    setWorkshop: (next) => { workshopState = { ...workshopState, ...next }; },
    state: () => state, workshopState: () => workshopState, changes: () => changes };
}

function documentFixture() {
  const c = { clearRect() {}, fillRect() {}, beginPath() {}, roundRect() {}, fill() {}, stroke() {}, fillText() {} };
  return { createElement(type) { assert.equal(type, "canvas"); return { getContext: () => c }; } };
}

test("guest and disconnected modes cannot execute any workshop action even if UI is forged enabled", async () => {
  for (const next of [{ user: null }, { user: { id: "own", role: "guest" } }, { world: null },
    { connection: "reconnecting" }, { connection: "offline" }]) {
    const f = fixture(); f.set(next);
    for (const action of ["asset-next", "rotate-x+", "rotate-y-", "scale+", "pick", "commit", "cancel", "picked"]) {
      assert.equal(await f.control.activate(action), false);
    }
    assert.equal(f.calls.length, 0); assert.equal(f.control.snapshot().picking, false);
  }
  const f = fixture(); f.setWorkshop({ canEdit: false });
  assert.equal(schoolEditingAllowed(f.state(), f.workshopState()), false);
  assert.equal(await f.control.activate("commit"), false);
});

test("VR offers own-asset cycling, all XYZ rotations, uniform scaling and server-backed commit/cancel only", async () => {
  const f = fixture();
  for (const action of ["asset-prev", "asset-next", "rotate-x-", "rotate-x+", "rotate-y-", "rotate-y+",
    "rotate-z-", "rotate-z+", "scale-", "scale+", "commit", "cancel"]) assert.equal(await f.control.activate(action), true);
  assert.deepEqual(f.calls.slice(0, 2), [{ method: "cycleOwnAsset", args: [-1] }, { method: "cycleOwnAsset", args: [1] }]);
  for (let i = 0; i < 6; i++) {
    const value = f.calls[i + 2].args[0]; assert.equal(value.axis, ["x", "x", "y", "y", "z", "z"][i]);
    assert.equal(value.radians, Math.PI / 12 * (i % 2 ? 1 : -1));
  }
  assert.deepEqual(f.calls[8].args, [{ scaleFactor: 0.9 }]); assert.deepEqual(f.calls[9].args, [{ scaleFactor: 1.1 }]);
  assert.equal(f.calls[10].method, "commitSelected"); assert.equal(f.calls[11].method, "cancelDraft");
  assert.equal(f.changes(), 12); assert.equal(await f.control.activate("delete-other"), false);
});

test("other students' selected objects are read-only; invalid/committed drafts cannot be committed", async () => {
  const f = fixture(), current = f.workshopState().current;
  f.setWorkshop({ current: { ...current, ownerId: "other", editable: true } });
  for (const action of ["rotate-x+", "scale-", "pick", "commit", "cancel"]) assert.equal(await f.control.activate(action), false);
  // Selecting a different owned asset remains possible while a peer's object is selected.
  assert.equal(await f.control.activate("asset-next"), true);
  f.setWorkshop({ current: { ...current, valid: false } }); assert.equal(await f.control.activate("commit"), false);
  f.setWorkshop({ current: { ...current, committed: true } }); assert.equal(await f.control.activate("commit"), false);
  f.setWorkshop({ ownAssets: [] }); assert.equal(await f.control.activate("asset-next"), false);
});

test("ground pick is a deliberate toggle, can be cleared after actual ray validation, and disappears on lost permission", async () => {
  const f = fixture(); assert.equal(await f.control.activate("picked"), false);
  assert.equal(await f.control.activate("pick"), true); assert.equal(f.control.snapshot().picking, true);
  assert.equal(await f.control.activate("picked"), true); assert.equal(f.control.snapshot().picking, false);
  await f.control.activate("pick"); await f.control.activate("pick"); assert.equal(f.control.snapshot().picking, false);
  await f.control.activate("pick"); f.set({ user: null }); assert.equal(f.control.snapshot().picking, false);
  assert.equal(f.calls.length, 0, "a HUD toggle must never synthesize ground or commit an object");
});

test("pending server acknowledgement prevents double presses; completion does not leak into another identity/room", async () => {
  const f = fixture(); let resolve;
  f.workshop.commitSelected = () => new Promise((done) => { resolve = done; });
  const promise = f.control.activate("commit");
  assert.equal(f.control.snapshot().pending, true); assert.equal(await f.control.activate("commit"), false);
  assert.equal(await f.control.activate("rotate-y+"), false);
  f.set({ world: { id: "new-class" } }); resolve(true);
  assert.equal(await promise, false); assert.equal(f.changes(), 0); assert.equal(f.control.snapshot().pending, false);
});

test("workshop errors do not become an unhandled controller rejection; disposal blocks all further actions", async () => {
  const f = fixture(); f.workshop.commitSelected = () => { throw new Error("internal private URL"); };
  assert.equal(await f.control.activate("commit"), false);
  assert.ok(f.control.snapshot().message.includes("接続")); assert.ok(!f.control.snapshot().message.includes("private"));
  f.control.dispose(); assert.equal(await f.control.activate("asset-next"), false);
});

test("one-plane VR HUD stays left of central view, separate from escape route and stick HUD; redraw is bounded", async () => {
  const f = fixture(), camera = new THREE.PerspectiveCamera(), hud = createVRWorkshop(THREE,
    { ...f.options, camera, documentTarget: documentFixture() });
  assert.equal(hud.meshes.length, 1); assert.equal(hud.meshes[0].renderOrder, 1000);
  const [x, y, z] = vrWorkshopLayout.position, [width, height] = vrWorkshopLayout.size;
  assert.ok(x + width / 2 < -0.2); assert.ok(y - height / 2 > -0.306);
  assert.equal(z, -1.8); assert.ok(y + height / 2 < 0.4);
  assert.equal(hud.getState().visible, false); assert.equal(await hud.activate("pick"), false);
  hud.update({ xr: true, hover: "pick", time: 1 }); const firstDraw = hud.getState().redraws;
  for (let i = 0; i < 9; i++) hud.update({ xr: true, hover: i % 2 ? "pick" : "scale+", time: 1 + i / 100 });
  assert.equal(hud.getState().redraws, firstDraw);
  hud.update({ xr: true, hover: "scale+", time: 1.2 }); assert.equal(hud.getState().redraws, firstDraw + 1);
  assert.equal(await hud.activate("pick"), true); assert.equal(hud.getState().picking, true);
  hud.update({ xr: false, time: 1.3 }); assert.equal(hud.getState().picking, false);
  let geoDisposals = 0; hud.meshes[0].geometry.addEventListener("dispose", () => geoDisposals++);
  hud.dispose(); hud.dispose(); assert.equal(geoDisposals, 1); assert.equal(camera.children.length, 0);
});

test("ray hit maps real panel UV to enabled action and never returns guest or foreign-object controls", () => {
  const f = fixture(), camera = new THREE.PerspectiveCamera(), hud = createVRWorkshop(THREE,
    { ...f.options, camera, documentTarget: documentFixture() });
  let uv = { x: 0.8, y: 1 - 335 / 552 };
  const raycaster = { intersectObject: () => [{ uv, distance: 1.8, point: new THREE.Vector3() }] };
  assert.equal(hud.hit(raycaster), null);
  hud.update({ xr: true, time: 1 }); assert.equal(hud.hit(raycaster).action, "pick");
  uv = { x: 0.5, y: 0.99 }; assert.equal(hud.hit(raycaster), null);
  f.set({ user: null }); uv = { x: 0.8, y: 1 - 335 / 552 }; assert.equal(hud.hit(raycaster), null);
  hud.dispose();
});
