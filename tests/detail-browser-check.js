// Run against the PC browser (local or published). No emulator is required.
(async () => {
  const results = [], state = () => window.__okazaki.getState();
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const assert = (ok, name, detail) => {
    results.push({ ok: Boolean(ok), name, detail });
    if (!ok) throw new Error(name);
  };
  const selector = document.querySelector("#quality-select");
  const initial = state().quality.id;
  assert(state().ready && !state().xr && !selector.disabled, "desktop-quality-selector-ready");
  assert(state().version === "1.10.6", "current-detail-release-loaded", state().version);
  for (const [id, size, shadows, outline] of [
    ["performance", [768, 512], false, false],
    ["balanced", [1536, 1024], false, true],
    ["high", [3072, 2048], true, true],
    ["balanced", [1536, 1024], false, true],
    ["high", [3072, 2048], true, true],
  ]) {
    selector.value = id;
    selector.dispatchEvent(new Event("change", { bubbles: true }));
    const deadline = performance.now() + 12000;
    while (state().qualityLoading && performance.now() < deadline) await wait(100);
    await wait(200);
    const q = state().quality;
    assert(!state().qualityLoading && !selector.disabled && q.id === id &&
      JSON.stringify(q.terrainSize) === JSON.stringify(size) && q.shadows === shadows && q.outline === outline,
    "quality-cycle-" + id, q);
    assert(state().parts === 5 && state().triangles === 58845 && !state().error,
      "quality-cycle-preserves-original-geometry", { parts: state().parts, triangles: state().triangles });
  }
  assert(["left", "right"].every(hand => getComputedStyle(document.querySelector(".controller-hud-"+hand)).display === "none"),
    "desktop-controller-diagrams-hidden-for-simple-hotbar-layout");
  assert(document.querySelectorAll("#stl-hotbar button").length === 10 && getComputedStyle(document.querySelector("#stl-hotbar")).display !== "none",
    "desktop-has-ten-visible-STL-slots");
  assert(["left", "right"].every((hand) => {
    const h = state().hud.hands[hand];
    return !h.spatialVisible && !h.connected && !h.active;
  }), "desktop-preview-does-not-claim-live-quest-input");
  document.querySelector("#help").click();
  const guide = document.querySelector("#help-dialog").getBoundingClientRect();
  assert(guide.top < 25 && guide.right > innerWidth - 40 && guide.left > innerWidth / 2,
    "desktop-guide-is-upper-right", { top: guide.top, left: guide.left, right: guide.right });
  document.querySelector("#close-help").click();
  selector.value = initial;
  selector.dispatchEvent(new Event("change", { bubbles: true }));
  while (state().qualityLoading) await wait(100);
  const report = { passed: true, environment: "PC browser, NOT physical Quest performance", results };
  window.__detailBrowserReport = report;
  return JSON.stringify(report);
})();
