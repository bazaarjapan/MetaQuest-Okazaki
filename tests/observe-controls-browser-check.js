// Run on a fresh desktop page with no explicit saved control preference.
// Only ordinary UI events/read-only diagnostics; no camera/input substitutions.
(async () => {
  const state = () => window.__okazaki.getState(), results = [];
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const check = (ok, name) => { results.push({ ok: Boolean(ok), name }); if (!ok) throw Error(name); };
  const until = async predicate => {
    const end = performance.now() + 10000;
    while (!predicate()) { if (performance.now() > end) throw Error("observe control transition timeout"); await pause(50); }
  };
  const distance = (a, b) => Math.hypot(...a.map((value, index) => value - b[index]));
  const badge = () => document.querySelector("#free-move-state").textContent === (state().free ? "ON" : "OFF") &&
    document.querySelector("#movement-controls").dataset.free === String(state().free) &&
    document.querySelector("#free-move").checked === state().free;
  const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight + 1; };
  const mode = document.querySelector("#control-mode"), free = document.querySelector("#free-move"), canvas = document.querySelector("#viewport > canvas");
  check(state().ready && !state().ui.mobile, "observe-PC-ready");
  check(state().creative.mode === "creative" && state().free && free.checked, "fresh-PC-creative-and-free-ON");
  check(!document.pointerLockElement && state().creative.pressedKeys.length === 0, "initial-ON-never-locks-mouse-or-replays-keys");
  check(state().current === "overview" && distance(state().camera, [350, 340, 440]) < 1e-6,
    "initial-ON-retains-known-overview-not-first-frame-clamp");
  const initial = [...state().camera]; await pause(150);
  check(distance(state().camera, initial) < 1e-6, "initial-ON-does-not-move-without-input");
  document.querySelector("#tab-observe").click(); document.querySelector(".panel-body").scrollTop = 0;
  check(visible(mode) && visible(free) && mode.closest("#panel-observe") && free.closest("#panel-observe"), "observe-mode-and-free-controls-visible-without-settings");
  check(document.querySelectorAll("#control-mode").length === 1 && document.querySelectorAll("#free-move").length === 1 && badge(), "single-controls-and-initial-ON-badge-consistent");
  free.click(); check(!state().free && badge(), "observe-toggle-OFF-and-badge");
  free.click(); canvas.focus(); await until(() => state().creative.enabled);
  check(state().free && badge() && distance(state().camera, initial) < 1e-6, "observe-toggle-ON-preserves-view");
  mode.value = "drone"; mode.dispatchEvent(new Event("change", { bubbles: true }));
  check(state().creative.mode === "drone" && !state().free && badge(), "observe-mode-change-stops-with-OFF-badge");
  check(localStorage.getItem("okazaki-control-mode-v2") === "drone", "deliberate-drone-choice-is-saved");
  mode.value = "creative"; mode.dispatchEvent(new Event("change", { bubbles: true }));
  check(state().creative.mode === "creative" && !state().free && badge(), "switch-back-to-creative-stays-stopped");
  free.click(); document.querySelector('[data-view="east"]').click();
  check(!state().free && badge(), "viewpoint-stops-and-badge-matches");
  free.click(); document.querySelector("#home").click();
  check(!state().free && badge(), "home-stops-and-badge-matches");
  free.click(); document.querySelector("#help").click();
  await until(() => !state().free);
  check(document.querySelector("#help-dialog").open && badge(), "modal-stops-and-badge-matches");
  document.querySelector("#close-help").click();
  check(!state().free && badge(), "closing-modal-never-resumes-movement");
  free.click(); window.dispatchEvent(new Event("blur"));
  check(!state().free && badge() && state().creative.pressedKeys.length === 0, "input-loss-stops-and-badge-matches");
  return JSON.stringify({ passed: true, environment: "Actual desktop UI, not physical Quest", results });
})();
