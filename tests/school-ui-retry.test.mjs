import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// Execute the actual DOM UI module, omitting only its CSS/import declarations.
// No client or Google behavior is implicitly invoked by initial rendering.
const source = (await readFile(new URL("../src/school-ui.js", import.meta.url), "utf8"))
  .replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
const tick = async () => { await new Promise(resolve => setImmediate(resolve)); };
function harness(initial, retry) {
  class Node {
    constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.listeners = new Map();
      this.classList = { toggle() {} }; this.disabled = false; this.open = false; this.isConnected = true; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = [...nodes]; }
    setAttribute(name, value) { this[name] = value; }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    removeEventListener(type) { this.listeners.delete(type); }
    click() { if (!this.disabled) this.listeners.get("click")?.(); }
    showModal() { this.open = true; }
    close() { this.open = false; this.listeners.get("close")?.(); }
    remove() { this.isConnected = false; }
    querySelectorAll(selector) {
      const descendants = this.children.flatMap(child => [child, ...child.querySelectorAll("*")]);
      if (selector === "*") return descendants;
      if (selector === "button[data-school-action]") return descendants.filter(node => node.tagName === "button" && node.dataset.schoolAction);
      if (selector.startsWith("#")) return descendants.filter(node => selector.split(",").includes(`#${node.id}`));
      return [];
    }
  }
  const body = new Node("body"), summary = new Node("p"), button = new Node("button");
  const document = { body, createElement: tag => new Node(tag), querySelector: selector => selector === "#school-summary" ? summary : body.querySelectorAll(selector)[0] };
  let listener, state = structuredClone(initial), gisLoads = 0;
  const calls = [];
  const client = {
    getState: () => structuredClone(state),
    subscribe(callback) { listener = callback; callback(state, "state"); return () => {}; },
    async init(options) { calls.push(options); state = await retry(); listener(state, "auth"); return structuredClone(state); },
  };
  const context = vm.createContext({ document, URL, location: { href: "https://example.test/", origin: "https://example.test" },
    parseSchoolInvite: () => null, schoolInviteURL: () => "https://example.test/#join=ABCDEFGHIJKL",
    createGoogleIdentityLoader: () => async () => { gisLoads++; throw Error("Google must stay lazy"); } });
  vm.runInContext(`${source}\nthis.createTestUI = createSchoolUI;`, context);
  const ui = context.createTestUI({ client, button });
  const find = id => document.querySelector(`#${id}`);
  return { ui, find, calls, get gisLoads() { return gisLoads; } };
}
const guest = { configured: false, user: null, world: null, worlds: [], snapshots: [], participants: [], objects: [],
  connection: "guest", error: "school_unavailable" };

test("guest failed initialization leaves an accessible explicit retry, without loading GIS", async () => {
  const h = harness(guest, async () => ({ ...guest, configured: true, error: null }));
  assert.equal(h.find("school-login").disabled, true);
  const retry = h.find("school-retry");
  assert.equal(retry.tagName, "button"); assert.equal(retry.type, "button"); assert.equal(retry.disabled, false);
  assert.match(retry.textContent, /再接続.*再確認/); assert.equal(h.gisLoads, 0);
  await h.ui.open(); retry.click(); await tick();
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].recheck, true);
  assert.equal(h.find("school-login").disabled, false); assert.equal(h.find("school-retry").disabled, false);
  assert.equal(h.gisLoads, 0); h.ui.destroy();
});
test("an unsuccessful explicit retry remains a safe guest and can be retried again", async () => {
  const h = harness(guest, async () => ({ ...guest }));
  h.find("school-retry").click(); await tick();
  assert.equal(h.find("school-login").disabled, true); assert.equal(h.find("school-retry").disabled, false);
  assert.match(h.find("school-status").textContent, /接続できません/);
  h.find("school-retry").click(); await tick(); assert.equal(h.calls.length, 2);
  assert.equal(h.gisLoads, 0); h.ui.destroy();
});
test("a pending retry disables duplicate actions then restores them, with no automatic requests", async () => {
  let resolveReply; const reply = new Promise(resolve => { resolveReply = resolve; });
  const h = harness(guest, () => reply), button = h.find("school-retry");
  button.click(); button.click(); assert.equal(button.disabled, true); assert.equal(h.calls.length, 1);
  resolveReply({ ...guest, configured: true, error: null }); await tick(); await tick();
  assert.equal(h.calls.length, 1); assert.equal(h.find("school-retry").disabled, false);
  assert.equal(h.gisLoads, 0); h.ui.destroy();
});
