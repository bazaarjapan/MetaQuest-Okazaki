// Run AFTER entering local ?testxr IWER VR. No server/browser is started here.
// The script exercises actual app input, XR session boundaries and camera poses.
(async () => {
  const results = [];
  const device = window.__xrTestDevice;
  const state = () => window.__okazaki.getState();
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const assert = (ok, name, detail) => {
    results.push({ ok: Boolean(ok), name, detail });
    if (!ok) throw new Error(name);
  };
  const waitUntil = async (condition, timeout = 8000) => {
    const deadline = performance.now() + timeout;
    while (!condition() && performance.now() < deadline) await wait(100);
    return condition();
  };
  const distance = (a, b) => a?.length === 3 && b?.length === 3
    ? Math.hypot(...a.map((value, index) => value - b[index])) : Infinity;
  const quaternionAngle = (a, b) => {
    if (a?.length !== 4 || b?.length !== 4) return Infinity;
    const magnitude = Math.hypot(...a) * Math.hypot(...b);
    const dot = Math.abs(a.reduce((total, value, index) => total + value * b[index], 0) / magnitude);
    return 2 * Math.acos(Math.min(1, Math.max(0, dot)));
  };
  const vector = (v) => [v.x, v.y, v.z];
  const quaternion = (q) => [q.x, q.y, q.z, q.w];
  const rotate = ([x, y, z], [qx, qy, qz, qw]) => {
    // q * v * inverse(q), without exposing the app's Three.js objects.
    const ix = qw * x + qy * z - qz * y;
    const iy = qw * y + qz * x - qx * z;
    const iz = qw * z + qx * y - qy * x;
    const iw = -qx * x - qy * y - qz * z;
    return [
      ix * qw - iw * qx - iy * qz + iz * qy,
      iy * qw - iw * qy - iz * qx + ix * qz,
      iz * qw - iw * qz - ix * qy + iy * qx,
    ];
  };
  const multiplyQuaternion = ([ax, ay, az, aw], [bx, by, bz, bw]) => [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
  const headEulerQuaternion = (yaw, pitch, roll) => multiplyQuaternion(
    multiplyQuaternion([0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)], [Math.sin(pitch / 2), 0, 0, Math.cos(pitch / 2)]),
    [0, 0, Math.sin(roll / 2), Math.cos(roll / 2)],
  );
  const headPitchRoll = ([x, y, z, w]) => ({
    // YXZ Euler: global yaw mixes quaternion X/Z components, but does not
    // change the physical pitch/roll recovered from these matrix entries.
    pitch: Math.asin(Math.max(-1, Math.min(1, 2 * (w * x - y * z)))),
    roll: Math.atan2(2 * (x * y + w * z), 1 - 2 * (x * x + z * z)),
  });
  const release = (hand, id) => {
    const controller = device.controllers[hand];
    // Outside XR there are no frames to commit IWER's pending button value.
    if (typeof controller.setButtonValueImmediate === "function") controller.setButtonValueImmediate(id, 0);
    else controller.updateButtonValue(id, 0);
    controller.updateButtonTouch(id, false);
  };
  const clickButton = async (hand, id) => {
    device.controllers[hand].updateButtonValue(id, 1);
    await wait(350);
    release(hand, id);
    await wait(350);
  };
  const poseMatches = (actualPosition, actualQuaternion, expected) =>
    distance(actualPosition, expected?.position) < 0.35 && quaternionAngle(actualQuaternion, expected?.quaternion) < 0.1;
  const pageOrigin = performance.timeOrigin;
  const diagnosticsIdentity = window.__okazaki;
  const viewportIdentity = document.querySelector("#viewport");
  const pageUnchanged = () => performance.timeOrigin === pageOrigin && window.__okazaki === diagnosticsIdentity &&
    document.querySelector("#viewport") === viewportIdentity;
  let initialPoses;
  let report;
  try {
    assert(Boolean(device && window.__okazaki), "local-emulator-and-app-diagnostics-available");
    assert(state().xr && state().ready && Boolean(state().vrReturn), "initial-immersive-session-with-return-contract", state().vrReturn);
    initialPoses = Object.fromEntries(["left", "right"].map((hand) => [hand, {
      position: vector(device.controllers[hand].position), quaternion: quaternion(device.controllers[hand].quaternion),
      connected: device.controllers[hand].connected,
    }]));
    for (const hand of ["left", "right"]) {
      device.controllers[hand].connected = true;
      device.controllers[hand].updateAxes("thumbstick", 0, 0);
      for (const id of ["trigger", "squeeze", hand === "left" ? "x-button" : "a-button", hand === "left" ? "y-button" : "b-button"]) release(hand, id);
    }
    // Reset only for a deterministic test starting pose, never during resume.
    await clickButton("left", "y-button");
    assert(state().vrReturn.buttonVisible && state().panelVisible, "standalone-return-button-visible-in-vr", state().vrReturn);
    const buttonLayout = state().vrReturn.button;
    assert(buttonLayout?.position?.length === 3 && buttonLayout?.size?.length === 2 && buttonLayout.position[1] > state().guide.position[1],
      "return-button-is-small-and-above-upper-right-guide", buttonLayout);

    const shortBefore = state().panelVisible;
    device.controllers.left.updateButtonValue("x-button", 1);
    await waitUntil(() => state().vrReturn.holdProgress > 0);
    assert(state().xr && state().panelVisible === shortBefore && state().vrReturn.holdProgress > 0 && state().vrReturn.holdProgress < 1,
      "X-short-press-waits-for-release-before-toggling-guide", state().vrReturn);
    release("left", "x-button");
    await waitUntil(() => state().panelVisible !== shortBefore);
    assert(state().xr && !state().panelVisible && state().vrReturn.buttonVisible,
      "X-short-release-hides-guide-but-keeps-return-button-visible", state().vrReturn);
    await clickButton("left", "x-button");
    assert(state().panelVisible && state().xr, "second-X-short-release-restores-guide");

    // A visibility interruption cancels the gesture, not just its visual gauge.
    if (typeof device.updateVisibilityState === "function") {
      const panelBeforeVisibility = state().panelVisible;
      device.controllers.left.updateButtonValue("x-button", 1);
      await waitUntil(() => state().vrReturn.holdProgress > 0);
      device.updateVisibilityState("visible-blurred");
      await waitUntil(() => device.visibilityState === "visible-blurred" && state().vrReturn.holdProgress === 0);
      assert(state().xr && device.visibilityState === "visible-blurred" && state().vrReturn.holdProgress === 0 && !state().vrReturn.exiting,
        "visibility-loss-cancels-X-hold-without-exit", state().vrReturn);
      release("left", "x-button");
      await wait(350);
      device.updateVisibilityState("visible");
      await waitUntil(() => device.visibilityState === "visible");
      await wait(350);
      assert(state().xr && state().panelVisible === panelBeforeVisibility && state().vrReturn.holdProgress === 0,
        "cancelled-visibility-hold-does-not-become-short-guide-toggle", state().vrReturn);
    } else {
      results.push({ ok: true, skipped: true, name: "visibility-cancellation-unavailable-in-this-IWER-build" });
    }

    const panelBeforeDisconnect = state().panelVisible;
    device.controllers.left.updateButtonValue("x-button", 1);
    await waitUntil(() => state().vrReturn.holdProgress > 0);
    device.controllers.left.connected = false;
    await waitUntil(() => !state().hud.hands.left.connected && state().vrReturn.holdProgress === 0);
    assert(state().xr && !state().hud.hands.left.connected && state().vrReturn.holdProgress === 0 && !state().vrReturn.exiting,
      "controller-loss-cancels-X-hold-without-exit", state().vrReturn);
    release("left", "x-button");
    device.controllers.left.connected = true;
    await waitUntil(() => state().hud.hands.left.connected);
    await wait(350);
    assert(state().xr && state().panelVisible === panelBeforeDisconnect,
      "cancelled-disconnected-hold-does-not-toggle-guide-on-reconnect", state().vrReturn);

    // A non-starting-location view and a turned physical head catch east-reset,
    // eye-height offset and orientation-loss regressions across session changes.
    await clickButton("right", "a-button");
    if (!state().free) await clickButton("right", "b-button");
    device.controllers.right.updateAxes("thumbstick", 0.59, -0.59);
    await wait(900);
    device.controllers.right.updateAxes("thumbstick", 0, 0);
    if (state().free) await clickButton("right", "b-button");
    device.position.x += 0.12;
    const angle = 0.28;
    device.quaternion.set(0, Math.sin(angle / 2), 0, Math.cos(angle / 2));
    await wait(450);
    const beforeLong = state().vrReturn.view;
    assert(beforeLong?.position?.length === 3 && beforeLong?.quaternion?.length === 4 &&
      distance(beforeLong.position, [195, 76, 105]) > 10,
      "current-world-eye-pose-is-captured-away-from-start-view", beforeLong);
    const guideBeforeLong = state().panelVisible;
    const holdStartedAt = performance.now();
    device.controllers.left.updateButtonValue("x-button", 1);
    await waitUntil(() => state().vrReturn.holdProgress > 0.1 || !state().xr);
    assert(state().xr && state().panelVisible === guideBeforeLong && state().vrReturn.buttonVisible &&
      state().vrReturn.holdProgress > 0 && state().vrReturn.holdProgress < 1,
      "X-long-hold-shows-progress-without-premature-guide-toggle-or-exit", state().vrReturn);
    await waitUntil(() => !state().xr);
    const exitElapsedMs = performance.now() - holdStartedAt;
    release("left", "x-button");
    await wait(450);
    const afterLong = state();
    assert(!afterLong.xr && exitElapsedMs >= 1450 && afterLong.vrReturn.hasResume && !afterLong.vrReturn.exiting,
      "X-long-hold-at-least-one-and-half-seconds-exits-to-2D", { exitElapsedMs, vrReturn: afterLong.vrReturn });
    assert(poseMatches(afterLong.camera, afterLong.cameraQuaternion, beforeLong),
      "2D-camera-preserves-last-VR-eye-position-and-orientation", { before: beforeLong, position: afterLong.camera, quaternion: afterLong.cameraQuaternion });
    assert(pageUnchanged() && !afterLong.vrReturn.buttonVisible,
      "VR-return-keeps-the-same-page-model-and-hides-spatial-return-button", afterLong.vrReturn);
    assert(!afterLong.free && !document.querySelector("#quality-select").disabled,
      "2D-return-stops-flight-and-unlocks-quality-selector");

    await waitUntil(() => !document.querySelector("#enter-vr").disabled);
    document.querySelector("#enter-vr").click();
    await waitUntil(() => state().xr && state().vrReturn.buttonVisible);
    await wait(450);
    const resumed = state();
    assert(resumed.xr && poseMatches(resumed.vrReturn.view?.position, resumed.vrReturn.view?.quaternion, beforeLong),
      "VR-resume-preserves-same-world-eye-view-instead-of-east-reset", { expected: beforeLong, resumed: resumed.vrReturn.view });
    assert(distance(resumed.head, [195, 76, 105]) > 10 && !resumed.free && pageUnchanged(),
      "resumed-location-remains-nonstarting-and-stationary-without-page-reload", resumed.vrReturn);

    if (state().panelVisible) await clickButton("left", "x-button");
    assert(!state().panelVisible && state().vrReturn.buttonVisible,
      "standalone-return-button-still-available-with-guide-hidden-on-resume", state().vrReturn);
    const beforeTrigger = state().vrReturn.view;
    const placement = state().vrReturn.button.position;
    const headOrientation = quaternion(device.quaternion);
    const targetOrigin = rotate([placement[0], placement[1], -0.25], headOrientation);
    const headOrigin = vector(device.position);
    device.controllers.right.position.set(...targetOrigin.map((value, index) => value + headOrigin[index]));
    device.controllers.right.quaternion.set(...headOrientation);
    await wait(450);
    device.controllers.right.updateButtonValue("trigger", 1);
    await waitUntil(() => !state().xr);
    release("right", "trigger");
    await wait(450);
    assert(!state().xr && state().vrReturn.hasResume && !state().vrReturn.buttonVisible,
      "controller-trigger-can-return-to-2D-with-guide-hidden", state().vrReturn);
    assert(poseMatches(state().camera, state().cameraQuaternion, beforeTrigger) && pageUnchanged(),
      "trigger-return-also-preserves-eye-pose-and-page", { before: beforeTrigger, position: state().camera, quaternion: state().cameraQuaternion });

    // A fixed, tilted physical pose catches roll loss and repeated session-centre
    // offsets. Move in the room once, then hold the same HMD pose for all cycles.
    device.position.x += 0.23;
    device.position.y += 0.11;
    device.position.z -= 0.17;
    device.quaternion.set(...headEulerQuaternion(0.28, 0.18, -0.12));
    let cycleBaseline;
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      await waitUntil(() => !document.querySelector("#enter-vr").disabled);
      document.querySelector("#enter-vr").click();
      await waitUntil(() => state().xr && state().vrReturn.buttonVisible);
      await wait(450);
      const cycleView = JSON.parse(JSON.stringify(state().vrReturn.view));
      const tilt = cycleView?.quaternion?.length === 4 ? headPitchRoll(cycleView.quaternion) : null;
      assert(state().xr && cycleView?.position?.every(Number.isFinite) && cycleView?.quaternion?.every(Number.isFinite) &&
        Math.abs(tilt.pitch - 0.18) <= 0.01 && Math.abs(tilt.roll + 0.12) <= 0.01,
        `tilted-cycle-${cycle}-physical-head-pitch-and-roll-present`, { view: cycleView, tilt });
      if (!cycleBaseline) cycleBaseline = cycleView;
      else assert(distance(cycleView.position, cycleBaseline.position) <= 0.02 && quaternionAngle(cycleView.quaternion, cycleBaseline.quaternion) <= 0.02,
        `tilted-cycle-${cycle}-VR-reentry-has-no-accumulated-eye-pose-drift`, { baseline: cycleBaseline, view: cycleView });

      if (cycle === 1) {
        if (state().panelVisible) await clickButton("left", "x-button");
        const placement = state().vrReturn.button.position;
        const orientation = quaternion(device.quaternion);
        const origin = rotate([placement[0], placement[1], -0.25], orientation);
        const head = vector(device.position);
        device.controllers.right.position.set(...origin.map((value, index) => value + head[index]));
        device.controllers.right.quaternion.set(...orientation);
        await wait(450);
        device.controllers.right.updateButtonValue("trigger", 1);
        await waitUntil(() => !state().xr);
        release("right", "trigger");
      } else if (cycle === 2) {
        device.controllers.left.updateButtonValue("x-button", 1);
        await waitUntil(() => !state().xr);
        release("left", "x-button");
      } else {
        // IWER's public activeSession getter exposes the ordinary XRSession API.
        // Ending it here emulates the browser/system exit rather than app UI.
        const activeSession = device.activeSession;
        assert(typeof activeSession?.end === "function", "public-emulator-active-session-external-exit-available");
        await activeSession.end();
        await waitUntil(() => !state().xr);
      }
      await wait(450);
      const desktop = state();
      assert(!desktop.xr && desktop.vrReturn.hasResume && !desktop.vrReturn.exiting &&
        distance(desktop.camera, cycleView.position) <= 0.02 && quaternionAngle(desktop.cameraQuaternion, cycleView.quaternion) <= 0.02,
        `tilted-cycle-${cycle}-2D-position-pitch-and-roll-preserved`, { source: cycleView, position: desktop.camera, quaternion: desktop.cameraQuaternion });
      assert(distance(desktop.camera, cycleBaseline.position) <= 0.02 && quaternionAngle(desktop.cameraQuaternion, cycleBaseline.quaternion) <= 0.02 && pageUnchanged(),
        `tilted-cycle-${cycle}-no-session-cumulative-drift-or-page-reload`, { baseline: cycleBaseline, position: desktop.camera, quaternion: desktop.cameraQuaternion });
      const idleOrientation = [...desktop.cameraQuaternion];
      await wait(450);
      assert(quaternionAngle(state().cameraQuaternion, idleOrientation) <= 0.005 && distance(state().camera, desktop.camera) <= 0.005,
        `tilted-cycle-${cycle}-2D-orbit-update-does-not-flatten-pitch-or-roll`, { initial: idleOrientation, later: state().cameraQuaternion });
    }
    report = { passed: true, environment: "IWER Meta Quest 3 emulator, NOT physical headset", results, state: state() };
  } catch (error) {
    report = { passed: false, environment: "IWER Meta Quest 3 emulator, NOT physical headset", error: error.message, results, state: window.__okazaki?.getState() };
  } finally {
    if (device) {
      device.updateVisibilityState?.("visible");
      for (const hand of ["left", "right"]) {
        const controller = device.controllers[hand];
        controller.connected = initialPoses?.[hand].connected ?? true;
        controller.updateAxes("thumbstick", 0, 0);
        for (const id of ["trigger", "squeeze", hand === "left" ? "x-button" : "a-button", hand === "left" ? "y-button" : "b-button"]) release(hand, id);
        if (initialPoses) {
          controller.position.set(...initialPoses[hand].position);
          controller.quaternion.set(...initialPoses[hand].quaternion);
        }
      }
    }
  }
  window.__returnXRReport = report;
  return JSON.stringify(report);
})();
