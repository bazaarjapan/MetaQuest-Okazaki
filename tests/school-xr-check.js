(async () => {
  const device = window.__xrTestDevice, state = () => window.__okazaki.getState();
  const results = [], pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  const check = (value, name) => {
    results.push({ok: Boolean(value), name});
    if (!value) throw new Error(name);
  };
  const until = async (predicate, name) => {
    const deadline = performance.now() + 10000;
    while (!predicate()) {
      if (performance.now() > deadline) throw new Error(`${name}: timeout`);
      await pause(50);
    }
  };
  // Change only the emulator's physical input. No application camera, school,
  // placement, authentication or rendering functions are substituted.
  const trigger = async (predicate, name) => {
    device.controllers.right.updateButtonValue("trigger", 1);
    try { await until(predicate, name); }
    finally { device.controllers.right.updateButtonValue("trigger", 0); }
    await pause(250);
  };
  const point = async (action, predicate) => {
    const panel = state().vrPanel, rect = panel?.actionRects?.[action];
    check(panel?.visible && rect?.enabled, `central-${action}-action-available`);
    const x = panel.position[0] + ((rect.x + rect.w / 2) / panel.canvas[0] - .5) * panel.size[0];
    const y = panel.position[1] + (.5 - (rect.y + rect.h / 2) / panel.canvas[1]) * panel.size[1];
    const z = panel.position[2] + .3;
    const { x: qx, y: qy, z: qz, w: qw } = device.quaternion;
    const ix = qw*x + qy*z - qz*y, iy = qw*y + qz*x - qx*z;
    const iz = qw*z + qx*y - qy*x, iw = -qx*x - qy*y - qz*z;
    device.controllers.right.position.set(device.position.x + ix*qw - iw*qx - iy*qz + iz*qy,
      device.position.y + iy*qw - iw*qy - iz*qx + ix*qz,
      device.position.z + iz*qw - iw*qz - ix*qy + iy*qx);
    device.controllers.right.quaternion.set(qx, qy, qz, qw);
    await until(() => state().vrPanel.hovered === action, `hover-central-${action}`);
    await trigger(predicate, action);
  };
  const groundRay = () => {
    const {rig, rigYaw} = state(), dx = -255 - rig[0], dz = -350 - rig[2];
    device.controllers.right.position.set(Math.cos(rigYaw) * dx - Math.sin(rigYaw) * dz,
      16 - rig[1], Math.sin(rigYaw) * dx + Math.cos(rigYaw) * dz);
    device.controllers.right.quaternion.set(-Math.SQRT1_2, 0, 0, Math.SQRT1_2);
  };
  check(state().xr && state().school.connection === "connected", "signed-connected-immersive-session");
  check(window.__schoolEntryEye && Math.hypot(...state().head.map((v,i) => v-window.__schoolEntryEye[i])) < .1,
    "first-drone-VR-entry-retains-restored-school-eye");
  device.position.set(0, 1.6, 0); device.quaternion.set(0, 0, 0, 1);
  await point("tab-workshop", () => state().vrPanel.tab === "workshop");
  await until(() => state().vrWorkshop.visible && state().vrWorkshop.canEdit, "signed-HUD-visible");
  check(state().vrPanel.panelCount === 1 && state().vrWorkshop.embedded && !state().vrWorkshop.spatialVisible,
    "workshop-embedded-in-one-central-panel");
  check(state().workshop.ownAssets.length > 0, "actual-R2-asset-available");
  for (const [i, axis] of ["x", "y", "z"].entries()) {
    const before = state().workshop.current.rotation[i];
    await point(`rotate-${axis}+`, () => state().workshop.current.rotation[i] > before + .2);
    check(Math.abs(state().workshop.current.rotation[i] - before - Math.PI / 12) < .0001, `right-trigger-${axis}-15degrees`);
  }
  const beforeScale = state().workshop.current.scale[0];
  await point("scale+", () => state().workshop.current.scale[0] > beforeScale);
  check(Math.abs(state().workshop.current.scale[0] - beforeScale * 1.1) < .0001, "right-trigger-scale-1.1");
  await point("pick", () => state().vrWorkshop.picking);
  check(!state().free, "ground-selection-stops-locomotion");
  groundRay(); await pause(250);
  await trigger(() => !state().vrWorkshop.picking && state().workshop.current.valid, "real-terrain-ray-preview");
  check(state().workshop.current.position[1] > 10 && Math.abs(state().workshop.current.position[0] + 255) < .1,
    "actual-PLATEAU-height-not-fake-plane");
  await point("commit", () => state().workshop.committed === 1);
  const committedId = state().school.objects[0].id;
  check(state().school.objects.length === 1 && state().workshop.current.committed, "VR-placement-server-ACK");
  await point("asset-next", () => !state().workshop.current.committed);
  check(state().workshop.ownAssets.length === 1, "reuse-existing-R2-asset-no-upload");
  await point("cancel", () => !state().workshop.current);
  check(state().workshop.committed === 1, "cancel-removes-only-draft");
  groundRay(); await pause(250);
  await trigger(() => state().workshop.current?.id === committedId, "ray-select-existing-object");
  check(state().workshop.current.editable && state().workshop.current.committed, "existing-owned-object-editable-in-VR");
  const before = state().workshop.current.rotation[0];
  await point("rotate-x+", () => !state().workshop.current.committed && state().workshop.current.rotation[0] > before);
  check(state().school.objects[0].rotation[0] === before, "edit-draft-does-not-change-server-until-confirm");
  await point("commit", () => state().workshop.current.committed && state().school.objects[0].rotation[0] > before);
  check(state().school.objects.length === 1 && state().school.objects[0].id === committedId, "VR-update-preserves-object-identity");
  device.controllers.left.updateButtonValue("x-button", 1);
  try { await until(() => !state().xr, "X-hold-returns-to-2D"); }
  finally { device.controllers.left.updateButtonValue("x-button", 0); }
  check(!state().free && state().workshop.committed === 1 && state().school.connection === "connected", "VR-exit-retains-shared-world-and-stops-movement");
  const report = {passed: true, environment: "IWER Quest 3 emulator; not physical Quest; ephemeral auth; actual Worker/R2/DO/PLATEAU", results};
  window.__schoolXRReport = report;
  return JSON.stringify(report);
})();
