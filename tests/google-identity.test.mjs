import test from "node:test";
import assert from "node:assert/strict";
import { createGoogleIdentityLoader } from "../src/google-identity.js";

function fixture() {
  const scripts = [], timers = new Map(), globalObject = {};
  let serial = 0;
  class Script extends EventTarget {
    remove() { const index = scripts.indexOf(this); if (index >= 0) scripts.splice(index, 1); }
    fire(type) { this.dispatchEvent(new Event(type)); }
  }
  const documentImpl = { querySelector: () => scripts[0] ?? null, createElement: () => new Script(), head: { append: (script) => scripts.push(script) } };
  const load = createGoogleIdentityLoader({ documentImpl, globalObject,
    setTimeoutImpl: (fn, delay) => { const id = ++serial; timers.set(id, { fn, delay }); return id; }, clearTimeoutImpl: (id) => timers.delete(id) });
  return { load, scripts, timers, globalObject };
}
test("GIS uses exact official URL, deduplicates loads and resolves API only after successful load", async () => {
  const f = fixture(); const first = f.load(), same = f.load(); assert.equal(first, same);
  assert.equal(f.scripts.length, 1); assert.equal(f.scripts[0].src, "https://accounts.google.com/gsi/client");
  assert.equal([...f.timers.values()][0].delay, 15000);
  const api = { initialize() {}, renderButton() {} }; f.globalObject.google = { accounts: { id: api } }; f.scripts[0].fire("load");
  assert.equal(await first, api); assert.equal(await f.load(), api); assert.equal(f.timers.size, 0);
});
test("stalled GIS script is removed on timeout and the next user retry creates a new script", async () => {
  const f = fixture(); const first = f.load(), old = f.scripts[0]; const failure = assert.rejects(first, /gis_unavailable/);
  [...f.timers.values()][0].fn(); await failure; assert.equal(f.scripts.length, 0); assert.equal(f.timers.size, 0);
  const second = f.load(); assert.equal(f.scripts.length, 1); assert.notEqual(f.scripts[0], old);
  const api = {}; f.globalObject.google = { accounts: { id: api } }; f.scripts[0].fire("load"); assert.equal(await second, api);
});
test("GIS network errors and load-without-API clean up and permit a bounded retry", async () => {
  const f = fixture(); const failed = f.load(); const failure = assert.rejects(failed, /gis_unavailable/); f.scripts[0].fire("error"); await failure;
  assert.equal(f.scripts.length, 0); const missing = f.load(); const rejection = assert.rejects(missing, /gis_unavailable/); f.scripts[0].fire("load"); await rejection;
  assert.equal(f.scripts.length, 0); assert.equal(f.timers.size, 0);
});
