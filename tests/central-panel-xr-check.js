// Run in the local IWER development build after entering VR as a guest.
// Only emulator physical inputs are changed; application state is never patched.
(async () => {
  const device = window.__xrTestDevice, state = () => window.__okazaki.getState();
  const results = [], pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const check = (value, name, detail) => {
    results.push({ok: Boolean(value), name, detail});
    if (!value) throw new Error(name);
  };
  const until = async (predicate, name) => {
    const deadline = performance.now() + 8000;
    while (!predicate()) {
      if (performance.now() > deadline) throw new Error(`${name}: timeout`);
      await pause(50);
    }
  };
  const release = (hand, id) => {
    const controller = device.controllers[hand];
    controller.updateButtonValue(id, 0); controller.updateButtonTouch(id, false);
  };
  const button = async (hand, id) => {
    device.controllers[hand].updateButtonValue(id, 1);
    try { await pause(250); } finally { release(hand, id); }
    await pause(250);
  };
  const point = async (hand, action, predicate) => {
    const panel = state().vrPanel, rect = panel.actionRects[action];
    check(Boolean(rect?.enabled), `enabled-${action}`);
    device.controllers[hand].position.set(
      panel.position[0] + ((rect.x + rect.w / 2) / panel.canvas[0] - .5) * panel.size[0],
      device.position.y + panel.position[1] + (.5 - (rect.y + rect.h / 2) / panel.canvas[1]) * panel.size[1], -.3);
    device.controllers[hand].quaternion.set(0, 0, 0, 1);
    // Keep the other ray away from the UI so its hover cannot replace this one.
    const other = hand === "left" ? "right" : "left";
    device.controllers[other].position.set(2, .5, -.3);
    device.controllers[other].quaternion.set(0, 0, 0, 1);
    await until(() => state().vrPanel.hovered === action, `hover-${action}`);
    check(state().vrPanel.hovered === action, `ray-hover-${hand}-${action}`);
    device.controllers[hand].updateButtonValue("trigger", 1);
    try { await until(predicate, `trigger-${action}`); }
    finally { release(hand, "trigger"); }
    await pause(200);
  };
  const onePanel = () => {
    const current = state();
    return current.vrPanel.visible && current.vrPanel.panelCount === 1 && current.vrPanel.meshCount === 1 &&
      !current.vrWorkshop.spatialVisible && ["left", "right"].every(hand => !current.hud.hands[hand].spatialVisible);
  };
  let report;
  try {
    check(Boolean(device) && state().xr && state().vrPanel, "local-immersive-central-panel-available");
    check(!state().school.user, "guest-permission-test-not-real-google-login");
    device.position.set(0, 1.6, 0); device.quaternion.set(0, 0, 0, 1);
    for (const hand of ["left", "right"]) {
      device.controllers[hand].connected = true;
      device.controllers[hand].updateAxes("thumbstick", 0, 0);
      for (const id of ["trigger", "squeeze", hand === "left" ? "x-button" : "a-button", hand === "left" ? "y-button" : "b-button"]) release(hand, id);
    }
    await pause(250);
    check(onePanel(), "exactly-one-spatial-ui-panel-no-separate-hud-workshop-or-exit");
    const layout = state().vrPanel;
    check(Math.abs(layout.position[0]) < .001 && Math.abs(layout.position[1]) < .001 && layout.position[2] < -1,
      "head-relative-panel-centered", {position:layout.position,size:layout.size});
    const exit = layout.actionRects.return;
    const exitArea = exit.w / layout.canvas[0] * layout.size[0] * exit.h / layout.canvas[1] * layout.size[1];
    check(exitArea > .82 * .16, "return-hit-area-larger-than-old-standalone-button", {exitArea});
    const viewpoint = layout.actionRects.overview;
    check(viewpoint.w / layout.canvas[0] * layout.size[0] > 300 / 1024 * .82 &&
      viewpoint.h / layout.canvas[1] * layout.size[1] > 84 / 512 * .41,
      "viewpoint-real-width-and-height-enlarged");
    await point("left", "west", () => state().current === "west");
    check(state().current === "west" && !state().free, "left-trigger-selects-viewpoint-and-stops-movement");
    await point("right", "east", () => state().current === "east");
    check(state().current === "east" && !state().free, "right-trigger-selects-viewpoint");
    await point("right", "free", () => state().free);
    device.controllers.right.updateAxes("thumbstick", .59, 0);
    await until(() => state().hud.hands.right.stickPercent > 0, "embedded-live-stick-input");
    check(state().hud.hands.right.embeddedVisible && !state().hud.hands.right.spatialVisible &&
      state().flight.horizontalSpeed > 0, "live-stick-and-movement-in-central-hud");
    device.controllers.right.updateAxes("thumbstick", 0, 0);
    await point("left", "free", () => !state().free);
    check(state().flight.horizontalSpeed === 0, "central-free-button-stops-input-safely");
    await point("right", "tab-region", () => state().vrPanel.tab === "region");
    check(onePanel() && state().vrPanel.actionRects.return.enabled, "region-tab-reuses-panel-and-retains-exit");
    await point("left", "tab-workshop", () => state().vrPanel.tab === "workshop");
    check(onePanel() && state().vrPanel.actionRects.return.enabled, "workshop-tab-reuses-panel-and-retains-exit");
    check(!state().vrWorkshop.canEdit && state().vrWorkshop.actions.every(action => !action.enabled),
      "guest-workshop-buttons-remain-disabled");
    const tab = state().vrPanel.tab;
    await button("left", "x-button");
    check(!state().panelVisible && !state().vrPanel.expanded && onePanel() && state().vrPanel.actionRects.return.enabled,
      "short-X-folds-same-panel-and-keeps-centered-exit");
    await point("left", "expand", () => state().vrPanel.expanded);
    check(state().panelVisible && state().vrPanel.tab === tab && onePanel(), "left-trigger-expands-folded-workshop-without-extra-panels");
    await point("right", "tab-observe", () => state().vrPanel.tab === "observe");
    check(onePanel() && state().hud.hands.left.embeddedVisible && state().hud.hands.right.embeddedVisible,
      "observation-tab-restores-both-embedded-controllers");
    report = {passed:true,environment:"Native browser with IWER Quest 3 emulator; NOT physical Quest",results};
  } catch (error) {
    report = {passed:false,error:String(error?.message || error),results};
  } finally {
    for (const hand of ["left", "right"]) {
      device?.controllers[hand].updateAxes("thumbstick", 0, 0);
      for (const id of ["trigger", "x-button", "y-button", "a-button", "b-button"]) {
        if ((hand === "left" && ["a-button","b-button"].includes(id)) ||
          (hand === "right" && ["x-button","y-button"].includes(id))) continue;
        if (device) release(hand,id);
      }
    }
  }
  window.__centralPanelXRReport = report;
  return JSON.stringify(report);
})();
