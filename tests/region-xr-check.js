(async () => {
  const d = window.__xrTestDevice, state = () => window.__okazaki.getState(), results = [];
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const assert = (ok, name, detail) => { results.push({ ok: Boolean(ok), name, detail }); if (!ok) throw new Error(name); };
  const button = async (hand, id) => { d.controllers[hand].updateButtonValue(id, 1); await wait(350); d.controllers[hand].updateButtonValue(id, 0); await wait(350); };
  const point = async (x, y) => {
    const g = state().guide;
    d.controllers.right.position.set(g.position[0] + (x / 1024 - .5) * g.size[0],
      1.6 + g.position[1] + (.5 - y / 512) * g.size[1], -.3);
    d.controllers.right.quaternion.set(0, 0, 0, 1); await wait(350); await button('right', 'trigger');
  };
  assert(state().xr && state().region.ready, 'immersive-wide-mode-ready');
  await button('left', 'y-button');
  await point(901, 100);
  assert(state().region.panelMap, 'controller-ray-opens-upper-right-map');
  const r = state().region.mapRect;
  await point(r.x + r.w * .6, r.y + r.h * .45);
  const before = state(), bounds = before.region.bounds;
  assert(before.current === 'region' && !before.free &&
    Math.abs(before.head[0] - (bounds[0] + (bounds[2] - bounds[0]) * .6)) < 5 && before.head[0] > 5000,
    'map-ray-teleports-actual-head-beyond-old-boundary', before.head);
  await button('right', 'b-button');
  assert(state().free && state().current === 'region', 'B-enables-wide-flight-in-place');
  const start = state().head;
  d.controllers.right.updateAxes('thumbstick', 0, -.59); await wait(1500);
  d.controllers.right.updateAxes('thumbstick', 0, 0); await wait(350);
  assert(Math.hypot(state().head[0] - start[0], state().head[2] - start[2]) > .5 && state().head[0] > 5000,
    'analog-drone-flight-works-outside-old-station-clamp', state().head);
  await button('left', 'y-button');
  assert(!state().free && state().current === 'east' && !state().region.panelMap &&
    Math.hypot(...state().head.map((v, i) => v - [195, 76, 105][i])) < .1,
    'Y-always-restores-station-and-closes-map', state().head);
  const report = { passed: true, environment: 'IWER emulator, NOT physical Quest headset', results };
  window.__regionXRReport = report; return JSON.stringify(report);
})();
