// Run in the local ?testxr IWER browser AFTER entering immersive VR.
// This is acceptance evidence for an emulator, never a physical Quest result.
(async () => {
  const results = [];
  const device = window.__xrTestDevice;
  const state = () => window.__okazaki.getState();
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const near = (actual, expected, tolerance = 0.025) => Math.abs(actual - expected) < tolerance;
  const assert = (ok, name, detail) => {
    results.push({ ok: Boolean(ok), name, detail });
    if (!ok) throw new Error(name);
  };
  const waitUntil = async (condition) => {
    const deadline = performance.now() + 3500;
    while (!condition() && performance.now() < deadline) await wait(100);
    return condition();
  };
  const button = async (hand, id) => {
    device.controllers[hand].updateButtonValue(id, 1);
    await wait(350);
    device.controllers[hand].updateButtonValue(id, 0);
    await wait(350);
  };
  const hudHand = (hand) => state().hud.hands[hand];
  const bothVisible = () => ["left", "right"].every((hand) => hudHand(hand).spatialVisible && !hudHand(hand).previewVisible);
  const neutral = () => ["left", "right"].every((hand) => {
    const input = hudHand(hand);
    return input.rawAxes.every((axis) => near(axis, 0)) && input.normalizedStick.every((axis) => near(axis, 0)) &&
      input.buttons.every((entry) => near(entry.value, 0) && !entry.pressed && !entry.touched) && input.stickPercent === 0;
  });
  let poses;
  let report;
  try {
    assert(Boolean(device && window.__okazaki), "development-emulator-and-readonly-diagnostics-available");
    assert(state().xr && state().ready, "immersive-session-active-and-city-ready", { xr: state().xr, ready: state().ready });
    poses = Object.fromEntries(["left", "right"].map((hand) => {
      const controller = device.controllers[hand];
      return [hand, {
        position: [controller.position.x, controller.position.y, controller.position.z],
        quaternion: [controller.quaternion.x, controller.quaternion.y, controller.quaternion.z, controller.quaternion.w],
      }];
    }));
    // Keep rays away from the upper-right guide while testing trigger gauges.
    device.controllers.left.position.set(-0.35, 1.25, -0.25);
    device.controllers.right.position.set(0.25, 1.25, -0.25);
    for (const hand of ["left", "right"]) {
      device.controllers[hand].quaternion.set(0, 0, 0, 1);
      device.controllers[hand].updateAxes("thumbstick", 0, 0);
    }
    await button("left", "y-button");
    await waitUntil(() => hudHand("left").connected && hudHand("right").connected);
    assert(hudHand("left").connected && hudHand("right").connected, "both-controller-inputs-connected", state().hud.hands);
    assert(bothVisible(), "two-lower-corner-spatial-huds-visible-and-desktop-previews-hidden", state().hud);
    const { guide, hud } = state();
    assert(guide.position[0] > 0 && guide.position[1] > 0 && guide.position[2] < -1,
      "guide-moved-to-upper-right-head-relative-position", guide);
    assert(guide.position[0] - guide.size[0] / 2 > 0 && guide.position[1] - guide.size[1] / 2 > 0,
      "guide-does-not-cover-centre-reticle", guide);
    assert(hud.layout.left.position[0] < 0 && hud.layout.right.position[0] > 0 &&
      hud.layout.left.position[1] < 0 && hud.layout.right.position[1] < 0,
      "controller-huds-order-left-right-below-view-centre", hud.layout);
    assert(hud.layout.left.position[0] + hud.layout.left.size[0] / 2 < -0.3 &&
      hud.layout.right.position[0] - hud.layout.right.size[0] / 2 > 0.3,
      "controller-huds-preserve-central-city-corridor", hud.layout);

    const selector = document.querySelector("#quality-select");
    const currentQuality = state().quality.id;
    assert(selector?.disabled && document.querySelector("#quality-note")?.textContent.includes("2D画面に戻って"),
      "quality-selection-locked-during-immersive-session", { disabled: selector?.disabled, note: document.querySelector("#quality-note")?.textContent });
    selector.value = currentQuality === "high" ? "performance" : "high";
    selector.dispatchEvent(new Event("change", { bubbles: true }));
    await wait(200);
    assert(state().quality.id === currentQuality && !state().qualityLoading,
      "programmatic-quality-change-cannot-resize-live-xr-framebuffer", state().quality);
    selector.value = currentQuality;

    await button("right", "b-button");
    assert(state().free && hudHand("left").active && hudHand("right").active,
      "B-enables-flight-and-both-hud-active-indicators", state().hud);
    device.controllers.right.updateAxes("thumbstick", 0, -0.59);
    await waitUntil(() => near(hudHand("right").rawAxes[1], -0.59) && near(state().flight.horizontalSpeed, 6));
    assert(near(hudHand("right").rawAxes[0], 0) && near(hudHand("right").rawAxes[1], -0.59) && hudHand("right").stickPercent === 59,
      "right-stick-physical-deflection-reflected-in-dot-and-percent", hudHand("right"));
    assert(near(hudHand("right").normalizedStick[1], -0.5) && near(state().flight.horizontalSpeed, 6),
      "right-stick-deadzoned-half-travel-matches-six-metres-per-second", { input: hudHand("right"), flight: state().flight });
    device.controllers.right.updateAxes("thumbstick", 0, 0);
    await waitUntil(() => hudHand("right").stickPercent === 0);

    const right = device.controllers.right;
    right.updateButtonTouch("trigger", true);
    await waitUntil(() => hudHand("right").buttons[0].touched);
    assert(hudHand("right").buttons[0].touched && !hudHand("right").buttons[0].pressed && near(hudHand("right").buttons[0].value, 0),
      "trigger-touch-without-press-is-distinguished", hudHand("right").buttons[0]);
    right.updateButtonValue("trigger", 0.27);
    right.updateButtonValue("squeeze", 0.83);
    await waitUntil(() => near(hudHand("right").buttons[0].value, 0.27) && near(hudHand("right").buttons[1].value, 0.83));
    assert(near(hudHand("right").buttons[0].value, 0.27) && near(hudHand("right").buttons[1].value, 0.83),
      "trigger-and-grip-progress-bars-preserve-partial-analog-input", hudHand("right").buttons.slice(0, 2));
    assert(hudHand("right").buttons[0].pressed && hudHand("right").buttons[0].touched &&
      hudHand("right").buttons[1].pressed && hudHand("right").buttons[1].touched &&
      (hudHand("right").pressedButtonBits & 3) === 3,
      "trigger-grip-press-touch-and-bit-flags-match-input", hudHand("right"));
    right.updateButtonValue("trigger", 0);
    right.updateButtonValue("squeeze", 0);
    right.updateButtonTouch("trigger", false);
    right.updateButtonTouch("squeeze", false);
    right.updateButtonTouch("a-button", true);
    await waitUntil(() => hudHand("right").buttons[4].touched);
    assert(hudHand("right").buttons[4].touched && !hudHand("right").buttons[4].pressed &&
      (hudHand("right").touchedButtonBits & (1 << 4)) !== 0,
      "A-button-touch-highlight-preserves-unpressed-state", hudHand("right"));
    right.updateButtonTouch("a-button", false);

    device.controllers.left.updateButtonValue("x-button", 1);
    await waitUntil(() => hudHand("left").buttons[4].pressed);
    assert(state().panelVisible && hudHand("left").buttons[4].pressed &&
      (hudHand("left").pressedButtonBits & (1 << 4)) !== 0,
      "X-press-updates-button-chip-without-toggling-guide-until-release", { guideVisible: state().panelVisible, left: hudHand("left") });
    device.controllers.left.updateButtonValue("x-button", 0);
    await wait(350);
    assert(!state().panelVisible && bothVisible(), "short-X-release-hides-guide-and-keeps-both-controller-huds-visible", state().hud);
    await button("left", "x-button");
    assert(state().panelVisible && bothVisible(), "X-restores-guide-with-huds-still-visible", state().hud);
    await waitUntil(neutral);
    assert(neutral() && near(state().flight.horizontalSpeed, 0) && near(state().flight.verticalSpeed, 0),
      "release-clears-stick-button-gauge-state-and-stops-motion", state().hud.hands);
    // Input state is fresh on every frame; wait for the final <=15Hz upload too.
    await wait(300);
    const stableCount = state().hud.renderCount;
    await wait(400);
    assert(state().hud.renderCount === stableCount, "unchanged-neutral-input-skips-texture-redraw", { before: stableCount, after: state().hud.renderCount });
    await button("left", "y-button");
    assert(!state().free && !hudHand("left").active && !hudHand("right").active && bothVisible(),
      "reset-disables-motion-indicators-without-hiding-huds", state().hud);
    device.controllers.left.updateAxes("thumbstick", 0.59, -0.59);
    await waitUntil(() => hudHand("left").stickPercent > 0);
    device.controllers.left.connected = false;
    await waitUntil(() => !hudHand("left").connected);
    assert(!hudHand("left").connected && hudHand("left").rawAxes.every((axis) => near(axis, 0)) &&
      hudHand("left").buttons.every((entry) => near(entry.value, 0) && !entry.pressed),
      "input-source-detach-clears-controller-data-instead-of-leaving-stale-stick", hudHand("left"));
    assert(hudHand("right").connected && bothVisible(),
      "one-controller-detach-keeps-other-input-and-both-display-panels", state().hud);
    device.controllers.left.updateAxes("thumbstick", 0, 0);
    device.controllers.left.connected = true;
    await waitUntil(() => hudHand("left").connected);
    assert(hudHand("left").connected && hudHand("left").stickPercent === 0,
      "controller-reconnect-restores-neutral-live-status", hudHand("left"));
    report = { passed: true, environment: "IWER Meta Quest 3 emulator, NOT physical headset", results, state: state() };
  } catch (error) {
    report = { passed: false, environment: "IWER Meta Quest 3 emulator, NOT physical headset", error: error.message, results, state: window.__okazaki?.getState() };
  } finally {
    if (poses && device) {
      for (const hand of ["left", "right"]) {
        const controller = device.controllers[hand];
        controller.connected = true;
        controller.updateAxes("thumbstick", 0, 0);
        for (const id of ["trigger", "squeeze", "thumbstick", hand === "left" ? "x-button" : "a-button", hand === "left" ? "y-button" : "b-button"]) {
          controller.updateButtonValue(id, 0);
          controller.updateButtonTouch(id, false);
        }
        controller.position.set(...poses[hand].position);
        controller.quaternion.set(...poses[hand].quaternion);
      }
    }
  }
  window.__detailXRReport = report;
  return JSON.stringify(report);
})();
