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
test("shared object overlap matches server XYZ and 5mm tolerance", () => {
  const bounds = { min: [0, 0, 0], max: [1, 1, 1] };
  assert.equal(sharedObjectOverlap(bounds, { bounds }), true);
  assert.equal(sharedObjectOverlap(bounds, { bounds: { min: [1, 0, 0], max: [2, 1, 1] } }), false);
  assert.equal(sharedObjectOverlap(bounds, { bounds: { min: [0, 2, 0], max: [1, 3, 1] } }), false);
  assert.equal(sharedObjectOverlap(bounds, { bounds: { min: [0.996, 0, 0], max: [2, 1, 1] } }), false);
  assert.equal(sharedObjectOverlap(bounds, { bounds: { min: [0.99, 0, 0], max: [2, 1, 1] } }), true);
});

// Explicit DOM/client unit fixtures, not evidence of production Google login.
class Element {
  constructor() { this.children = []; this.handlers = new Map(); this.style = {}; this.value = ""; this.textContent = ""; this.open = false; this.parentElement = { before() {} }; }
  querySelector(selector) { return this.registry.get(selector.slice(1)); }
  append(...children) { this.children.push(...children); }
  after() {}
  replaceChildren(...children) { this.children = [...children]; }
  setAttribute() {}
  get options() { return this.children; }
  get valueAsNumber() { return Number(this.value); }
  addEventListener(event, handler) { this.handlers.set(event, handler); }
  removeEventListener(event) { this.handlers.delete(event); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  dispatch(event) { this.handlers.get(event)?.({ target: this, code: "", ...event }); }
}
const source = new TextEncoder().encode("solid part\nfacet normal 0 1 0\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 0 1\nendloop\nendfacet\nendsolid part").buffer;
async function fixture(t, initial = connected()) {
  const ids = ["workshop-dialog", "workshop-status", "workshop-list", "stl-files", "stl-up", "stl-units", "object-x", "object-z", "object-scale", "object-rx", "object-ry", "object-rz", "object-y", "object-pick", "object-remove", "object-apply", "workshop-close", "open-workshop", "canvas-hint"];
  const registry = new Map(ids.map((id) => [id, new Element()])); registry.get("workshop-dialog").registry = registry;
  registry.get("stl-up").value = "y"; registry.get("stl-units").value = "m";
  const saved = { document: globalThis.document, window: globalThis.window, Option: globalThis.Option };
  globalThis.document = { querySelector: (selector) => registry.get(selector.slice(1)), createElement: () => new Element() };
  globalThis.window = new Element(); globalThis.Option = class extends Element { constructor(text, value) { super(); this.textContent = text; this.value = value; } };
  let state = { assets: [], objects: [], ...initial }, listener;
  const calls = { uploads: 0, edits: 0, downloads: 0, login: 0 };
  const hash = Buffer.from(await crypto.subtle.digest("SHA-256", source)).toString("hex");
  const metadata = (ownerId = "user-a", id = crypto.randomUUID()) => ({ id, ownerId, name: "作品.stl", upAxis: "y", units: "m", bytes: source.byteLength, triangles: 1, sha256: hash });
  const client = {
    getState: () => structuredClone(state),
    subscribe: (next) => { listener = next; next(structuredClone(state)); return () => { listener = null; }; },
    uploadAsset: async () => { calls.uploads++; const asset = metadata(); state.assets.push(asset); client.emit("assets"); return asset; },
    downloadAsset: async () => { calls.downloads++; return source.slice(0); },
    editObject: async (type, data) => {
      calls.edits++;
      if (type === "object.delete") state.objects = state.objects.filter((item) => item.id !== data.id);
      else {
        const previous = state.objects.find((item) => item.id === data.id);
        state.objects = state.objects.filter((item) => item.id !== data.id);
        state.objects.push({ ...previous, ...data, ownerId: "user-a", name: "作品.stl", triangles: 1,
          bounds: { min: [data.position[0] - .5, 5, data.position[2] - .5], max: [data.position[0] + .5, 5, data.position[2] + .5] } });
      }
      client.emit("objects"); return { id: data.id, revision: 1 };
    },
    emit: (event = "state") => listener?.(structuredClone(state), event),
    replace: (next, event) => { state = { assets: [], objects: [], ...next }; client.emit(event); },
  };
  const ground = createSurfaceIndex(new Float32Array([-50,5,-50, 50,5,-50, 50,5,50, -50,5,-50, 50,5,50, -50,5,50]));
  const scene = new THREE.Scene();
  const workshop = createWorkshop(THREE, { scene, camera: new THREE.PerspectiveCamera(), domElement: new Element(), schoolClient: client,
    getEnvironment: () => ({ terrain: ground, obstacles: [], bounds: [-50,-50,50,50] }), getViewPosition: () => ({ x: 2, y: 5, z: 2 }),
    onRequireLogin: () => { calls.login++; } });
  t.after(() => { workshop.destroy(); Object.assign(globalThis, saved); });
  await new Promise((resolve) => setImmediate(resolve));
  return { workshop, client, calls, registry, metadata, scene, state: () => state,
    file: () => ({ name: "作品.stl", size: source.byteLength, arrayBuffer: async () => source.slice(0) }),
    settle: async (predicate = () => true) => {
      for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve));
      for (let i = 0; i < 100 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 2));
    } };
}
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
  await acknowledge(); assert.equal(await pending, true); await f.settle();
  assert.equal(f.workshop.getState().committed, 1); assert.equal(f.workshop.getState().storage, "cloud-world");
});
test("other owners render but every mutation and import reuse remains own-only", async (t) => {
  const f = await fixture(t); const asset = f.metadata("user-b"), id = crypto.randomUUID();
  f.client.replace({ ...connected(), assets: [asset], objects: [{ id, assetId: asset.id, ownerId: "user-b", name: "他の生徒", position: [2,5,2], rotation: [0,0,0], scale: [1,1,1], triangles: 1 }] });
  await f.settle(() => f.workshop.getState().committed === 1); assert.equal(f.workshop.getState().committed, 1);
  assert.equal(f.workshop.selectObject(id), true); assert.equal(f.workshop.getState().current.editable, false);
  assert.equal(f.workshop.moveSelected([5,5,5]).valid, false);
  assert.equal(f.workshop.adjustSelected({ axis: "x", radians: 1 }).valid, false);
  assert.equal(await f.workshop.commitSelected(), false); assert.equal(await f.workshop.removeSelected(), false);
  assert.equal(await f.workshop.cycleOwnAsset(), false); assert.equal(f.calls.edits, 0);
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
  assert.deepEqual(committed.position.toArray(), [2,5,2]); assert.match(f.workshop.getState().message, /確定していません/);
});
