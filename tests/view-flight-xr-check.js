// Local real-browser + IWER acceptance. Only physical emulator inputs change.
// Run after a fresh authenticated VR entry with neutral controllers.
(async () => {
  const device = window.__xrTestDevice, state = () => window.__okazaki.getState();
  const results = [], wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const check = (ok, name, detail) => { results.push({ok:Boolean(ok),name,detail}); if (!ok) throw Error(name); };
  const until = async predicate => {
    const end = performance.now() + 8000;
    while (!predicate() && performance.now() < end) await wait(70);
    if (!predicate()) throw Error("state transition timeout");
  };
  const button = async (hand, id) => {
    device.controllers[hand].updateButtonValue(id, 1); await wait(220);
    device.controllers[hand].updateButtonValue(id, 0); await wait(250);
  };
  const distance = (a,b) => Math.hypot(...a.map((v,i)=>v-b[i]));
  const idle = () => state().flight.horizontalSpeed === 0 && state().flight.verticalSpeed === 0;
  const travel = async (name, forward, speed = 6) => {
    await wait(100); const before = state(); await wait(320); const after = state();
    const delta = after.rig.map((v,i)=>v-before.rig[i]);
    const seconds = after.simulationSeconds - before.simulationSeconds;
    const projection = delta.reduce((n,v,i)=>n+v*forward[i],0);
    const measured = Math.hypot(delta[0],delta[2]) / seconds;
    check(projection > .1 && projection > Math.hypot(delta[0],delta[2]) * .98 &&
      Math.abs(delta[1]) < .02 && Math.abs(measured-speed) < .2,
      name, {delta,measured,expected:forward});
  };
  let report;
  try {
    await until(()=>state().xr && state().free);
    check(idle(),"VR-default-ON-with-neutral-sticks-is-stationary");
    const entry = [...state().rig]; await wait(200);
    check(distance(entry,state().rig)<.01,"default-ON-does-not-move-without-input");
    device.quaternion.set(0,0,0,1); await wait(100);
    const yaw = state().rigYaw;
    device.controllers.right.updateAxes("thumbstick",0,-.59);
    await travel("forward-follows-initial-view",[-Math.sin(yaw),0,-Math.cos(yaw)]);
    device.quaternion.set(0,Math.sin(Math.PI/4),0,Math.cos(Math.PI/4));
    await travel("head-turn-90-degrees-steers-held-forward-stick",[-Math.sin(yaw+Math.PI/2),0,-Math.cos(yaw+Math.PI/2)]);
    check(Math.abs(state().rigYaw-yaw)<.001,"physical-head-turn-does-not-rotate-rig");
    const pitch=Math.PI/3, headYaw=Math.PI/2;
    device.quaternion.set(Math.sin(pitch/2)*Math.cos(headYaw/2), Math.cos(pitch/2)*Math.sin(headYaw/2),
      -Math.sin(pitch/2)*Math.sin(headYaw/2),Math.cos(pitch/2)*Math.cos(headYaw/2));
    await travel("looking-up-keeps-full-horizontal-speed-without-climbing",[-Math.sin(yaw+headYaw),0,-Math.cos(yaw+headYaw)]);
    device.quaternion.set(Math.sin(Math.PI/4)*Math.cos(headYaw/2),Math.cos(Math.PI/4)*Math.sin(headYaw/2),
      -Math.sin(Math.PI/4)*Math.sin(headYaw/2),Math.cos(Math.PI/4)*Math.cos(headYaw/2));
    await travel("vertical-gaze-retains-last-horizontal-heading",[-Math.sin(yaw+headYaw),0,-Math.cos(yaw+headYaw)]);
    device.controllers.left.updateAxes("thumbstick",.59,0); await wait(350);
    device.controllers.left.updateAxes("thumbstick",0,0); await wait(100);
    const turnedYaw=state().rigYaw;
    check(turnedYaw<yaw-.02,"left-stick-still-turns-rig-while-looking-vertical");
    await travel("vertical-gaze-keeps-left-stick-steering",[-Math.sin(turnedYaw+headYaw),0,-Math.cos(turnedYaw+headYaw)]);
    device.quaternion.set(0,Math.sin(headYaw/2),0,Math.cos(headYaw/2));
    device.controllers.right.updateAxes("thumbstick",.59,0);
    await travel("strafe-follows-current-view-right",[Math.cos(turnedYaw+headYaw),0,-Math.sin(turnedYaw+headYaw)]);
    device.controllers.right.updateAxes("thumbstick",0,0); await wait(100);
    const stopped=[...state().rig]; await wait(200);
    check(idle() && distance(stopped,state().rig)<.01,"neutral-stick-stops-immediately");
    await button("right","b-button"); check(!state().free,"pause-before-changing-head-direction");
    const pausedYaw=-.4;
    device.quaternion.set(0,Math.sin(pausedYaw/2),0,Math.cos(pausedYaw/2)); await wait(150);
    device.quaternion.set(Math.sin(Math.PI/4)*Math.cos(pausedYaw/2),Math.cos(Math.PI/4)*Math.sin(pausedYaw/2),
      -Math.sin(Math.PI/4)*Math.sin(pausedYaw/2),Math.cos(Math.PI/4)*Math.cos(pausedYaw/2)); await wait(150);
    await button("right","b-button"); device.controllers.right.updateAxes("thumbstick",0,-.59);
    await travel("paused-head-turn-is-remembered-when-resuming-under-vertical-gaze",
      [-Math.sin(turnedYaw+pausedYaw),0,-Math.cos(turnedYaw+pausedYaw)]);
    device.controllers.right.updateAxes("thumbstick",0,0); await wait(100);
    device.controllers.left.updateAxes("thumbstick",0,-.59); await wait(100);
    const riseBefore=state(); await wait(250); const riseAfter=state();
    check((riseAfter.rig[1]-riseBefore.rig[1])/(riseAfter.simulationSeconds-riseBefore.simulationSeconds)>2.9,
      "left-stick-still-controls-height-independently");
    device.controllers.left.updateAxes("thumbstick",0,0);
    device.controllers.right.connected=false; await until(()=>!state().free);
    device.controllers.right.connected=true; await wait(250);
    check(!state().free && idle(),"controller-reconnect-does-not-auto-restart-after-safety-stop");
    await button("right","b-button"); check(state().free,"B-manually-resumes-after-safety-stop");
    device.updateVisibilityState("visible-blurred"); await until(()=>!state().free);
    device.updateVisibilityState("visible"); await wait(250);
    check(!state().free && idle(),"visibility-recovery-does-not-auto-restart");
    await button("left","x-button"); check(!state().vrPanel.visible,"X-still-hides-entire-menu");
    device.controllers.left.updateButtonValue("x-button",1); await until(()=>!state().xr);
    device.controllers.left.setButtonValueImmediate("x-button",0);
    check(!state().free && idle(),"hidden-menu-long-X-exits-to-stationary-2D");
    await until(()=>!document.querySelector("#enter-vr").disabled);
    device.controllers.right.updateAxes("thumbstick",0,-1);
    document.querySelector("#enter-vr").click(); await until(()=>state().xr); await wait(400);
    const heldEntry=[...state().rig]; await wait(200);
    check(!state().free && idle() && distance(heldEntry,state().rig)<.01,
      "held-stick-on-entry-waits-without-drifting");
    device.controllers.right.updateAxes("thumbstick",0,0); await until(()=>state().free);
    check(idle(),"releasing-entry-stick-arms-default-ON-without-motion");
    await button("right","b-button"); await wait(250);
    check(!state().free && idle(),"B-stop-is-not-overridden-by-entry-default");
    report={passed:true,environment:"Real browser + IWER Quest 3, NOT physical headset",results};
  } catch(error) { report={passed:false,error:error.message,results}; }
  finally {
    device.updateVisibilityState("visible");
    for(const hand of ["left","right"]) { device.controllers[hand].connected=true; device.controllers[hand].updateAxes("thumbstick",0,0); }
    device.controllers.left.setButtonValueImmediate("x-button",0);
  }
  window.__viewFlightXRReport=report; return JSON.stringify(report);
})();
