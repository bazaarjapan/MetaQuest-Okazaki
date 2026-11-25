import test from "node:test";
import assert from "node:assert/strict";
import { workshopAccess, canEditWorkshopObject, createWorkshopScope, safeWorkshopTransform,
  sharedObjectOverlap } from "../src/workshop-access.js";
import * as THREE from "three";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
const compiled = await build({ stdin: { contents: 'export { createWorkshop } from "./src/workshop.js"; export { createSurfaceIndex } from "./src/placement.js";', resolveDir: fileURLToPath(new URL("../", import.meta.url)) },
  bundle: true, write: false, format: "esm", platform: "node", loader: { ".css": "empty" } });
const { createWorkshop, createSurfaceIndex } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);
const connected = () => ({ user: { id: "user-a" }, world: { id: "world-a" }, connection: "connected" });
test("guests, disconnected users and not-joined users cannot edit", () => {
  for (const state of [{}, { user: { id: "u" } }, { world: { id: "w" }, connection: "connected" },
    { ...connected(), connection: "connecting" }, { ...connected(), connection: "disconnected" }]) {
    assert.equal(workshopAccess(state).canEdit, false);
    assert.equal(canEditWorkshopObject(state, { ownerId: "user-a" }), false);
  }
  assert.equal(workshopAccess(connected()).canEdit, true);
});
test("even teachers cannot edit other owners' objects", () => {
  const state = connected(); state.user.role = "teacher";
  assert.equal(canEditWorkshopObject(state, { ownerId: "user-a" }), true);
  assert.equal(canEditWorkshopObject(state, { ownerId: "user-b" }), false);
  assert.equal(canEditWorkshopObject(state, null), false);
});
test("async fences reject logout, world change and disconnect/reconnect", () => {
  const scope = createWorkshopScope(); assert.equal(scope.update(connected()).changed, true);
  const token = scope.capture(); assert.equal(scope.accepts(token), true);
  assert.equal(scope.update(connected()).changed, false); assert.equal(scope.accepts(token), true);
  scope.update({ ...connected(), world: { id: "world-b" } }); assert.equal(scope.accepts(token), false);
  scope.update(connected()); const next = scope.capture();
  scope.update({ ...connected(), connection: "disconnected" }); assert.equal(scope.accepts(next), false);
  scope.update(connected()); assert.equal(scope.accepts(next), false);
  const current = scope.capture(); scope.update({}); assert.equal(scope.accepts(current), false);
});
test("a delayed upload cannot repopulate state after identity changes", async () => {
  const scope = createWorkshopScope(); scope.update(connected()); const token = scope.capture(); let resolve;
  const upload = new Promise((done) => { resolve = done; }); const completed = upload.then(() => scope.accepts(token));
  scope.update({ ...connected(), user: { id: "user-b" } }); resolve({ id: "old-private-asset" });
  assert.equal(await completed, false);
});
test("transforms fail closed before GPU matrices, including array lengths", () => {
  const valid = { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] };
  assert.equal(safeWorkshopTransform(valid), true);
  for (const value of [NaN, Infinity, 1e308, -1e308]) {
    assert.equal(safeWorkshopTransform({ ...valid, position: [value, 2, 3] }), false);
    assert.equal(safeWorkshopTransform({ ...valid, rotation: [value, 0, 0] }), false);
    assert.equal(safeWorkshopTransform({ ...valid, scale: [value, 1, 1] }), false);
  }
  assert.equal(safeWorkshopTransform({ ...valid, scale: [0, 1, 1] }), false);
  assert.equal(safeWorkshopTransform({ ...valid, position: [1, 2] }), false);
});
test("shared object footprints reserve flat and vertically separated placements", () => {
  const bounds = { min: [0, 0, 0], max: [1, 1, 1] };
  assert.equal(sharedObjectOverlap(bounds, { bounds }), true);
  assert.equal(sharedObjectOverlap(bounds, { bounds: { min: [1, 0, 0], max: [2, 1, 1] } }), true);
  assert.equal(sharedObjectOverlap(bounds, { bounds: { min: [0, 2, 0], max: [1, 3, 1] } }), true);
  assert.equal(sharedObjectOverlap(bounds, { bounds: { min: [0.996, 0, 0], max: [2, 1, 1] } }), true);
  assert.equal(sharedObjectOverlap(bounds, { bounds: { min: [0.99, 0, 0], max: [2, 1, 1] } }), true);
});

// Explicit DOM/client unit fixtures, not evidence of production Google login.
class Element {
  constructor() { this.children = []; this.handlers = new Map(); this.style = { setProperty() {} }; this.dataset = {}; this.value = ""; this.textContent = ""; this.open = false; this.parentElement = { before() {} }; }
  querySelector(selector) { return this.registry.get(selector.slice(1)); }
  append(...children) { this.children.push(...children); }
  after() {}
  before(element) { this.previousElementSibling = element; }
  replaceChildren(...children) { this.children = [...children]; }
  setAttribute() {}
  get options() { return this.children; }
  get valueAsNumber() { return Number(this.value); }
  addEventListener(event, handler) { this.handlers.set(event, handler); }
  removeEventListener(event) { this.handlers.delete(event); }
  showModal() { this.open = true; }
  focus() {}
  close() { this.open = false; }
  dispatch(event, properties = {}) { this.handlers.get(event)?.({ type: event, target: this, code: "", ...properties }); }
}
const source = new TextEncoder().encode("solid part\nfacet normal 0 1 0\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 0 1\nendloop\nendfacet\nendsolid part").buffer;
async function fixture(t, initial = connected(), stl = source, triangles = 1) {
  const ids = ["workshop-dialog", "workshop-status", "workshop-save-hint", "workshop-list", "stl-files", "stl-up", "stl-units", "object-x", "object-z", "object-scale", "object-rx", "object-ry", "object-rz", "object-y", "object-pick", "object-remove", "object-apply", "workshop-close", "open-workshop", "canvas-hint"];
  ids.push("exhibit-title", "exhibit-description", "exhibit-save", "exhibit-author", "object-color", "object-finish", "object-surface", "object-locate", "object-location", "object-name");
  ids.push("stl-editor-preview", "stl-editor-canvas", "stl-editor-dimensions", "stl-design-picker", "ground-pick-controls", "ground-pick-hint", "ground-pick-cancel");
  const registry = new Map(ids.map((id) => [id, new Element()])); registry.get("workshop-dialog").registry = registry;
  const designTabs = new Element(), designSamples = new Element();
  registry.get("stl-design-picker").registry = new Map([["finish-groups", designTabs], ["stl-design-samples", designSamples]]);
  registry.get("object-finish").children = ["windows","brick","roofTiles","wood","mosaic","stainedGlass","circuit","honeycomb","aurora"]
    .map((value, index) => ({ value, index }));
  registry.get("object-surface").children = ["all","walls","roof"].map(value => ({ value, textContent: value }));
  registry.get("stl-up").value = "y"; registry.get("stl-units").value = "m";
  const saved = { document: globalThis.document, window: globalThis.window, Option: globalThis.Option };
  globalThis.document = { querySelector: (selector) => registry.get(selector.slice(1)), createElement: () => new Element() };
  globalThis.window = new Element(); globalThis.Option = class extends Element { constructor(text, value) { super(); this.textContent = text; this.value = value; } };
  let state = { assets: [], objects: [], ...initial }, listener;
  const calls = { uploads: 0, edits: 0, editTypes: [], downloads: 0, login: 0, environment: 0 };
  const hash = Buffer.from(await crypto.subtle.digest("SHA-256", stl)).toString("hex");
  const metadata = (ownerId = "user-a", id = crypto.randomUUID()) => ({ id, ownerId, name: "作品.stl", upAxis: "y", units: "m", bytes: stl.byteLength, triangles, sha256: hash });
  const client = {
    getState: () => structuredClone(state),
    subscribe: (next) => { listener = next; next(structuredClone(state)); return () => { listener = null; }; },
    uploadAsset: async () => { calls.uploads++; const asset = metadata(); state.assets.push(asset); client.emit("assets"); return asset; },
    downloadAsset: async () => { calls.downloads++; return stl.slice(0); },
    editObject: async (type, data) => {
      calls.edits++; calls.editTypes.push(type);
      if (type === "object.delete") state.objects = state.objects.filter((item) => item.id !== data.id);
      else if (type === "object.describe") state.objects = state.objects.map(item => item.id === data.id ? { ...item, title: data.title, description: data.description } : item);
      else if (type === "object.paint") state.objects = state.objects.map(item => item.id === data.id ? { ...item, color: data.color, finish: data.finish, surface: data.surface } : item);
      else {
        const previous = state.objects.find((item) => item.id === data.id);
        state.objects = state.objects.filter((item) => item.id !== data.id);
        state.objects.push({ ...previous, ...data, ownerId: "user-a", name: "作品.stl", triangles,
          bounds: { min: [data.position[0] - .5, 5, data.position[2] - .5], max: [data.position[0] + .5, 5, data.position[2] + .5] } });
      }
      client.emit("objects"); return { id: data.id, revision: 1 };
    },
    emit: (event = "state") => listener?.(structuredClone(state), event),
    replace: (next, event) => { state = { assets: [], objects: [], ...next }; client.emit(event); },
  };
  const ground = createSurfaceIndex(new Float32Array([-50,5,-50, 50,5,-50, 50,5,50, -50,5,-50, 50,5,50, -50,5,50]));
  const scene = new THREE.Scene();
  const canvas = new Element(), camera = new THREE.PerspectiveCamera(), terrainMeshes = [];
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 });
  const workshop = createWorkshop(THREE, { scene, camera, domElement: canvas, schoolClient: client,
    getEnvironment: () => { calls.environment++; return { terrain: ground, terrainMeshes, obstacles: [], bounds: [-50,-50,50,50] }; }, getViewPosition: () => ({ x: 2, y: 5, z: 2 }),
    onStartPicking: () => { calls.groundPicks = (calls.groundPicks ?? 0) + 1; },
    onRequireLogin: () => { calls.login++; }, onLocate: item => { calls.located = item; return true; } });
  t.after(() => { workshop.destroy(); Object.assign(globalThis, saved); });
  await new Promise((resolve) => setImmediate(resolve));
  return { workshop, client, calls, registry, metadata, scene, camera, canvas, terrainMeshes, designTabs, designSamples, state: () => state,
    file: () => ({ name: "作品.stl", size: stl.byteLength, arrayBuffer: async () => stl.slice(0) }),
    settle: async (predicate = () => true) => {
      for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve));
      for (let i = 0; i < 100 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 2));
    } };
}
test("a design preset previews all appearance fields and saves through the current action", async t => {
  const f = await fixture(t);
  assert.equal(f.registry.get("stl-design-picker").hidden, true);
  await f.workshop.importFiles([f.file()]);
  assert.equal(f.registry.get("stl-design-picker").hidden, false);
  f.designSamples.children[2].dispatch("click");
  const draft = f.workshop.getHeldDraft();
  assert.deepEqual([draft.userData.stlColor, draft.userData.stlFinish, draft.userData.stlSurface], ["#7d8fa3", "roofTiles", "roof"]);
  assert.equal(f.calls.edits, 0);
  await f.workshop.commitSelected();
  await f.settle();
  const placed = f.workshop.getState().current;
  f.designTabs.children[2].dispatch("click");
  f.designSamples.children[2].dispatch("click");
  assert.equal(f.registry.get("object-apply").textContent, "見た目を保存");
  assert.equal(f.workshop.getState().current.finish, "roofTiles");
  f.registry.get("object-apply").onclick();
  await f.settle();
  const saved = f.workshop.getState().current;
  assert.deepEqual([saved.color, saved.finish, saved.surface], ["#b89cf5", "aurora", "all"]);
  assert.deepEqual(saved.position, placed.position);
  assert.deepEqual(f.calls.editTypes, ["object.create", "object.paint"]);
});

test("STL color flows through draft, commit, painting and reload without moving the work", async t => {
  const f = await fixture(t); await f.workshop.importFiles([f.file()]);
  assert.equal(await f.workshop.locateSelected(), false);
  assert.equal(await f.workshop.paintSelected("#FF8800", "windows", "walls"), true);
  assert.equal(f.workshop.getHeldDraft().userData.stlColor, "#ff8800");
  assert.equal(f.workshop.getHeldDraft().userData.stlFinish, "windows");
  await f.workshop.commitSelected(); await f.settle();
  const before = f.workshop.getState().current;
  assert.equal(before.color, "#ff8800");
  assert.equal(before.finish, "windows"); assert.equal(before.surface, "walls");
  f.registry.get("object-color").value = "#22aa77";
  f.registry.get("object-finish").value = "brick"; f.registry.get("object-surface").value = "roof";
  f.client.emit("objects"); await f.settle();
  assert.equal(f.registry.get("object-color").value, "#22aa77", "peer updates retain unsaved color choice");
  assert.equal(f.registry.get("object-finish").value, "brick"); assert.equal(f.registry.get("object-surface").value, "roof");
  f.registry.get("object-apply").onclick();
  await f.settle();
  assert.deepEqual(f.workshop.getState().current.position, before.position);
  assert.equal(f.workshop.getState().current.color, "#22aa77");
  assert.equal(f.workshop.getState().current.finish, "brick"); assert.equal(f.workshop.getState().current.surface, "roof");
  assert.equal(f.workshop.group.children[0].material.color.getHexString(), "22aa77");
  assert.equal(await f.workshop.locateSelected(), true); assert.equal(f.calls.located.id, before.id);
  assert.match(f.registry.get("object-location").textContent, /水平距離/);
  const saved = structuredClone(f.state()); f.client.replace({}); f.client.replace(saved); await f.settle(() => f.workshop.getState().committed === 1);
  f.workshop.selectObject(before.id);
  assert.equal(f.workshop.getState().current.color, "#22aa77");
  assert.equal(f.workshop.getState().current.finish, "brick"); assert.equal(f.workshop.getState().current.surface, "roof");
  assert.equal(await f.workshop.paintSelected("#ffffff", "stone", "walls"), false);
  assert.equal(await f.workshop.paintSelected("#ffffff", "windows", "invalid"), false);
  assert.equal(await f.workshop.paintSelected("red"), false);
  f.client.replace({ ...saved, user: { ...saved.user, id: "other" } }); await f.settle(() => f.workshop.getState().committed === 1);
  f.workshop.selectObject(before.id);
  assert.equal(await f.workshop.paintSelected("#ffffff"), false);
  assert.equal(await f.workshop.locateSelected(), true);
});

test('recall waits for ACK and keeps color, scale and rotation in a new held draft',async t=>{
  const f=await fixture(t);await f.workshop.importFiles([f.file()]);
  await f.workshop.paintSelected('#ffaa22','truss','walls');f.workshop.adjustSelected({scaleFactor:2});
  f.workshop.adjustSelected({axis:'y',radians:.7});
  await f.workshop.commitSelected();await f.settle();
  const old=f.workshop.getState().current;
  let ack;const edit=f.client.editObject;
  f.client.editObject=(...args)=>new Promise(resolve=>{ack=async()=>resolve(await edit(...args));});
  const pending=f.workshop.retrieveSelected();
  assert.equal(f.workshop.getState().committed,1);assert.equal(f.workshop.getHeldDraft(),null);
  await ack();assert.equal(await pending,true);await f.settle();
  const held=f.workshop.getState().current;
  assert.equal(f.workshop.getState().committed,0);assert.equal(held.committed,false);
  assert.notEqual(held.id,old.id);
  for(const field of ['color','finish','surface','scale','rotation'])assert.deepEqual(held[field],old[field]);
  assert.equal(f.workshop.getHeldDraft().userData.stlColor,old.color);
  assert.equal(f.workshop.getHeldDraft().userData.stlFinish,old.finish);
  f.client.editObject=edit;f.workshop.moveSelected([10,0,10]);
  assert.equal(await f.workshop.commitSelected(),true);await f.settle();
  assert.equal(f.workshop.getState().current.color,old.color);
  assert.equal(f.workshop.getState().current.finish,old.finish);assert.equal(f.workshop.getState().current.surface,old.surface);
});

test('failed recall and late recall after logout never create a stale held object',async t=>{
  const f=await fixture(t);await f.workshop.importFiles([f.file()]);await f.workshop.commitSelected();await f.settle();
  f.client.editObject=async()=>{throw Error('disconnected');};
  assert.equal(await f.workshop.retrieveSelected(),false);assert.equal(f.workshop.getState().committed,1);
  assert.equal(f.workshop.getHeldDraft(),null);
  let ack;f.client.editObject=()=>new Promise(resolve=>{ack=resolve;});
  const pending=f.workshop.retrieveSelected();f.client.replace({});ack({});
  assert.equal(await pending,false);assert.equal(f.workshop.getHeldDraft(),null);assert.equal(f.workshop.group.children.length,0);
});

test("actual workshop API prevents guest imports and programmatic edit calls", async (t) => {
  const f = await fixture(t, {});
  assert.equal(f.workshop.open(), false); assert.equal(f.registry.get("workshop-dialog").open, false);
  assert.equal(await f.workshop.importFiles([f.file()]), false);
  assert.equal(await f.workshop.commitSelected(), false);
  assert.equal(await f.workshop.removeSelected(), false);
  assert.equal(await f.workshop.cycleOwnAsset(), false);
  assert.equal(f.calls.uploads + f.calls.edits + f.calls.downloads, 0);
  assert.equal(f.workshop.getState().count, 0); assert.ok(f.calls.login > 0);
});
test("STL is uploaded first; draft commits only after server acknowledgement", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.workshop.importFiles([f.file()]), true);
  assert.equal(f.calls.uploads, 1); assert.equal(f.workshop.getState().count, 1);
  assert.equal(f.workshop.getState().committed, 0); assert.equal(f.workshop.getState().current.valid, true);
  let acknowledge; const original = f.client.editObject;
  f.client.editObject = (...args) => new Promise((resolve) => { acknowledge = async () => resolve(await original(...args)); });
  const pending = f.workshop.commitSelected(); assert.equal(f.workshop.getState().busy, true);
  assert.equal(f.workshop.getState().committed, 0);
  assert.ok(f.workshop.getHeldDraft(), 'keep held model until server acknowledgement');
  await acknowledge(); assert.equal(await pending, true); await f.settle();
  assert.equal(f.workshop.getState().committed, 1); assert.equal(f.workshop.getState().storage, "cloud-world");
  assert.equal(f.workshop.getHeldDraft(),null);
  assert.ok(f.workshop.group.children.some(mesh=>!mesh.userData.isDraft && mesh.visible),'committed mesh remains visible');
});

test('failed new placement preserves the held draft, geometry, transform and cloud original for retry',async t=>{
  const f=await fixture(t);await f.workshop.importFiles([f.file()]);
  const draft=f.workshop.getHeldDraft(),before=f.workshop.getState().current,original=f.client.editObject;
  f.client.editObject=async()=>{throw Error('connection_lost');};
  assert.equal(await f.workshop.commitSelected(),false);
  assert.equal(f.workshop.getHeldDraft(),draft);assert.ok(draft.visible);
  assert.deepEqual(f.workshop.getState().current,before);assert.equal(f.workshop.getState().ownAssets.length,1);
  f.client.editObject=original;assert.equal(await f.workshop.commitSelected(),true);await f.settle();
  assert.equal(f.workshop.getState().committed,1);
});
test("combined wheel transform validates the new position and scale together before commit", async t => {
  const f=await fixture(t);await f.workshop.importFiles([f.file()]);
  assert.equal(f.workshop.adjustSelected({scaleFactor:2,position:[10,99,10]}).valid,true);
  assert.deepEqual(f.workshop.getState().current.scale,[2,2,2]);
  assert.ok(f.workshop.getState().current.position.every((v,i)=>Math.abs(v-[10,5,10][i])<1e-10));
  assert.equal(f.calls.edits,0);assert.equal(await f.workshop.commitSelected(),true);
  assert.deepEqual(f.state().objects[0].scale,[2,2,2]);assert.ok(f.state().objects[0].position.every((v,i)=>Math.abs(v-[10,5,10][i])<1e-10));
});

test("typing scale previews the real mesh, preserves incomplete input across sync, and saves only a valid draft", async t => {
  const f = await fixture(t); await f.workshop.importFiles([f.file()]);
  const input = f.registry.get("object-scale"), apply = f.registry.get("object-apply");
  const type = value => { input.value = value; input.dispatch("input"); };
  type("2.00");
  assert.equal(input.value, "2.00");
  assert.deepEqual(f.workshop.getHeldDraft().scale.toArray(), [2,2,2]);
  assert.equal(f.calls.edits, 0);
  type("");
  f.client.emit("objects"); await f.settle();
  assert.equal(input.value, ""); assert.equal(apply.disabled, true);
  assert.equal(await f.workshop.commitSelected(), false);
  f.registry.get("workshop-dialog").dispatch("close");
  assert.equal(Number(input.value), 2);
  assert.equal(apply.disabled, false);
  type("1e308"); assert.deepEqual(f.workshop.getHeldDraft().scale.toArray(), [2,2,2]);
  assert.equal(await f.workshop.commitSelected(), false);
  type("2"); assert.equal(await f.workshop.commitSelected(), true); await f.settle();
  const original = f.workshop.group.children[0];
  type("0.5");
  assert.equal(original.visible, false);
  assert.deepEqual(f.workshop.group.children.find(mesh => mesh.userData.isDraft).scale.toArray(), [.5,.5,.5]);
  assert.deepEqual(f.state().objects[0].scale, [2,2,2]);
  f.workshop.cancelDraft(); assert.equal(original.visible, true); assert.equal(Number(input.value), 2);
  type("0.25"); assert.equal(await f.workshop.commitSelected(), true); await f.settle();
  assert.deepEqual(f.state().objects[0].scale, [.25,.25,.25]);
});

test("footer routes valid placement, appearance-only save, and combined edits without extra writes", async t => {
  const f = await fixture(t);
  const el = id => f.registry.get(id);
  const apply = el("object-apply"), cancel = apply.previousElementSibling, hint = el("workshop-save-hint");
  const selectFinish = value => { el("object-finish").value = value; el("object-finish").dispatch("change"); };
  assert.ok(apply.hidden); assert.match(hint.textContent, /選ぶ/);
  await f.workshop.importFiles([f.file()]); f.workshop.open();
  assert.equal(apply.textContent, "この場所に配置"); assert.equal(apply.disabled, false);
  selectFinish("galaxy");
  assert.equal(f.workshop.getHeldDraft().userData.stlFinish, "galaxy");
  assert.deepEqual(f.calls.editTypes, []);
  f.workshop.moveSelected([200,0,200]);
  assert.equal(apply.disabled, true); assert.match(hint.textContent, /範囲/);
  assert.equal(el("workshop-status").hidden, true, "the invalid cause is shown once at the action");
  apply.onclick(); assert.equal(f.calls.edits, 0);
  f.workshop.moveSelected([10,5,10]); apply.onclick(); apply.onclick(); await f.settle();
  assert.deepEqual(f.calls.editTypes, ["object.create"]);
  assert.equal(f.state().objects[0].finish, "galaxy");
  assert.equal(apply.textContent, "変更を保存"); assert.equal(apply.disabled, true); assert.match(hint.textContent, /配置済み/);
  selectFinish("solid"); apply.onclick(); await f.settle();
  assert.match(el("workshop-status").textContent, /見た目を保存しました/);
  selectFinish("windows"); assert.equal(el("workshop-status").textContent, "", "a new edit clears the previous save receipt");
  el("object-surface").value = "walls"; el("object-surface").dispatch("change");
  selectFinish("solid"); assert.ok(apply.disabled, "solid ignores its inactive face selector");
  assert.ok(cancel.hidden);
  selectFinish("aurora"); assert.equal(apply.textContent, "見た目を保存"); assert.equal(apply.disabled, false);
  assert.equal(cancel.hidden, false); cancel.onclick();
  assert.equal(el("object-finish").value, "solid"); assert.ok(apply.disabled); assert.ok(cancel.hidden);
  selectFinish("aurora"); apply.onclick(); apply.onclick(); await f.settle();
  assert.deepEqual(f.calls.editTypes, ["object.create", "object.paint", "object.paint"]);
  assert.deepEqual(f.state().objects[0].position,[10,5,10]);
  assert.equal(apply.disabled, true);
  selectFinish("brick"); f.workshop.moveSelected([12,5,12]);
  assert.equal(apply.textContent, "変更を保存"); assert.equal(apply.disabled, false);
  assert.equal(f.state().objects[0].finish, "aurora");
  apply.onclick(); await f.settle();
  assert.deepEqual(f.calls.editTypes, ["object.create","object.paint","object.paint","object.update"]);
  assert.equal(f.state().objects[0].finish, "brick");
  assert.deepEqual(f.state().objects[0].position,[12,5,12]);
  assert.equal(apply.disabled, true);
});

test("a failed appearance save keeps the selection available for retry", async t => {
  const f = await fixture(t); await f.workshop.importFiles([f.file()]);
  await f.workshop.commitSelected(); await f.settle();
  const apply = f.registry.get("object-apply"), color = f.registry.get("object-color");
  color.value = "#cc6655"; color.dispatch("input");
  const edit = f.client.editObject;
  f.client.editObject = async () => { throw new Error("disconnected"); };
  apply.onclick(); await f.settle();
  assert.equal(apply.disabled, false); assert.equal(apply.textContent, "見た目を保存");
  assert.equal(color.value, "#cc6655"); assert.equal(f.state().objects[0].color, "#488caa");
  assert.match(f.registry.get("workshop-status").textContent, /保存できませんでした/);
  f.client.editObject = edit;
  apply.onclick(); await f.settle();
  assert.equal(f.state().objects[0].color, "#cc6655"); assert.equal(apply.disabled, true);
});

test("unsaved finish stays on a held draft when the dialog closes to choose ground", async t => {
  const f = await fixture(t); await f.workshop.importFiles([f.file()]); f.workshop.open();
  const finish = f.registry.get("object-finish"); finish.value = "circuit"; finish.dispatch("change");
  f.registry.get("object-pick").onclick(); assert.ok(f.workshop.getState().picking);
  assert.equal(f.registry.get("workshop-dialog").open, false);
  assert.equal(f.calls.groundPicks, 1);
  const controls = f.registry.get("ground-pick-controls"), dialog = f.registry.get("workshop-dialog");
  assert.equal(controls.hidden, false);
  f.canvas.dispatch("click", { clientX: 50, clientY: 50 });
  assert.match(f.registry.get("ground-pick-hint").textContent, /もう一度/);
  assert.equal(f.workshop.isPicking(), true);
  f.camera.position.set(9, 12, 9); f.camera.lookAt(9, 5, 9); f.camera.updateMatrixWorld();
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(90, 90), new THREE.MeshBasicMaterial());
  mesh.rotation.x = -Math.PI / 2; mesh.position.y = 5; mesh.updateMatrixWorld();
  f.terrainMeshes.push(mesh);
  f.canvas.dispatch("click", { clientX: 50, clientY: 50 });
  assert.equal(controls.hidden, true); assert.equal(f.workshop.isPicking(), false); assert.equal(dialog.open, true);
  assert.ok(Math.abs(f.workshop.getState().current.position[0] - 9) < .001);
  assert.deepEqual(f.calls.editTypes, []);
  assert.equal(f.workshop.getHeldDraft().userData.stlFinish, "circuit");
  assert.equal(await f.workshop.commitSelected(), true);
  assert.equal(f.state().objects[0].finish, "circuit");
});

test("ground picker returns to a saved work without creating a draft when cancelled by button or Escape", async t => {
  const f = await fixture(t); await f.workshop.importFiles([f.file()]); await f.workshop.commitSelected(); await f.settle();
  f.workshop.open();
  const selected = f.workshop.getState().current;
  for (const input of ["button", "key"]) {
    f.registry.get("object-pick").onclick(); assert.equal(f.workshop.isPicking(), true);
    if (input === "button") f.registry.get("ground-pick-cancel").onclick();
    else window.dispatch("keydown", { key: "Escape", preventDefault() {} });
    assert.equal(f.workshop.isPicking(), false); assert.equal(f.registry.get("ground-pick-controls").hidden, true);
    assert.equal(f.registry.get("workshop-dialog").open, true);
    assert.deepEqual(f.workshop.getState().current, selected);
    assert.equal(f.registry.get("object-apply").disabled, true);
  }
});

test("a placed object's pending finish selection survives live sizing and saves together", async t => {
  const f = await fixture(t); await f.workshop.importFiles([f.file()]);
  await f.workshop.commitSelected(); await f.settle();
  f.registry.get("workshop-dialog").showModal();
  f.registry.get("object-finish").value = "galaxy";
  f.registry.get("object-surface").value = "walls";
  const scale = f.registry.get("object-scale");
  scale.value = "0.75"; scale.dispatch("input");
  assert.equal(f.registry.get("object-finish").value, "galaxy");
  assert.equal(f.state().objects[0].finish, "solid");
  assert.equal(await f.workshop.commitSelected(), true); await f.settle();
  assert.equal(f.state().objects[0].finish, "galaxy");
  assert.equal(f.state().objects[0].surface, "walls");
  assert.deepEqual(f.state().objects[0].scale, [.75,.75,.75]);
});

test("scale scrubbing preserves clicks, works at millimetre scale, and ignores changes to a replaced selection", async t => {
  const f = await fixture(t); await f.workshop.importFiles([f.file()]);
  const input = f.registry.get("object-scale");
  const oldFrame = globalThis.requestAnimationFrame, oldCancel = globalThis.cancelAnimationFrame;
  let frame;
  globalThis.requestAnimationFrame = callback => { frame = callback; return 1; };
  globalThis.cancelAnimationFrame = () => { frame = null; };
  t.after(() => {
    if (oldFrame) globalThis.requestAnimationFrame = oldFrame; else delete globalThis.requestAnimationFrame;
    if (oldCancel) globalThis.cancelAnimationFrame = oldCancel; else delete globalThis.cancelAnimationFrame;
  });
  const pointer = (type, x) => input.dispatch(type, { pointerType: "mouse", pointerId: 8, button: 0, clientX: x, preventDefault() {} });
  input.value = "0.001"; input.dispatch("input"); await f.workshop.commitSelected(); await f.settle();
  pointer("pointerdown", 10); pointer("pointerup", 12);
  assert.equal(f.workshop.getState().current.committed, true);
  pointer("pointerdown", 10); pointer("pointermove", 60); frame();
  assert.ok(Math.abs(f.workshop.getState().current.scale[0] - .001 * Math.sqrt(2)) < 1e-9);
  pointer("pointermove", 110); pointer("pointerup", 110);
  assert.deepEqual(f.workshop.getState().current.scale, [.002,.002,.002]);
  assert.equal(f.calls.edits, 1); assert.deepEqual(f.state().objects[0].scale, [.001,.001,.001]);
  pointer("pointerdown", 10); pointer("pointermove", 100);
  f.workshop.cancelDraft(); pointer("pointerup", 100);
  assert.equal(f.workshop.getState().current.committed, true);
});

test("large STL size previews coalesce terrain checks, validate on save and discard stale validations", async t => {
  const facet = new TextDecoder().decode(source).match(/facet normal[\s\S]*?endfacet/)[0];
  const stl = new TextEncoder().encode("solid mesh\n" + (facet + "\n").repeat(2000) + "endsolid mesh").buffer;
  const f = await fixture(t, connected(), stl, 2000); await f.workshop.importFiles([f.file()]);
  const type = value => { const input = f.registry.get("object-scale"); input.value = String(value); input.dispatch("input"); };
  const checks = f.calls.environment;
  type(2); type(3); type(4);
  assert.deepEqual(f.workshop.getHeldDraft().scale.toArray(), [4,4,4]);
  assert.equal(f.calls.environment, checks);
  assert.equal(f.registry.get("object-apply").disabled, true);
  await f.settle(() => f.workshop.getState().current.valid);
  assert.equal(f.calls.environment, checks + 1);
  type(5); assert.equal(await f.workshop.commitSelected(), true); await f.settle();
  assert.equal(f.calls.environment, checks + 2);
  assert.deepEqual(f.state().objects[0].scale, [5,5,5]);
  type(2); f.workshop.cancelDraft();
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(f.calls.environment, checks + 2);
  assert.equal(f.workshop.getState().current.committed, true);
});

test("other owners render but every mutation and import reuse remains own-only", async (t) => {
  const f = await fixture(t); const asset = f.metadata("user-b"), id = crypto.randomUUID();
  f.client.replace({ ...connected(), assets: [asset], objects: [{ id, assetId: asset.id, ownerId: "user-b", name: "他の生徒", position: [2,5,2], rotation: [0,0,0], scale: [1,1,1], triangles: 1 }] });
  await f.settle(() => f.workshop.getState().committed === 1); assert.equal(f.workshop.getState().committed, 1);
  assert.equal(f.workshop.selectObject(id), true); assert.equal(f.workshop.getState().current.editable, false);
  const apply = f.registry.get("object-apply");
  assert.equal(apply.hidden, true); assert.equal(apply.disabled, true);
  assert.match(f.registry.get("workshop-save-hint").textContent, /作者/);
  f.registry.get("object-color").value = "#992233"; apply.onclick();
  assert.equal(f.workshop.moveSelected([5,5,5]).valid, false);
  assert.equal(f.workshop.adjustSelected({ axis: "x", radians: 1 }).valid, false);
  assert.equal(await f.workshop.commitSelected(), false); assert.equal(await f.workshop.removeSelected(), false);
  assert.equal(await f.workshop.cycleOwnAsset(), false); assert.equal(f.calls.edits, 0);
});

test("scale multiplication clamps rounding overshoot but still rejects genuinely excessive transforms",async t=>{
  const f=await fixture(t);await f.workshop.importFiles([f.file()]);
  f.registry.get('object-scale').value='98.1';f.registry.get('object-scale').dispatch('change');
  f.workshop.adjustSelected({scaleFactor:100/98.1});
  assert.deepEqual(f.workshop.getState().current.scale,[100,100,100]);
  assert.ok(!f.workshop.getState().message.includes('値が範囲外'));
  assert.equal(f.workshop.adjustSelected({scaleFactor:2}).valid,false);
  assert.deepEqual(f.workshop.getState().current.scale,[100,100,100]);
  f.workshop.adjustSelected({scaleFactor:1e-8});
  assert.deepEqual(f.workshop.getState().current.scale,[1e-6,1e-6,1e-6]);
});
test("preview preserves committed mesh; cancel and remote restore keep latest state", async (t) => {
  const f = await fixture(t); await f.workshop.importFiles([f.file()]); await f.workshop.commitSelected(); await f.settle();
  const id = f.workshop.getState().selected, committed = f.workshop.group.children[0];
  f.workshop.moveSelected([10,5,10]);
  assert.equal(f.workshop.group.children.length, 2); assert.deepEqual(committed.position.toArray(), [2,5,2]);
  f.workshop.cancelDraft(); assert.equal(f.workshop.group.children.length, 1); assert.deepEqual(committed.position.toArray(), [2,5,2]);
  f.workshop.moveSelected([12,5,12]);
  f.state().objects[0].position = [20,5,20]; f.client.emit("room"); await f.settle();
  assert.equal(f.workshop.group.children.length, 1); assert.deepEqual(committed.position.toArray(), [20,5,20]);
  assert.equal(f.workshop.getState().objects.find((item) => item.id === id).committed, true);
});
test("logout during file read prevents upload; disconnect removes private meshes", async (t) => {
  const f = await fixture(t); let read;
  const pending = f.workshop.importFiles([{ name: "a.stl", size: source.byteLength, arrayBuffer: () => new Promise((resolve) => { read = resolve; }) }]);
  f.client.replace({}); read(source); assert.equal(await pending, false); assert.equal(f.calls.uploads, 0);
  f.client.replace(connected()); await f.workshop.importFiles([f.file()]); await f.workshop.commitSelected(); await f.settle();
  assert.equal(f.workshop.group.children.length, 1);
  f.client.replace({ ...connected(), connection: "reconnecting" }); await f.settle();
  assert.equal(f.workshop.group.children.length, 0); assert.equal(f.workshop.getState().canEdit, false);
});
test("download hash mismatch shows retry status and cannot render or edit", async (t) => {
  const f = await fixture(t); const asset = f.metadata();
  f.client.downloadAsset = async () => new Uint8Array(source.byteLength).buffer;
  f.client.replace({ ...connected(), assets: [asset], objects: [{ id: crypto.randomUUID(), ownerId: "user-a", assetId: asset.id, position: [2,5,2], rotation: [0,0,0], scale: [1,1,1], triangles: 1 }] });
  await f.settle(() => f.workshop.getState().assetFailures === 1); assert.equal(f.workshop.getState().count, 0); assert.equal(f.workshop.getState().assetFailures, 1);
  f.client.downloadAsset = async () => source.slice(0);
  assert.equal(f.workshop.retryAssets(), true); await f.settle(() => f.workshop.getState().committed === 1); assert.equal(f.workshop.getState().committed, 1);
});
test("saved owned STL can be reused after refresh without uploading", async (t) => {
  const f = await fixture(t); const asset = f.metadata();
  f.client.replace({ ...connected(), assets: [asset] }); await f.settle();
  assert.equal(await f.workshop.cycleOwnAsset(), true); assert.equal(f.calls.uploads, 0); assert.equal(f.calls.downloads, 1);
  assert.equal(f.workshop.getState().current.assetId, asset.id);
});
test("multiple placed copies do not incorrectly consume the ten-uploaded-assets quota", async (t) => {
  const f = await fixture(t), asset = f.metadata();
  f.client.replace({ ...connected(), assets: [asset] }); await f.settle();
  for (let i = 0; i < 11; i++) {
    assert.equal(await f.workshop.cycleOwnAsset(), true);
    assert.equal(f.workshop.moveSelected([-30 + i * 3, 5, -20]).valid, true);
    assert.equal(await f.workshop.commitSelected(), true);
  }
  await f.settle();
  assert.equal(f.workshop.getState().committed, 11);
  assert.equal(f.workshop.getState().ownAssets.length, 1); assert.equal(f.calls.uploads, 0);
});

test("shared-world VR asset cycling reselects a placed object and edits it instead of creating a duplicate", async t => {
  const f = await fixture(t, {...connected(), singleClassroom:true});
  await f.workshop.importFiles([f.file()]); await f.workshop.commitSelected(); await f.settle();
  const firstId=f.workshop.getState().selected;
  await f.workshop.importFiles([f.file()]); f.workshop.moveSelected([15,5,15]);
  await f.workshop.commitSelected(); await f.settle();
  assert.equal(await f.workshop.cycleOwnAsset(-1),true);
  assert.equal(f.workshop.getState().current.id,firstId);
  assert.equal(f.workshop.getState().current.committed,true);
  assert.deepEqual(f.workshop.getState().current.position,[2,5,2]);
  assert.equal(f.workshop.adjustSelected({scaleFactor:1.5}).valid,true);
  let sentType;
  const edit=f.client.editObject; f.client.editObject=(type,data)=>{sentType=type;return edit(type,data);};
  assert.equal(await f.workshop.commitSelected(),true); await f.settle();
  assert.equal(sentType,"object.update"); assert.equal(f.workshop.getState().committed,2);
  assert.equal(f.workshop.getState().current.id,firstId);
});
test("peer downloads are capped at two; stale completed bytes cannot repopulate after logout", async (t) => {
  const f = await fixture(t), assets = [f.metadata(), f.metadata(), f.metadata()], finish = [];
  f.client.downloadAsset = () => { f.calls.downloads++; return new Promise((resolve) => finish.push(resolve)); };
  f.client.replace({ ...connected(), assets, objects: assets.map((asset, i) => ({ id: crypto.randomUUID(), ownerId: "user-a", assetId: asset.id,
    position: [i * 5, 5, 2], rotation: [0,0,0], scale: [1,1,1], triangles: 1 })) });
  await f.settle(); assert.equal(f.calls.downloads, 2);
  finish[0](source.slice(0)); await f.settle(() => f.calls.downloads === 3);
  assert.equal(f.calls.downloads, 3);
  f.client.replace({}); finish[1](source.slice(0)); finish[2](source.slice(0)); await f.settle();
  assert.equal(f.workshop.group.children.length, 0); assert.equal(f.workshop.getState().count, 0);
  assert.equal(f.workshop.getState().assetFailures, 0);
});
test("failed server edit retains the prior committed mesh and makes no fake success", async (t) => {
  const f = await fixture(t); await f.workshop.importFiles([f.file()]); await f.workshop.commitSelected(); await f.settle();
  const committed = f.workshop.group.children[0];
  f.workshop.moveSelected([10,5,10]); f.client.editObject = async () => { throw new Error("stale_revision"); };
  assert.equal(await f.workshop.commitSelected(), false);
  assert.equal(f.workshop.getState().committed, 1); assert.equal(f.workshop.getState().current.committed, false);
  assert.deepEqual(committed.position.toArray(), [2,5,2]); assert.match(f.workshop.getState().message, /変更を保存できませんでした/);
});
