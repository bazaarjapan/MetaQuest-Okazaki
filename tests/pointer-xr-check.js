// Local IWER only. Emulated device/controller inputs are the only test inputs.
// Never patch app state, hit tests, rendering, activation, or auth functions.
(async () => {
  const device = window.__xrTestDevice, state = () => window.__okazaki.getState();
  const results = [], pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const check = (ok, name, detail) => {
    results.push({ok: Boolean(ok), name, detail});
    if (!ok) throw new Error(name);
  };
  const until = async (predicate, name) => {
    const deadline = performance.now() + 8000;
    while (!predicate()) { if (performance.now() > deadline) throw new Error(`${name}: timeout`); await pause(40); }
  };
  const release = (hand, id = "trigger") => {
    device.controllers[hand].updateButtonValue(id, 0); device.controllers[hand].updateButtonTouch(id, false);
  };
  const posePixel = (hand, x, y) => {
    const panel = state().vrPanel;
    device.controllers[hand].position.set(
      panel.position[0] + (x / panel.canvas[0] - .5) * panel.size[0],
      device.position.y + panel.position[1] + (.5 - y / panel.canvas[1]) * panel.size[1], -.3);
    device.controllers[hand].quaternion.set(0,0,0,1);
  };
  const aim = async (hand, action, enabled = true) => {
    const rect = state().vrPanel.actionRects[action]; check(Boolean(rect), `rect-${hand}-${action}`);
    posePixel(hand,rect.x + rect.w/2,rect.y + rect.h/2);
    await until(() => state().pointers?.[hand]?.visible && state().pointers[hand].target === (enabled ? action : null)
      && state().pointers[hand].reticleVisible, `aim-${hand}-${action}`);
    if (enabled) check(state().vrPanel.perHand[hand].hovered === action, `own-hand-highlight-${hand}-${action}`);
  };
  const click = async (hand, predicate, name) => {
    device.controllers[hand].updateButtonValue("trigger",1);
    try { await until(predicate,name); } finally { release(hand); }
    await pause(160);
  };
  let report;
  try {
    check(Boolean(device) && state().xr && !state().school.user, "guest-local-XR-not-real-login");
    device.position.set(0,1.6,0); device.quaternion.set(0,0,0,1);
    for (const hand of ["left","right"]) {
      device.controllers[hand].connected=true; device.controllers[hand].updateAxes("thumbstick",0,0);
      release(hand); release(hand,hand === "left" ? "x-button" : "a-button");
    }
    await pause(200);
    await aim("left","west"); await aim("right","east");
    const simultaneous=state();
    check(simultaneous.pointers.left.target === "west" && simultaneous.pointers.right.target === "east"
      && simultaneous.vrPanel.hoveredActions.includes("west") && simultaneous.vrPanel.hoveredActions.includes("east"),
      "two-independent-pointers-and-button-highlights-simultaneous");
    check(simultaneous.pointers.left.color !== simultaneous.pointers.right.color, "hand-colors-distinct", simultaneous.pointers);
    for (const hand of ["left","right"]) {
      const p=state().pointers[hand];
      check(p.reticleVisible && !p.blocked && p.distance>1 && p.distance<2,
        `beam-stops-on-panel-${hand}`, {distance:p.distance});
      check([p.hitPoint,p.rayOrigin,p.rayDirection].every(v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite))
        && Math.hypot(...p.hitPoint.map((v,i)=>v-p.rayOrigin[i]-p.rayDirection[i]*p.distance)) < .001,
        `reticle-matches-physical-ray-${hand}`);
    }
    await click("left",()=>state().current === "west","left-ray-clicks-west-with-right-ray-on-east");
    check(state().current === "west" && !state().free,"left-click-does-not-activate-other-hand-target");
    await aim("right","east"); await click("right",()=>state().current === "east","right-ray-clicks-east");
    await aim("left","free");
    device.controllers.left.updateButtonValue("trigger",1);
    try { await until(()=>state().free,"left-free-on"); await pause(600); check(state().free,"held-trigger-does-not-repeat-toggle"); }
    finally { release("left"); }
    await pause(150); await click("left",()=>!state().free,"second-press-free-off");
    posePixel("left",436,240);
    await until(()=>state().pointers.left.blocked && state().pointers.left.target === null,"gap-reticle-not-action");
    check(state().pointers.left.reticleVisible && state().vrPanel.perHand.left.hovered === null,"blank-gap-shows-no-selectable-highlight");
    const prior=state().current;
    device.controllers.left.updateButtonValue("trigger",1); await pause(250); release("left");
    check(state().current === prior && !state().free,"gap-click-does-not-activate-adjacent-button-or-world");
    await aim("left","tab-workshop"); await click("left",()=>state().vrPanel.tab === "workshop","left-workshop-tab");
    await aim("left","rotate-x+",false);
    check(state().pointers.left.blocked && !state().vrWorkshop.canEdit,"guest-disabled-workshop-target-is-not-clickable");
    device.controllers.left.updateButtonValue("trigger",1); await pause(160); release("left");
    check(state().workshop.count===0 && !state().workshop.current,"guest-trigger-cannot-create-or-edit-STL");
    device.controllers.right.connected=false;
    await until(()=>!state().pointers.right.visible,"disconnected-right-pointer-hidden");
    check(!state().pointers.right.reticleVisible && state().vrPanel.perHand.right.hovered===null,"disconnect-clears-right-reticle-and-hover");
    device.controllers.right.connected=true; await pause(200);
    device.updateVisibilityState("visible-blurred");
    await until(()=>!state().pointers.left.visible && !state().pointers.right.visible,"blur-hides-both-pointers");
    check(state().vrPanel.hoveredActions.length===0 && !state().free,"blur-clears-highlights-and-stops-movement");
    device.updateVisibilityState("visible"); await pause(200);
    device.controllers.left.updateButtonValue("x-button",1); await pause(200); release("left","x-button");
    await until(()=>!state().vrPanel.expanded,"X-compact");
    await aim("right","return");
    check(state().vrPanel.panelCount===1 && state().vrPanel.actionRects.return.enabled,"one-compact-panel-keeps-return-ray-target");
    report={passed:true,environment:"Native browser + IWER Quest 3, not physical Quest/haptic/FPS",results};
  } catch (error) { report={passed:false,error:String(error?.message||error),results}; }
  finally {
    if(device) {
      device.updateVisibilityState("visible");
      for(const hand of ["left","right"]) { device.controllers[hand].connected=true; device.controllers[hand].updateAxes("thumbstick",0,0); release(hand); }
      release("left","x-button");
    }
  }
  window.__pointerXRReport=report; return JSON.stringify(report);
})();
