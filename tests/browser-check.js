(async () => {
  const results = [];
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const assert = (ok, name, detail) => {
    results.push({ name, ok, detail });
    if (!ok) throw new Error(JSON.stringify(results));
  };
  const state = () => window.__okazaki.getState();
  for (let i = 0; i < 100 && !state().ready && !state().error; i++)
    await wait(200);
  assert(
    state().ready && state().triangles === 58845,
    "official-model-loaded",
    state(),
  );
  assert(!document.querySelector(".vite-error-overlay"), "no-error-overlay");
  for (const id of ["east", "west", "overview"]) {
    document.querySelector(`[data-view=${id}]`).click();
    await wait(120);
    assert(
      state().current === id && !state().free,
      "viewpoint-" + id,
      state().camera,
    );
  }
  document.querySelector("#free-move").click();
  document.querySelector("#viewport > canvas").focus();
  await wait(150);
  const before = state().camera;
  window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW" }));
  await wait(1000);
  window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyW" }));
  await wait(100);
  const after = state().camera;
  const moved = Math.hypot(...after.map((v, i) => v - before[i]));
  assert(moved > 3, "keyboard-forward", moved);
  window.dispatchEvent(new KeyboardEvent("keydown", { code: "Home" }));
  window.dispatchEvent(new KeyboardEvent("keyup", { code: "Home" }));
  await wait(150);
  assert(
    state().current === "overview" && !state().free,
    "home-resets-and-disables-flight",
    state().camera,
  );
  document.querySelector("#help").click();
  assert(document.querySelector("#help-dialog").open, "help-opens");
  document.querySelector("#close-help").click();
  assert(!document.querySelector("#help-dialog").open, "help-closes");
  assert(
    document.documentElement.scrollWidth <= innerWidth + 1,
    "no-horizontal-overflow",
    { width: innerWidth, scroll: document.documentElement.scrollWidth },
  );
  assert(!state().error, "no-app-error");
  return JSON.stringify({ passed: true, results });
})();
