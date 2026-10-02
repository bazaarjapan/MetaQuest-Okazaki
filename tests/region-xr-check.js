(async () => {
  const d = window.__xrTestDevice, state = () => window.__okazaki.getState(), results = [];
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const assert = (ok, name, detail) => { results.push({ ok: Boolean(ok), name, detail }); if (!ok) throw new Error(name); };
  const button = async (hand, id) => { d.controllers[hand].updateButtonValue(id, 1); await wait(350); d.controllers[hand].updateButtonValue(id, 0); await wait(350); };
  const point = async (action, fraction = [.5, .5]) => {
    const panel = state().vrPanel, rect = panel?.actionRects?.[action];
    assert(panel?.visible && rect?.enabled, `central-${action}-action-available`, panel);
    const x = panel.position[0] + ((rect.x + rect.w * fraction[0]) / panel.canvas[0] - .5) * panel.size[0];
    const y = panel.position[1] + (.5 - (rect.y + rect.h * fraction[1]) / panel.canvas[1]) * panel.size[1];
    const z = panel.position[2] + .3, { x: qx, y: qy, z: qz, w: qw } = d.quaternion;
    const ix = qw*x + qy*z - qz*y, iy = qw*y + qz*x - qx*z;
    const iz = qw*z + qx*y - qy*x, iw = -qx*x - qy*y - qz*z;
    d.controllers.right.position.set(d.position.x + ix*qw - iw*qx - iy*qz + iz*qy,
      d.position.y + iy*qw - iw*qy - iz*qx + ix*qz,
      d.position.z + iz*qw - iw*qz - ix*qy + iy*qx);
    d.controllers.right.quaternion.set(qx, qy, qz, qw);
    const deadline = performance.now() + 8000;
    while (state().vrPanel.hovered !== action && performance.now() < deadline) await wait(100);
    assert(state().vrPanel.hovered === action, `actual-ray-hovers-central-${action}`, state().vrPanel);
    await button('right', 'trigger');
  };
  assert(state().xr && state().region.ready, 'immersive-wide-mode-ready');
  await button('left', 'y-button');
  await point('tab-region');
  assert(state().region.panelMap && state().vrPanel.tab === 'region', 'controller-ray-opens-central-region-tab');
  const r = state().vrPanel.actionRects.map;
  assert(r && r.w > 0 && r.h > 0, 'central-map-exposes-live-canvas-action-rect', r);
  await point('map', [.6, .45]);
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
