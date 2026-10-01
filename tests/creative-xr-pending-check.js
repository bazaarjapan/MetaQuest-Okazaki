// Run on a loaded desktop ?testxr=1 page with the existing async browser runner.
// When window.__pendingXRStage.phase === "await-mobile-viewport", resize the
// OWNED agent-browser session to 390x844. This exercises the real matchMedia
// and adaptive-UI path; it does not replace the app's production diagnostics.
(async () => {
  const results = [], errors = [];
  const state = () => window.__okazaki.getState();
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const check = (ok, name, detail) => {
    results.push({ ok: Boolean(ok), name, ...(detail === undefined ? {} : { detail }) });
    if (!ok) throw new Error(`${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
  };
  const until = async (predicate, timeout = 10000) => {
    const deadline = performance.now() + timeout;
    while (!predicate() && performance.now() < deadline) await wait(50);
    if (!predicate()) throw new Error("Pending-XR regression timed out waiting for the real page transition");
  };
  const distance = (a, b) => Math.hypot(...a.map((value, index) => value - b[index]));
  const stoppedBadge = () => document.querySelector("#free-move-state").textContent === "OFF" &&
    document.querySelector("#movement-controls").dataset.free === "false" && !document.querySelector("#free-move").checked;
  const key = (code, type = "keydown") => window.dispatchEvent(
    new KeyboardEvent(type, { code, bubbles: true, cancelable: true }));
  const mode = document.querySelector("#control-mode");
  const enter = document.querySelector("#enter-vr");
  const canvas = document.querySelector("#viewport > canvas");
  const system = navigator.xr;
  check(state().ready && !state().xr && !state().ui.mobile, "pending-test-starts-on-real-loaded-desktop");
  check(Boolean(window.__xrTestDevice && system && mode && enter && canvas), "IWER-and-real-page-controls-available");
  const originalRequest = system.requestSession;
  const originalDescriptor = Object.getOwnPropertyDescriptor(system, "requestSession");
  let rejectPending = null, requests = 0, restored = false, passed = false;
  const onError = (event) => errors.push(event.message ?? String(event.error));
  const onUnhandled = (event) => errors.push(String(event.reason?.message ?? event.reason));
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onUnhandled);
  function restoreRequest() {
    if (restored) return;
    if (originalDescriptor) Object.defineProperty(system, "requestSession", originalDescriptor);
    else delete system.requestSession;
    restored = true;
  }
  function rejectRequest() {
    const reject = rejectPending;
    rejectPending = null;
    reject?.(new DOMException("Deliberate pending-XR regression rejection", "NotAllowedError"));
  }
  function forceModeChange() {
    mode.value = "drone";
    mode.dispatchEvent(new Event("change", { bubbles: true }));
  }
  async function beginRequest(expectedRequests) {
    canvas.focus();
    enter.click();
    await until(() => requests === expectedRequests && state().creative.suspendedXR);
    check(mode.disabled && enter.disabled && stoppedBadge(), `request-${expectedRequests}-locks-mode-before-XR-session-resolves`);
    check(state().creative.mode === "creative" && !state().xr,
      `request-${expectedRequests}-suspends-creative-before-session-is-created`);
  }
  try {
    // The actual requestSession entry point is delayed. All app event handlers,
    // animation frames, resize notifications and rejection handling remain real.
    Object.defineProperty(system, "requestSession", { configurable: true, writable: true,
      value: function (kind) {
        if (kind !== "immersive-vr") return Promise.reject(new Error("Unexpected XR session mode"));
        requests++;
        return new Promise((_resolve, reject) => { rejectPending = reject; });
      } });
    window.__pendingXRStage = { phase: "desktop-rejection", viewport: [innerWidth, innerHeight] };
    document.querySelector("#tab-observe").click();
    mode.value = "creative";
    mode.dispatchEvent(new Event("change", { bubbles: true }));
    await until(() => state().creative.mode === "creative");
    if (!state().free) document.querySelector("#free-move").click();
    canvas.focus();
    await until(() => state().free && state().creative.enabled);
    key("F5");
    await until(() => state().creative.viewMode === "back");
    const firstEye = [...state().creative.eye];
    const firstYaw = state().creative.yaw;
    await beginRequest(1);
    forceModeChange();
    await wait(100);
    check(mode.value === "creative" && state().creative.mode === "creative" &&
      state().creative.suspendedXR, "forced-DOM-change-restores-actual-mode-during-desktop-pending-request");
    check(errors.length === 0, "forced-pending-mode-change-causes-no-uncaught-exception", errors);
    rejectRequest();
    await until(() => !state().creative.suspendedXR && !mode.disabled && !enter.disabled);
    check(!state().free && !state().creative.enabled && state().creative.pressedKeys.length === 0 && stoppedBadge(),
      "desktop-request-rejection-unlocks-with-motion-OFF");
    check(state().creative.mode === "creative" && state().creative.viewMode === "first" && !state().avatar.visible,
      "desktop-rejection-restores-safe-first-person-mode");
    check(distance(state().creative.eye, firstEye) < 1e-6 && distance(state().camera, firstEye) < 1e-6 &&
      Math.abs(state().creative.yaw - firstYaw) < 1e-6, "desktop-rejection-keeps-player-view-not-rear-camera");

    // A second delayed request crosses the actual desktop/mobile breakpoint.
    if (!state().free) document.querySelector("#free-move").click();
    canvas.focus();
    await until(() => state().free && state().creative.enabled);
    const secondEye = [...state().creative.eye];
    await beginRequest(2);
    window.__pendingXRStage = { phase: "await-mobile-viewport", viewport: [innerWidth, innerHeight],
      requestCount: requests, desktopChecks: results.length };
    await until(() => state().ui.mobile, 45000);
    await wait(150);
    check(innerWidth <= 760 && state().ui.mobile, "real-viewport-matchMedia-switches-to-mobile",
      { viewport: [innerWidth, innerHeight] });
    check(state().creative.mode === "creative" && state().creative.suspendedXR && mode.disabled &&
      mode.value === "creative", "resize-does-not-change-mode-mid-pending-XR-request");
    forceModeChange();
    await wait(100);
    check(state().creative.mode === "creative" && mode.value === "creative" && state().creative.suspendedXR,
      "forced-change-also-restores-mode-after-mobile-resize");
    check(distance(state().creative.eye, secondEye) < 1e-6 && errors.length === 0,
      "pending-resize-does-not-move-player-or-throw", errors);
    window.__pendingXRStage = { phase: "rejecting-mobile-request", viewport: [innerWidth, innerHeight] };
    rejectRequest();
    await until(() => !state().creative.suspendedXR && state().creative.mode === "drone" && !mode.disabled);
    check(!state().free && !state().creative.enabled && !state().avatar.visible && stoppedBadge() &&
      state().creative.pressedKeys.length === 0, "mobile-fallback-is-drone-with-inputs-and-motion-stopped");
    check(mode.value === "drone" && mode.querySelector('option[value="creative"]').disabled,
      "mobile-fallback-selector-matches-actual-mode-and-disables-creative-option");
    check(distance(state().camera, secondEye) < 1e-6 && !state().xr,
      "mobile-rejection-keeps-player-view-and-never-enters-XR");
    check(errors.length === 0, "pending-rejection-and-resize-have-no-uncaught-errors", errors);
    restoreRequest();
    check(system.requestSession === originalRequest, "original-IWER-requestSession-restored");
    passed = true;
    return JSON.stringify({ passed: true, environment: "Actual browser + IWER; delayed XR rejection fixture, NOT physical Quest",
      results, requests, finalViewport: [innerWidth, innerHeight] });
  } finally {
    // A failed check must not leave XR entry suspended or an API monkey patch.
    rejectRequest();
    restoreRequest();
    await wait(100);
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onUnhandled);
    window.__pendingXRStage = { phase: "complete", passed, checks: results.length,
      requestCount: requests, viewport: [innerWidth, innerHeight] };
  }
})();
