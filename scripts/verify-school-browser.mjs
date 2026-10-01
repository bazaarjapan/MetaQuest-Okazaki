// Run AFTER school-browser-server.mjs is started and its visual smoke check.
// Only temporary local D1 sessions are injected; never a Google/OAuth bypass.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const fixtures = JSON.parse(await readFile(".cache/school-browser-fixtures.json", "utf8"));
assert.equal(fixtures.origin, "http://localhost:4174");
const cli = resolve("node_modules/agent-browser/bin/agent-browser.js");
// On Windows the package's Node wrapper inherits anonymous pipes into another
// child and may never signal EOF to synchronous callers. Use its bundled official CLI.
const cliExecutable = process.platform === "win32" ? resolve(`node_modules/agent-browser/bin/agent-browser-win32-${process.arch}.exe`) : process.execPath;
const cliPrefix = process.platform === "win32" ? [] : [cli];
const sessions = ["school17-guest", "school17-teacher", "school17-student"];
const [guest, teacher, student] = sessions, checks = [];
async function browser(session, ...args) {
  try {
    const { stdout } = await execFileAsync(cliExecutable, [...cliPrefix, "--session", session, ...args], {
      encoding: "utf8", timeout: 45000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    return stdout.trim();
  }
  catch (error) {
    if (args[0] !== "cookies") console.error(String(error.stderr ?? error.stdout ?? "").slice(0,1500));
    throw Error(`Browser command failed (${session}, ${args[0]}); inspect owned browser and server. Private cookie arguments are not logged.`);
  }
}
async function evaluate(session, expression) {
  let value = JSON.parse(await browser(session, "eval", `(async()=>JSON.stringify(await (${expression})))()`));
  return typeof value === "string" ? JSON.parse(value) : value;
}
const state = async (session) => await evaluate(session, "window.__okazaki.getState()");
function check(name, condition) { assert.ok(condition, name); checks.push({ name, passed: true }); console.log(`[school-browser] PASS ${name}`); }
async function wait(session, predicate) {
  // Long CLI wait responses can exceed the native Windows daemon socket's
  // read deadline. Keep the same app predicate, but poll short readonly evals.
  const deadline = Date.now() + 45000;
  while (!await evaluate(session, `Boolean(${predicate})`)) {
    if (Date.now() > deadline) {
      const diagnosis = await evaluate(session, "(()=>{const s=window.__okazaki?.getState();return {ready:s?.ready,error:s?.error,xr:s?.xr,schoolUser:Boolean(s?.school.user),schoolWorld:Boolean(s?.school.world),connection:s?.school.connection,schoolError:s?.school.error,hidden:document.hidden}})()").catch(() => null);
      throw Error(`Actual browser predicate timed out (${session}); public-state: ${JSON.stringify(diagnosis)}`);
    }
    await delay(100);
  }
}
async function click(session, selector) { await browser(session, "scrollintoview", selector); await browser(session, "click", selector); }
async function open(session, url = fixtures.origin) {
  await browser(session, "--executable-path", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "--args", "--use-angle=swiftshader,--enable-unsafe-swiftshader", "open", url);
  await wait(session, "window.__okazaki?.getState().ready");
}
async function cookie(session, person) {
  await browser(session, "cookies", "set", person.browserCookie.name, person.browserCookie.value,
    "--url", `${fixtures.origin}/`, "--path", "/", "--secure", "--httpOnly", "--sameSite", "Lax");
  await browser(session, "reload"); await wait(session, "window.__okazaki?.getState().ready && window.__okazaki.getState().school.user");
}
async function browserScript(session, path) {
  const source = await readFile(path, "utf8");
  let rawResult;
  try { rawResult = await evaluate(session, source.replace(/;\s*$/, "")); }
  catch (error) {
    const diagnosis = await evaluate(session, "({hidden:document.hidden,activeElement:document.activeElement?.id,dialogs:[...document.querySelectorAll('dialog[open]')].map(el=>el.id),free:window.__okazaki.getState().free,creative:window.__okazaki.getState().creative})").catch(() => null);
    console.error(`[school-browser] ${path} input diagnosis: ${JSON.stringify(diagnosis)}`);
    await browser(session, "screenshot", "test-results/school-browser-failure.png").catch(() => {});
    throw error;
  }
  const result = typeof rawResult === "string" ? JSON.parse(rawResult) : rawResult;
  assert.equal(result.passed, true, path);
  for (const item of result.results) check(`${path}: ${item.name}`, item.ok);
}
async function transform(session, location, rotation = [0.3,0.5,0.2], scale = 0.5) {
  const values = { x: location[0], z: location[2], rx: rotation[0]*180/Math.PI,
    ry: rotation[1]*180/Math.PI, rz: rotation[2]*180/Math.PI, scale };
  await evaluate(session, `(()=>{for(const [key,value] of Object.entries(${JSON.stringify(values)})){
    const input=document.querySelector('#object-'+key);input.value=value;
    input.dispatchEvent(new Event('change',{bubbles:true}));}return true})()`);
}
let passed = false;
await mkdir("test-results", { recursive: true });
try {
  for (const session of sessions) { try { await browser(session, "close"); } catch { /* Only these owned sessions. */ } }
  await delay(2000); // Wait for these owned browser daemons to finish closing.
  await open(guest);
  await browser(guest, "screenshot", "test-results/school-browser-guest-smoke.png");
  const smokeSnapshot = await browser(guest, "snapshot", "-i");
  check("visual smoke: interactive content and no blank/error overlay", smokeSnapshot.includes("button") && await evaluate(guest, "!document.querySelector('vite-error-overlay,[data-nextjs-dialog],#webpack-dev-server-client-overlay') && document.body.innerText.trim().length>50"));
  check("visual smoke: no uncaught browser exceptions", await browser(guest, "errors") === "");
  await evaluate(guest, "(()=>{localStorage.removeItem('okazaki-control-mode-v2');return true})()");
  await browser(guest, "reload"); await wait(guest, "window.__okazaki?.getState().ready");
  check("guest city ready, creative default, no shared avatar or editing", (await state(guest)).creative.mode === "creative" && !(await state(guest)).school.user && !(await state(guest)).workshop.canEdit);
  check("Google script stays lazy during anonymous viewing", await evaluate(guest, "!document.querySelector('script[src*=gsi]')"));
  await browserScript(guest, "tests/compact-desktop-check.js");
  await browserScript(guest, "tests/creative-browser-check.js");
  await click(guest, "#open-workshop");
  check("guest object entry opens login rather than importer", await evaluate(guest, "document.querySelector('#school-dialog').open && !document.querySelector('#workshop-dialog').open && document.querySelector('#stl-files').disabled"));
  check("guest private classroom API returns401", await evaluate(guest, "(async()=> (await fetch('/api/worlds')).status)()") === 401);
  await click(guest, "#school-close");
  await evaluate(guest, "(()=>{localStorage.setItem('okazaki-control-mode-v2','creative');return true})()");
  await browser(guest, "set", "viewport", "390", "844"); await browser(guest, "reload"); await wait(guest, "window.__okazaki?.getState().ready");
  check("mobile uses drone without overwriting PC creative preference", (await state(guest)).creative.mode === "drone" && await evaluate(guest, "localStorage.getItem('okazaki-control-mode-v2')") === "creative");
  await browserScript(guest, "tests/compact-mobile-check.js");
  await browser(guest, "set", "viewport", "1280", "800"); await browser(guest, "reload"); await wait(guest, "window.__okazaki?.getState().ready");
  check("wide reload restores PC creative choice", (await state(guest)).creative.mode === "creative");
  await browser(guest, "close");

  await open(teacher); await cookie(teacher, fixtures.teacher); await click(teacher, "#school-button");
  await browser(teacher, "fill", "#school-world-name", "ブラウザ検証クラス"); await click(teacher, "#school-world-create");
  await wait(teacher, "window.__okazaki.getState().school.connection==='connected'");
  const world = (await state(teacher)).school.world;
  check("teacher creates real D1/DO world and12character invite", world.name === "ブラウザ検証クラス" && world.joinCode.length === 12);
  check("teacher invitation fragment and no query leak", await evaluate(teacher, "document.querySelector('#school-invite-url').value.includes('/#join=')"));
  await browser(teacher, "screenshot", "test-results/school-browser-teacher.png"); await click(teacher, "#school-close");
  await open(student, `${fixtures.origin}/#join=${world.joinCode}`); await cookie(student, fixtures.student);
  check("authenticated invite is not joined automatically", !(await state(student)).school.world && !(await state(student)).workshop.canEdit);
  await click(student, "#school-button"); check("student invite code prefilled", await evaluate(student, "document.querySelector('#school-join-code').value") === world.joinCode);
  await click(student, "#school-join"); await wait(student, "window.__okazaki.getState().school.connection==='connected'");
  check("student joins teacher's real world", (await state(student)).school.world.id === world.id);
  await browser(student, "fill", "#school-avatar-name", "検証アバター"); await click(student, "#school-avatar-save");
  await wait(student, "window.__okazaki.getState().school.user.name==='検証アバター'"); await click(student, "#school-close");
  check("separate teacher browser renders other avatar", (await state(teacher)).presence.count === 1);
  await click(student, "#open-workshop"); await browser(student, "select", "#stl-up", "y"); await browser(student, "select", "#stl-units", "m");
  const secondFile = resolve(".cache/school-browser-second.stl"); await copyFile(fixtures.cubeFile, secondFile);
  await browser(student, "upload", "#stl-files", fixtures.cubeFile, secondFile);
  await wait(student, "window.__okazaki.getState().workshop.ownAssets.length===2 && !window.__okazaki.getState().workshop.busy");
  check("multiple real STL uploaded to private R2, not yet placed", (await state(student)).school.assets.length === 2 && (await state(student)).school.objects.length === 0);
  await transform(student, fixtures.cube.groundPositions[0].position); check("all-axis rotation+scale draft validates actual PLATEAU empty ground", (await state(student)).workshop.current.valid);
  await click(student, "#object-apply"); await wait(student, "window.__okazaki.getState().workshop.committed===1");
  check("server ACK commits rotated own STL with real terrain height", (await state(student)).school.objects[0].position[1] > 0 && (await state(student)).school.objects[0].rotation.every(v=>Math.abs(v)>0.1));
  await click(student, "#object-reuse"); await wait(student, "!!window.__okazaki.getState().workshop.current && !window.__okazaki.getState().workshop.busy");
  await transform(student, fixtures.cube.groundPositions[1].position, [0,0,0], 1); await click(student, "#object-apply"); await wait(student, "window.__okazaki.getState().workshop.committed===2");
  check("saved asset reused without extra upload", (await state(student)).school.assets.length === 2);
  await wait(teacher, "window.__okazaki.getState().workshop.committed===2");
  check("peer metadata and both meshes rendered in teacher browser", (await state(teacher)).school.assets.length === 2 && !(await state(teacher)).workshop.assetFailures);
  const original = (await state(student)).school.objects.map(o=>({id:o.id,position:o.position,rotation:o.rotation,scale:o.scale}));
  await click(teacher, "#open-workshop");
  await browser(teacher, "select", "#workshop-list", original[0].id);
  check("teacher cannot edit/delete another user's object in UI", await evaluate(teacher, "document.querySelector('#object-x').disabled && document.querySelector('#object-remove').disabled"));
  await click(teacher, "#workshop-close"); await click(teacher, "#school-button"); await click(teacher, "#school-world-save");
  await wait(teacher, "window.__okazaki.getState().school.snapshots.length>0"); check("teacher saves actual D1 checkpoint", (await state(teacher)).school.snapshots.length > 0);
  await click(student, "#workshop-close"); await browser(student, "reload"); await wait(student, "window.__okazaki?.getState().ready && window.__okazaki.getState().school.user");
  check("reload preserves Google-sub based identity/avatar, no auto activity", (await state(student)).school.user.id === fixtures.student.id && (await state(student)).school.user.name === "検証アバター" && !(await state(student)).school.world);
  await click(student, "#school-button"); await click(student, "#school-world-open"); await wait(student, "window.__okazaki.getState().workshop.committed===2"); await click(student, "#school-close");
  check("rejoin restores owned assets and objects", (await state(student)).workshop.ownAssets.length === 2 && (await state(student)).school.objects.every(o=>o.ownerId===fixtures.student.id));
  await click(student, "#open-workshop"); await browser(student, "select", "#workshop-list", original[0].id);
  await transform(student, fixtures.cube.groundPositions[2].position, [0,0,0], 0.8); await click(student, "#object-apply"); await wait(student, "window.__okazaki.getState().school.revision>2");
  check("owner edits existing server object", (await state(student)).school.objects.some(o=>o.id===original[0].id && Math.abs(o.position[0]-fixtures.cube.groundPositions[2].position[0])<0.001));
  await click(teacher, "#school-world-restore"); check("restore requires second confirmation", await evaluate(teacher, "!document.querySelector('.school-restore-confirm').hidden"));
  await click(teacher, "#school-restore-confirm"); await wait(student, "window.__okazaki.getState().school.objects[0].position[0]==="+original[0].position[0]);
  check("teacher restore broadcasts checkpoint objects to student", JSON.stringify((await state(student)).school.objects.map(o=>({id:o.id,position:o.position,rotation:o.rotation,scale:o.scale}))) === JSON.stringify(original));
  await browser(student, "screenshot", "test-results/school-browser-student.png");
  await click(student, "#workshop-close"); await click(student, "#school-button"); await click(student, "#school-logout"); await wait(student, "!window.__okazaki.getState().school.user");
  check("logout stops shared activity and removes user meshes", !(await state(student)).workshop.canEdit && (await state(student)).workshop.committed===0 && (await state(student)).presence.count===0);
  check("normal8Hz poses never collide with20second heartbeat", (await state(teacher)).school.error !== "ping_rate_limit");
  for (const session of [teacher, student]) check(`${session}: no uncaught browser exceptions`, await browser(session, "errors") === "");
  passed = true;
} finally {
  await mkdir("test-results", {recursive:true});
  await writeFile("test-results/school-browser.json", JSON.stringify({ passed, checkedAt:new Date().toISOString(), checks,
    workerBundleSha256:fixtures.workerBundleSha256, distManifestSha256:fixtures.distManifestSha256,
    scope:"actual Chrome UI -> production Worker -> ephemeral D1/R2/SQLite Durable Objects",
    ephemeralAuthenticationFixtures:true, notVerified:["real Google exchange","production bindings","physical Quest","30 physical devices/classroom network"] },null,2));
  for (const session of sessions) { try { await browser(session, "close"); } catch { /* Only owned sessions. */ } }
}
