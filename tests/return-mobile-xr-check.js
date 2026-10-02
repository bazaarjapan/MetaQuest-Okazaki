(async () => {
  const state = () => window.__okazaki.getState(), results = [];
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const assert = (ok, name) => { results.push({ok:Boolean(ok),name}); if (!ok) throw new Error(name); };
  const until = async (predicate) => {
    const end = performance.now() + 8000;
    while (!predicate() && performance.now() < end) await wait(100);
  };
  assert(state().xr && state().ui.mobile && state().vrPanel.visible && state().vrPanel.panelCount === 1 &&
    state().vrReturn.buttonVisible && state().vrPanel.actionRects.return?.enabled,
    "mobile-VR-has-return-in-one-central-panel");
  const left = window.__xrTestDevice.controllers.left;
  left.updateButtonValue("x-button", 0); await wait(200);
  if (state().panelVisible) {
    left.updateButtonValue("x-button", 1); await wait(250);
    left.updateButtonValue("x-button", 0); await wait(250);
  }
  assert(!state().panelVisible && !state().vrPanel.expanded && state().vrPanel.visible &&
    state().vrReturn.buttonVisible && state().vrPanel.actionRects.return?.enabled,
    "mobile-folded-content-keeps-central-return-action");
  const origin = performance.timeOrigin;
  left.updateButtonValue("x-button", 1); await until(() => !state().xr);
  left.setButtonValueImmediate("x-button", 0);
  assert(!state().xr && !state().free && state().ui.mobile && !state().touch.enabled &&
    performance.timeOrigin === origin, "mobile-X-hold-restores-same-page-with-motion-stopped");
  document.querySelector('[data-mobile-panel="settings"]').click();
  await until(() => !document.querySelector("#enter-vr").disabled);
  const entry = document.querySelector("#enter-vr"), rect = entry.getBoundingClientRect();
  assert(state().ui.open && entry.textContent === "VRに戻る" && rect.width > 0 &&
    rect.top >= 0 && rect.bottom <= innerHeight, "mobile-settings-shows-reachable-VR-resume-button");
  return JSON.stringify({passed:true,environment:"IWER mobile viewport, NOT physical Quest or smartphone",results});
})();
