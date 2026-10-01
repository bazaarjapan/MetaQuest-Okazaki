(async () => {
  const results = [], gestureTimings = [], wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const state = () => window.__okazaki.getState();
  const check = (ok, name) => { results.push({ok:Boolean(ok),name}); if (!ok) throw new Error(name); };
  const distance = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
  const until = async (predicate, name) => {
    const deadline = performance.now() + 10000;
    while (!predicate()) {
      if (performance.now() > deadline) throw new Error(name + ': condition did not settle within10s');
      await wait(50);
    }
  };
  const key = (code, type = "keydown") => window.dispatchEvent(new KeyboardEvent(type, {code,bubbles:true,cancelable:true}));
  const mode = document.querySelector("#control-mode"), canvas = document.querySelector("#viewport > canvas");
  check(state().ready && !state().ui.mobile, "PC-loaded");
  check(state().creative.mode === "creative", "fresh-PC-default-is-creative");
  document.querySelector("#tab-settings").click();
  const initial = [...state().camera];
  mode.value = "creative"; mode.dispatchEvent(new Event("change", {bubbles:true}));
  await wait(100);
  check(state().creative.mode === "creative" && !state().free, "mode-change-stops-movement");
  check(distance(state().creative.eye, initial) < 1e-6, "mode-change-keeps-original-view-position");
  document.querySelector("#free-move").click(); canvas.focus();
  await until(() => state().free && state().creative.enabled, "creative-enabled-rAF");
  check(state().free && state().creative.enabled, "creative-enabled-without-start-reset");
  const anchor = [...state().creative.anchor];
  key("KeyW");
  try { await until(() => distance(state().creative.anchor, anchor) > 0.1, "W-moves-rAF"); }
  finally { key("KeyW", "keyup"); }
  check(distance(state().creative.anchor, anchor) > 0.1, "W-moves-actual-player");
  await wait(100); const still = [...state().creative.anchor]; await wait(150);
  check(distance(state().creative.anchor, still) < 1e-6, "key-release-stops");
  for (const code of ["KeyW","KeyA","KeyS","KeyD"]) {
    await wait(400);
    const start = performance.now();
    try {
      // Input a valid short gesture within one task. Renderer-delayed timers
      // must not turn an intended80ms gap into an actual >350ms non-gesture.
      key(code); key(code,"keyup"); key(code);
      const elapsedMs = performance.now() - start;
      gestureTimings.push({code, elapsedMs});
      check(elapsedMs <= 350 && state().creative.sprinting, "double-tap-sprints-"+code);
    } finally { key(code,"keyup"); }
    check(!state().creative.sprinting, "release-stops-sprint-"+code);
  }
  const beforeView = [...state().creative.anchor];
  key("F5");
  await until(() => state().creative.viewMode === "back" &&
    state().avatar.visible === Boolean(state().school.user && state().school.world), "F5-avatar-render-rAF");
  check(state().creative.viewMode === "back" && state().avatar.visible === Boolean(state().school.user && state().school.world), "F5-behind-camera-avatar-only-for-joined-user");
  check(distance(state().creative.anchor, beforeView) < 1e-6 && distance(state().camera, state().creative.eye) > 4.9, "camera-not-player-anchor");
  key("F5"); await wait(50);
  check(state().creative.viewMode === "front", "F5-front-camera");
  key("F5"); await wait(50);
  check(state().creative.viewMode === "first" && !state().avatar.visible, "F5-first-person-no-avatar-blocking");
  const beforeRise = state().creative.eye[1];
  key("Space");
  try { await until(() => state().creative.eye[1] > beforeRise + .1, "Space-rises-rAF"); }
  finally { key("Space", "keyup"); }
  check(state().creative.eye[1] > beforeRise + .1, "Space-rises");
  const beforeDrop = state().creative.eye[1];
  key("ShiftLeft");
  try { await until(() => state().creative.eye[1] < beforeDrop - .1, "Shift-descends-rAF"); }
  finally { key("ShiftLeft", "keyup"); }
  check(state().creative.eye[1] < beforeDrop - .1, "Shift-descends");
  await wait(400); const spaceStart = performance.now(); let spaceElapsedMs;
  try {
    key("Space"); key("Space", "keyup"); key("Space");
    spaceElapsedMs = performance.now() - spaceStart;
    gestureTimings.push({code:"Space", elapsedMs:spaceElapsedMs});
  } finally { key("Space", "keyup"); }
  await wait(50); check(spaceElapsedMs <= 350 && !state().creative.flying, "double-Space-switches-walking");
  document.querySelector("#open-workshop").click(); await wait(100);
  const blocked = [...state().creative.anchor]; key("KeyW"); await wait(200); key("KeyW", "keyup");
  check(distance(state().creative.anchor, blocked) < 1e-6, "modal-stops-player-input");
  const modalInput = document.querySelector("dialog[open] input"); modalInput?.focus(); const view = state().creative.viewMode; key("F5");
  check(state().creative.viewMode === view, "F5-does-not-change-view-in-form");
  document.querySelector("dialog[open]").close(); canvas.focus(); await wait(100);
  window.dispatchEvent(new Event("blur")); await wait(100);
  check(state().creative.pressedKeys.length === 0, "blur-neutralizes-input");
  mode.value = "drone"; mode.dispatchEvent(new Event("change", {bubbles:true})); await wait(100);
  check(state().creative.mode === "drone" && !state().avatar.visible && !state().free, "original-controls-restored-with-motion-off");
  document.querySelector("#tab-observe").click();
  return JSON.stringify({passed:true,environment:"PC browser, not physical Quest",results,gestureTimings});
})();
