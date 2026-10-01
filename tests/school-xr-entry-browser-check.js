// Local-only real-browser regression for teacher restores during XR entry.
// Start school-browser-server.mjs, then school-xr-dev.mjs; run this with Node.
// Only requestSession waiting is controlled. App camera/state/restore handlers,
// actual Worker/D1/DO APIs, WebSocket messages and IWER rendering stay real.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { promisify } from "node:util";
import WebSocket from "ws";

const execFileAsync = promisify(execFile);
const session = "school17-race", xrOrigin = "http://localhost:4173";
const fixtures = JSON.parse(await readFile(".cache/school-browser-fixtures.json", "utf8"));
assert.equal(fixtures.origin, "http://localhost:4174");
const cliExecutable = process.platform === "win32"
  ? resolve(`node_modules/agent-browser/bin/agent-browser-win32-${process.arch}.exe`)
  : process.execPath;
const cliPrefix = process.platform === "win32" ? [] : [resolve("node_modules/agent-browser/bin/agent-browser.js")];
async function browser(...args) {
  try {
    const { stdout } = await execFileAsync(cliExecutable, [...cliPrefix, "--session", session, ...args],
      { encoding: "utf8", timeout: 45000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    return stdout.trim();
  } catch {
    // Never print private cookie arguments or CLI stderr containing them.
    throw Error(`Owned race browser command failed: ${args[0]}`);
  }
}
async function evaluate(expression) {
  const value = JSON.parse(await browser("eval", `(async()=>JSON.stringify(await (${expression})))()`));
  return typeof value === "string" ? JSON.parse(value) : value;
}
async function until(predicate, name, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (!await predicate()) {
    if (Date.now() > deadline) throw Error(`${name}: timeout`);
    await pause(100);
  }
}
async function api(person, path, body) {
  const response = await fetch(`${fixtures.origin}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Origin: fixtures.origin, Cookie: person.cookie,
      ...(body === undefined ? {} : { "X-CSRF-Token": person.csrf, "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw Error(`Actual API ${path.split("/").at(-1)} failed (${response.status}, ${result.error ?? "unknown"})`);
  return result;
}
const poses = { a: { position: [-180, 38, -180], yaw: .35 },
  b: { position: [-260, 52, -300], yaw: -.65 } };
let seedSocket, passed = false, report;

async function browserRace(expected) {
  const system = navigator.xr, original = system.requestSession;
  const descriptor = Object.getOwnPropertyDescriptor(system, "requestSession");
  const state = () => window.__okazaki.getState(), results = [], errors = [];
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const distance = (a, b) => Math.hypot(...a.map((value, index) => value - b[index]));
  const check = (ok, name, detail) => {
    results.push({ ok: Boolean(ok), name, ...(!ok && detail ? { detail } : {}) });
    if (!ok) throw Error(`${name}${detail ? `: ${JSON.stringify(detail)}` : ""}`);
  };
  const until = async (predicate, name) => {
    const deadline = performance.now() + 15000;
    while (!predicate()) { if (performance.now() > deadline) throw Error(`${name}: timeout`); await pause(50); }
  };
  const onError = event => errors.push(event.message ?? "browser error");
  const onUnhandled = event => errors.push(event.reason?.message ?? "unhandled rejection");
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onUnhandled);
  let pending = null, requestCount = 0;
  const control = window.__schoolRaceControl = { phase: "starting", error: null };
  control.release = kind => {
    const queued = pending; pending = null;
    if (!queued) throw Error("No delayed XR request");
    if (kind === "reject") queued.reject(new DOMException("Deliberate race rejection", "NotAllowedError"));
    else original.apply(system, queued.args).then(queued.resolve, queued.reject);
  };
  try {
    check(state().ready && !state().xr && state().school.connection === "connected", "joined-real-school-before-XR-race");
    check(Boolean(window.__xrTestDevice && system), "real-IWER-device-available");
    document.querySelector("#tab-settings").click();
    const mode = document.querySelector("#control-mode");
    mode.value = "creative"; mode.dispatchEvent(new Event("change", { bubbles: true }));
    await until(() => state().creative.mode === "creative", "creative-mode");
    check(distance(state().camera, expected.a.position) < .025, "actual-saved-pose-A-adopted-before-entry");
    Object.defineProperty(system, "requestSession", { configurable: true, writable: true,
      value: function (...args) {
        if (args[0] !== "immersive-vr") return original.apply(system, args);
        requestCount++;
        return new Promise((resolve, reject) => { pending = { resolve, reject, args }; });
      } });

    for (const outcome of ["resolve", "reject"]) {
      await until(() => distance(state().camera, expected.a.position) < .025, `${outcome}-pose-A`);
      const beforeSequence = state().school.snapshotSeq;
      document.querySelector("#enter-vr").click();
      await until(() => pending && state().vrReturn.entering && !state().xr, `${outcome}-entry-waiting`);
      check(mode.disabled && document.querySelector("#enter-vr").disabled, `${outcome}-real-entry-controls-locked`);
      control.phase = `${outcome}-await-teacher-restore`;
      await until(() => state().school.snapshotSeq > beforeSequence &&
        state().school.participants.some(p => p.id === state().school.user.id &&
          distance(p.position, expected.b.position) < .025), `${outcome}-actual-restored-state-B`);
      check(state().vrReturn.entering && state().vrReturn.pendingResume && !state().xr,
        `${outcome}-new-B-arrives-while-request-still-waiting`);
      check(distance(state().camera, expected.b.position) < .025, `${outcome}-desktop-adopts-new-B-not-old-A`);
      control.phase = `${outcome}-ready-to-release`;
      await until(() => !pending, `${outcome}-request-released`);
      if (outcome === "resolve") {
        await until(() => state().xr && !state().vrReturn.pendingResume && state().vrReturn.view,
          "real-IWER-rendered-first-view");
        // captureXRView records the physical viewer center. Three's camera
        // world position is the stereo-union projection camera, not that center.
        await until(() => distance(state().vrReturn.view.position, expected.b.position) < .025,
          `real-XR-physical-view-B ${JSON.stringify({ head: state().head, rig: state().rig,
            view: state().vrReturn.view, expected: expected.b.position })}`);
        check(distance(state().vrReturn.view.position, expected.b.position) < .025,
          "resolved-real-XR-aligns-physical-viewer-to-new-B");
        check(distance(state().head, state().vrReturn.view.position) < .1,
          "stereo-union-camera-is-consistent-with-physical-viewer");
        const orientation = state().vrReturn.view.quaternion;
        const yaw = Math.atan2(2 * (orientation[3] * orientation[1] + orientation[0] * orientation[2]),
          1 - 2 * (orientation[1] ** 2 + orientation[2] ** 2));
        check(Math.abs(yaw - expected.b.yaw) < .025, "resolved-real-XR-retains-new-B-yaw");
        const left = window.__xrTestDevice.controllers.left;
        left.updateButtonValue("x-button", 1);
        try { await until(() => !state().xr, "real-X-long-hold-exit"); }
        finally { left.updateButtonValue("x-button", 0); }
        check(distance(state().camera, expected.b.position) < .025 && !state().free,
          "resolved-XR-exit-retains-new-B-with-motion-off");
        control.phase = "await-reset-A";
      } else {
        await until(() => !state().vrReturn.entering && !state().creative.suspendedXR && !mode.disabled,
          "rejected-entry-unlocked");
        check(!state().xr && !state().free && !state().creative.enabled, "rejected-real-entry-stops-motion");
        check(distance(state().camera, expected.b.position) < .025 &&
          distance(state().creative.eye, expected.b.position) < .025,
        "rejected-real-entry-keeps-new-B-not-pre-request-A");
        check(Math.abs(state().creative.yaw - expected.b.yaw) < .025, "rejected-entry-keeps-new-B-yaw");
      }
    }
    check(requestCount === 2, "both-resolve-and-reject-request-races-executed");
    check(errors.length === 0, "no-uncaught-browser-errors-during-teacher-restores");
    return { passed: true, results, requests: requestCount,
      environment: "Actual Chrome + IWER + actual teacher API restore/Worker/D1/DO; not real Google or physical Quest" };
  } finally {
    pending?.reject(new DOMException("Fixture cleanup", "NotAllowedError")); pending = null;
    if (descriptor) Object.defineProperty(system, "requestSession", descriptor);
    else delete system.requestSession;
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onUnhandled);
    control.phase = "complete";
  }
}

try {
  await mkdir("test-results", { recursive: true });
  await api(fixtures.student, "/api/worlds/join", { code: fixtures.world.joinCode });
  const wsURL = `${fixtures.origin.replace(/^http/, "ws")}/api/worlds/${fixtures.world.id}/socket`;
  const packets = [];
  seedSocket = new WebSocket(wsURL, { headers: { Origin: fixtures.origin, Cookie: fixtures.student.cookie } });
  seedSocket.on("message", bytes => packets.push(JSON.parse(String(bytes))));
  await until(() => packets.some(packet => packet.type === "state"), "real-student-socket-open");
  let seq = 0;
  async function checkpoint(pose) {
    const epoch = packets.findLast(packet => packet.type === "state").restoreCommit;
    assert.ok(epoch === null || typeof epoch === "string", "authoritative socket pose epoch");
    seedSocket.send(JSON.stringify({ type: "pose", ...pose, seq: seq++, restoreCommit: epoch }));
    await until(() => packets.some(packet => packet.type === "pose" &&
      packet.participant.id === fixtures.student.id &&
      JSON.stringify(packet.participant.position) === JSON.stringify(pose.position)), "real-student-pose-ACK");
    const saved = await api(fixtures.teacher, `/api/worlds/${fixtures.world.id}/save`, {});
    assert.ok(saved.id); await pause(150); return saved.id;
  }
  const snapshotB = await checkpoint(poses.b), snapshotA = await checkpoint(poses.a);
  seedSocket.close(); await until(() => seedSocket.readyState === WebSocket.CLOSED, "fixture-socket-closed");
  async function restore(snapshotId) {
    const state = await api(fixtures.teacher, `/api/worlds/${fixtures.world.id}/state`);
    const result = await api(fixtures.teacher, `/api/worlds/${fixtures.world.id}/restore`, { snapshotId, revision: state.revision });
    assert.equal(result.revision, state.revision + 1);
  }
  try { await browser("close"); } catch { /* Only this owned session. */ }
  await pause(1000);
  await browser("--executable-path", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "--args", "--use-angle=swiftshader,--enable-unsafe-swiftshader", "open", `${xrOrigin}/?testxr=1`);
  await browser("wait", "--fn", "window.__okazaki?.getState().ready && window.__xrTestDevice");
  await browser("screenshot", "test-results/school-xr-entry-smoke.png");
  const snapshot = await browser("snapshot", "-i");
  assert.ok(snapshot.includes("button")); assert.equal(await browser("errors"), "");
  assert.equal(await evaluate("!document.querySelector('vite-error-overlay,[data-nextjs-dialog]') && document.body.innerText.trim().length>50"), true);
  await browser("cookies", "set", fixtures.student.browserCookie.name, fixtures.student.browserCookie.value,
    "--url", `${xrOrigin}/`, "--path", "/", "--secure", "--httpOnly", "--sameSite", "Lax");
  await browser("reload");
  await browser("wait", "--fn", "window.__okazaki?.getState().ready && window.__okazaki.getState().school.user && window.__okazaki.getState().school.worlds.length");
  await browser("click", "#school-button");
  await browser("select", "#school-world-list", fixtures.world.id);
  await browser("scrollintoview", "#school-world-open"); await browser("click", "#school-world-open");
  await browser("wait", "--fn", "window.__okazaki.getState().school.connection==='connected'");
  await evaluate("(()=>{document.querySelector('#school-close').click();return true})()");
  await browser("wait", "--fn", "!document.querySelector('#school-dialog').open");
  await evaluate(`(()=>{window.__schoolRacePromise=(${browserRace.toString()})(${JSON.stringify(poses)})
    .then(report=>{window.__schoolRaceReport=report;return report;})
    .catch(error=>{const s=window.__okazaki.getState();window.__schoolRaceReport={passed:false,error:error.message,
      diagnostics:{xr:s.xr,free:s.free,head:s.head,camera:s.camera,rig:s.rig,view:s.vrReturn.view,
        pending:s.vrReturn.pendingResume,entering:s.vrReturn.entering}};return window.__schoolRaceReport;});return true;})()`);
  for (const outcome of ["resolve", "reject"]) {
    await until(async () => {
      const stage = await evaluate("({phase:window.__schoolRaceControl?.phase,report:window.__schoolRaceReport})");
      if (stage.report?.passed === false) throw Error(stage.report.error);
      return stage.phase === `${outcome}-await-teacher-restore`;
    }, `${outcome}-browser-waiting`);
    await restore(snapshotB);
    async function atPhase(phase) {
      const stage = await evaluate("({phase:window.__schoolRaceControl?.phase,report:window.__schoolRaceReport})");
      if (stage.report?.passed === false) throw Error(stage.report.error);
      return stage.phase === phase;
    }
    await until(() => atPhase(`${outcome}-ready-to-release`), `${outcome}-B-adopted`);
    await evaluate(`(()=>{window.__schoolRaceControl.release('${outcome}');return true})()`);
    if (outcome === "resolve") {
      await until(() => atPhase("await-reset-A"), "resolved-XR-exited");
      await restore(snapshotA);
    }
  }
  await until(async () => Boolean(await evaluate("window.__schoolRaceReport")), "browser-report-finished");
  report = await evaluate("window.__schoolRaceReport"); assert.equal(report.passed, true, report.error);
  assert.equal(await browser("errors"), "");
  await browser("screenshot", "test-results/school-xr-entry.png");
  for (const item of report.results) { assert.equal(item.ok, true, item.name); console.log(`[school-xr-entry] PASS ${item.name}`); }
  passed = true;
} finally {
  if (seedSocket && seedSocket.readyState !== WebSocket.CLOSED) seedSocket.close();
  await mkdir("test-results", { recursive: true });
  await writeFile("test-results/school-xr-entry.json", JSON.stringify({ passed, checkedAt: new Date().toISOString(),
    ...report, workerBundleSha256: fixtures.workerBundleSha256,
    referenceBuiltDistManifestSha256: fixtures.distManifestSha256, browserAssetMode: "Vite source + development-only IWER",
    ephemeralAuthenticationFixtures: true, notVerified: ["real Google exchange", "production bindings", "physical Quest", "30 classroom devices"] }, null, 2));
  if (!passed) {
    const diagnosis = await evaluate("(()=>{const s=window.__okazaki?.getState();return {ready:s?.ready,user:Boolean(s?.school.user),world:Boolean(s?.school.world),worlds:s?.school.worlds.length,connection:s?.school.connection,error:s?.school.error,phase:window.__schoolRaceControl?.phase,raceReport:window.__schoolRaceReport}})()").catch(() => null);
    console.error(`[school-xr-entry] public-state diagnosis: ${JSON.stringify(diagnosis)}`);
    await browser("screenshot", "test-results/school-xr-entry-failure.png").catch(() => {});
  }
  try { await browser("close"); } catch { /* Only school17-race, never user Chrome. */ }
}
