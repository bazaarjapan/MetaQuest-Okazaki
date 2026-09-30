(async () => {
  const d = window.__xrTestDevice,
    s = () => window.__okazaki.getState(),
    results = [],
    wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const assert = (ok, name, detail) => {
    results.push({ ok, name, detail });
    if (!ok) throw new Error(JSON.stringify(results));
  };
  const difference = (after, before) => after.map((v, i) => v - before[i]);
  const distance = (after, before) => Math.hypot(...difference(after, before));
  const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
  const near = (actual, expected) => Math.abs(actual - expected) < 0.05;
  // SwiftShader may render fewer frames than wall time suggests. The app caps
  // each frame's dt, so compare real transforms with its integrated XR time.
  const rate = (before, after, value) =>
    value / (after.simulationSeconds - before.simulationSeconds);
  const rateNear = (actual, expected) =>
    Number.isFinite(actual) &&
    Math.abs(actual - expected) <= Math.abs(expected) * 0.15 + 0.02;
  const horizontalDistance = (after, before) =>
    Math.hypot(after[0] - before[0], after[2] - before[2]);
  const idleSpeeds = () =>
    near(s().flight.horizontalSpeed, 0) && near(s().flight.verticalSpeed, 0);
  const button = async (hand, id) => {
    d.controllers[hand].updateButtonValue(id, 1);
    await wait(180);
    d.controllers[hand].updateButtonValue(id, 0);
    await wait(180);
  };
  const point = async (x, y) => {
    const guide = s().guide;
    d.controllers.right.position.set(
      guide.position[0] + (x / 1024 - 0.5) * guide.size[0],
      1.6 + guide.position[1] + (0.5 - y / 512) * guide.size[1],
      -0.3,
    );
    d.controllers.right.quaternion.set(0, 0, 0, 1);
    await wait(200);
    await button("right", "trigger");
  };
  assert(s().xr && s().panelVisible, "immersive-session-stereo-panel", s());
  await button("right", "a-button");
  assert(
    s().current === "west" && distance(s().head, [-70, 76, 10]) < 0.1,
    "A-next-viewpoint-exact-position",
    s().head,
  );
  await button("left", "y-button");
  assert(
    s().current === "east" && distance(s().head, [195, 76, 105]) < 0.1,
    "Y-return-exact-position",
    s().head,
  );
  const disabledPosition = s().head,
    disabledYaw = s().rigYaw;
  d.controllers.right.updateAxes("thumbstick", 0, -1);
  d.controllers.left.updateAxes("thumbstick", 1, -1);
  await wait(300);
  assert(
    !s().free &&
      distance(s().head, disabledPosition) < 0.1 &&
      Math.abs(s().rigYaw - disabledYaw) < 0.001 &&
      idleSpeeds(),
    "sticks-inactive-until-flight-enabled",
    s(),
  );
  d.controllers.right.updateAxes("thumbstick", 0, 0);
  d.controllers.left.updateAxes("thumbstick", 0, 0);
  await wait(100);
  await button("left", "x-button");
  assert(!s().panelVisible, "X-hide-panel");
  await button("left", "x-button");
  assert(s().panelVisible, "X-show-panel");
  const beforeHead = s().head;
  d.position.x += 0.15;
  await wait(200);
  assert(distance(s().head, beforeHead) > 0.1, "head-pose-tracked");
  d.position.x -= 0.15;
  await wait(200);
  await point(182, 192);
  assert(s().current === "overview", "trigger-ray-select-overview", s());
  await point(512, 192);
  assert(s().current === "east", "trigger-ray-select-east", s());
  const enabledPosition = s().head;
  await point(267, 303);
  assert(
    s().free &&
      s().current === "east" &&
      distance(s().head, enabledPosition) < 0.1 &&
      idleSpeeds(),
    "trigger-enable-free-flight-preserves-viewpoint",
    s(),
  );
  const heading = s().rigYaw,
    forward = [-Math.sin(heading), 0, -Math.cos(heading)];
  // Raw 0.59 maps to 0.5 after the 0.18 deadzone: half of maximum speed.
  d.controllers.right.updateAxes("thumbstick", 0, -0.59);
  await wait(150);
  const partialStart = s();
  await wait(400);
  const partialEnd = s(),
    partialDistance = horizontalDistance(partialEnd.head, partialStart.head),
    partialSpeed = rate(partialStart, partialEnd, partialDistance);
  assert(
    partialDistance > 0.1 &&
      dot(difference(partialEnd.head, partialStart.head), forward) >
        partialDistance * 0.95 &&
      rateNear(partialSpeed, 6) &&
      near(partialEnd.flight.horizontalSpeed, 6),
    "mode2-right-partial-forward-is-half-speed",
    { partialDistance, partialSpeed, flight: partialEnd.flight },
  );
  const heldStart = s();
  await wait(700);
  const heldEnd = s(),
    heldSpeed = rate(
      heldStart,
      heldEnd,
      horizontalDistance(heldEnd.head, heldStart.head),
    );
  assert(
    near(heldEnd.flight.horizontalSpeed, 6) && rateNear(heldSpeed, 6),
    "constant-stick-deflection-does-not-accelerate-over-time",
    { heldSpeed, flight: heldEnd.flight },
  );
  d.controllers.right.updateAxes("thumbstick", 0, -1);
  await wait(100);
  const fullStart = s();
  await wait(400);
  const fullEnd = s(),
    fullDistance = horizontalDistance(fullEnd.head, fullStart.head),
    fullSpeed = rate(fullStart, fullEnd, fullDistance);
  assert(
    fullDistance > 0.1 &&
      fullSpeed > partialSpeed * 1.5 &&
      rateNear(fullSpeed, 12) &&
      near(fullEnd.flight.horizontalSpeed, 12),
    "mode2-right-full-forward-is-maximum-speed",
    { partialSpeed, fullSpeed, flight: fullEnd.flight },
  );
  const reverseStart = s();
  d.controllers.right.updateAxes("thumbstick", 0, 0.59);
  await wait(200);
  const reverseEnd = s(),
    reverseDistance = dot(difference(reverseEnd.head, reverseStart.head), forward),
    reverseSpeed = rate(reverseStart, reverseEnd, reverseDistance);
  assert(
    reverseDistance < -0.1 &&
      rateNear(reverseSpeed, -6) &&
      near(reverseEnd.flight.horizontalSpeed, 6),
    "right-stick-reversal-is-immediate-and-proportional",
    { reverseSpeed, flight: reverseEnd.flight },
  );
  d.controllers.right.updateAxes("thumbstick", 0, 0);
  await wait(150);
  const stoppedPosition = s().head;
  await wait(250);
  assert(
    distance(s().head, stoppedPosition) < 0.1 && idleSpeeds(),
    "neutral-stick-stops-immediately",
    s().flight,
  );
  const diagonalStart = s();
  d.controllers.right.updateAxes("thumbstick", 1, -1);
  await wait(250);
  const diagonalEnd = s(),
    diagonalSpeed = rate(
      diagonalStart,
      diagonalEnd,
      horizontalDistance(diagonalEnd.head, diagonalStart.head),
    );
  assert(
    near(diagonalEnd.flight.horizontalSpeed, 12) && rateNear(diagonalSpeed, 12),
    "diagonal-right-stick-is-capped-at-horizontal-maximum",
    { diagonalSpeed, flight: diagonalEnd.flight },
  );
  d.controllers.right.updateAxes("thumbstick", 0, 0);
  await wait(100);
  const partialYawStart = s();
  d.controllers.left.updateAxes("thumbstick", 0.59, 0);
  await wait(500);
  const partialYawEnd = s(),
    partialYaw = partialYawEnd.rigYaw - partialYawStart.rigYaw,
    partialYawRate = rate(partialYawStart, partialYawEnd, partialYaw);
  d.controllers.left.updateAxes("thumbstick", 0, 0);
  await wait(100);
  assert(
    partialYaw < -0.01 && rateNear(partialYawRate, -Math.PI / 12),
    "mode2-left-partial-yaw-is-continuous-and-proportional",
    { partialYaw, partialYawRate },
  );
  const fullYawStart = s();
  d.controllers.left.updateAxes("thumbstick", 1, 0);
  await wait(500);
  const fullYawEnd = s(),
    fullYaw = fullYawEnd.rigYaw - fullYawStart.rigYaw,
    fullYawRate = rate(fullYawStart, fullYawEnd, fullYaw);
  d.controllers.left.updateAxes("thumbstick", 0, 0);
  await wait(100);
  assert(
    fullYaw < -0.01 &&
      fullYawRate < partialYawRate * 1.5 &&
      rateNear(fullYawRate, -Math.PI / 6),
    "mode2-left-full-yaw-is-faster-not-a-snap",
    { partialYawRate, fullYawRate },
  );
  const stoppedYaw = s().rigYaw;
  await wait(250);
  assert(
    Math.abs(s().rigYaw - stoppedYaw) < 0.001,
    "neutral-left-stick-stops-yaw",
    s().rigYaw,
  );
  const oppositeYawStart = s();
  d.controllers.left.updateAxes("thumbstick", -0.59, 0);
  await wait(400);
  const oppositeYawEnd = s(),
    oppositeYawRate = rate(
      oppositeYawStart,
      oppositeYawEnd,
      oppositeYawEnd.rigYaw - oppositeYawStart.rigYaw,
    );
  d.controllers.left.updateAxes("thumbstick", 0, 0);
  await wait(100);
  assert(
    rateNear(oppositeYawRate, Math.PI / 12),
    "mode2-left-left-yaw-turns-opposite-direction",
    oppositeYawRate,
  );
  // Turning the wearer's head must not steer the drone's translation axes.
  const strafeYaw = s().rigYaw,
    side = [Math.cos(strafeYaw), 0, -Math.sin(strafeYaw)];
  d.quaternion.set(0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8));
  await wait(100);
  const strafeStart = s();
  d.controllers.right.updateAxes("thumbstick", 0.59, 0);
  await wait(350);
  const strafeEnd = s(),
    strafeDelta = difference(strafeEnd.head, strafeStart.head),
    strafeSpeed = rate(strafeStart, strafeEnd, dot(strafeDelta, side));
  d.controllers.right.updateAxes("thumbstick", 0, 0);
  await wait(100);
  assert(
    dot(strafeDelta, side) > 0.1 &&
      rateNear(strafeSpeed, 6) &&
      Math.abs(strafeDelta[1]) < 0.1 &&
      Math.abs(s().rigYaw - strafeYaw) < 0.001,
    "mode2-right-strafe-follows-drone-not-head-direction",
    { strafeDelta, strafeSpeed },
  );
  d.quaternion.set(0, 0, 0, 1);
  await wait(100);
  const partialRiseStart = s();
  d.controllers.left.updateAxes("thumbstick", 0, -0.59);
  await wait(350);
  const partialRiseEnd = s(),
    partialRise = partialRiseEnd.head[1] - partialRiseStart.head[1],
    partialRiseSpeed = rate(partialRiseStart, partialRiseEnd, partialRise);
  assert(
    partialRise > 0.1 &&
      rateNear(partialRiseSpeed, 3) &&
      near(partialRiseEnd.flight.verticalSpeed, 3),
    "mode2-left-partial-forward-rises-at-half-speed",
    { partialRiseSpeed, flight: partialRiseEnd.flight },
  );
  const fullRiseStart = s();
  d.controllers.left.updateAxes("thumbstick", 0, -1);
  await wait(350);
  const fullRiseEnd = s(),
    fullRise = fullRiseEnd.head[1] - fullRiseStart.head[1],
    fullRiseSpeed = rate(fullRiseStart, fullRiseEnd, fullRise);
  assert(
    fullRise > 0.1 &&
      fullRiseSpeed > partialRiseSpeed * 1.5 &&
      rateNear(fullRiseSpeed, 6) &&
      near(fullRiseEnd.flight.verticalSpeed, 6),
    "mode2-left-full-forward-rises-at-maximum-speed",
    { partialRiseSpeed, fullRiseSpeed, flight: fullRiseEnd.flight },
  );
  const descentStart = s();
  d.controllers.left.updateAxes("thumbstick", 0, 0.59);
  await wait(250);
  const descentEnd = s(),
    descent = descentEnd.head[1] - descentStart.head[1],
    descentSpeed = rate(descentStart, descentEnd, descent);
  assert(
    descent < -0.1 &&
      rateNear(descentSpeed, -3) &&
      near(descentEnd.flight.verticalSpeed, 3),
    "mode2-left-back-descends-immediately-at-proportional-speed",
    { descentSpeed, flight: descentEnd.flight },
  );
  d.controllers.left.updateAxes("thumbstick", 0, 0);
  await wait(100);
  assert(idleSpeeds(), "neutral-left-stick-stops-ascent-descent", s().flight);
  d.controllers.right.updateAxes("thumbstick", 0, -1);
  await wait(200);
  await button("right", "b-button");
  const pausedPosition = s().head;
  await wait(250);
  assert(
    !s().free && distance(s().head, pausedPosition) < 0.1 && idleSpeeds(),
    "B-pauses-flight-even-with-stick-held",
    s(),
  );
  d.controllers.right.updateAxes("thumbstick", 0, 0);
  await wait(100);
  await button("right", "b-button");
  assert(
    s().free && distance(s().head, pausedPosition) < 0.1 && idleSpeeds(),
    "B-resumes-flight-in-place",
    s(),
  );
  d.controllers.right.updateAxes("thumbstick", 0, -1);
  await wait(200);
  await button("left", "y-button");
  const resetPosition = s().head;
  await wait(250);
  assert(
    !s().free &&
      s().current === "east" &&
      distance(resetPosition, [195, 76, 105]) < 0.1 &&
      distance(s().head, resetPosition) < 0.1 &&
      idleSpeeds(),
    "Y-resets-position-and-disables-flight",
    s(),
  );
  d.controllers.right.updateAxes("thumbstick", 0, 0);
  await wait(100);
  const exitView = s().vrReturn.view;
  await point(762, 303);
  assert(
    !s().xr && !s().free && s().vrReturn.hasResume && idleSpeeds() &&
      distance(s().camera, exitView.position) < 0.15,
    "trigger-exit-restores-desktop-at-current-view",
    s(),
  );
  const report = {
    passed: true,
    environment: "IWER Meta Quest 3 emulator, NOT physical headset",
    results,
  };
  window.__xrAcceptanceReport = report;
  return JSON.stringify(report);
})();
