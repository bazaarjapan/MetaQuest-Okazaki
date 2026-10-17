import { wingConfig, wingTravel } from "./avatar-motion.js";
export const creativeConfig = Object.freeze({ eyeHeight: 1.65, walkSpeed: 4.3,
  flySpeed: 12, sprintMultiplier: 1.5, mouseSensitivity: 0.002,
  fastClimbSpeed: 36,
  doubleSpaceMs: 350, doubleMoveMs: 350, thirdPersonDistance: 5, gravity: 20, jumpSpeed: 6 });
export const creativeViews = Object.freeze(["first", "back", "front"]);
export const controlPreferenceKey = "okazaki-control-mode-v2";
export function readControlMode(storage) {
  try { const value = storage?.getItem(controlPreferenceKey); if (["creative", "drone"].includes(value)) return value; } catch { /* Optional preference. */ }
  return "creative";
}

// Enable a fresh desktop visit only after the model is ready. An interrupted
// load must not undo a user/visibility/modal safety stop, or resume shared/XR activity.
export function initialPCMovement({ ready = false, mobile = false, hidden = false,
  interrupted = false, dialogOpen = false, xr = false, xrEntering = false,
  restoredWorld = false } = {}) {
  return Boolean(ready && !mobile && !hidden && !interrupted && !dialogOpen &&
    !xr && !xrEntering && !restoredWorld);
}

// Reuse the city's XZ/ceiling limits without its drone-only minimum eye
// altitude. Walking feet must reach actual DEM, including ground below 20m.
export function constrainCreativeFeet(feet, constrainEye) {
  const height = feet.y;
  const eye = feet.clone(); eye.y += creativeConfig.eyeHeight;
  const bounded = constrainEye(eye) ?? eye;
  feet.set(bounded.x, Math.min(height, bounded.y - creativeConfig.eyeHeight), bounded.z);
  return feet;
}
const movementCodes = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "Space",
  "ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "KeyZ", "KeyX"]);

function editable(target) {
  return Boolean(target?.isContentEditable || target?.matches?.(
    'input,textarea,select,button,[contenteditable="true"],[role="textbox"]'));
}
function validView(view) {
  return Array.isArray(view?.position) && view.position.length === 3 && view.position.every(Number.isFinite) &&
    Array.isArray(view?.quaternion) && view.quaternion.length === 4 && view.quaternion.every(Number.isFinite) &&
    view.quaternion.some((value) => value !== 0);
}

// getControls is intentionally a getter: the app recreates OrbitControls on
// teleport/XR return. Player feet are independent of the third-person camera.
export function createCreativeControls(THREE, { camera, rig = camera?.parent,
  domElement, getControls = () => null, avatar = null, constrainPosition = null,
  groundHeight = () => null, cameraObstacles = () => [], documentTarget = globalThis.document,
  windowTarget = globalThis.window, initialView = "back", now = () => globalThis.performance?.now?.() ?? Date.now(),
  onChange = () => {}, onFlightClick = () => {} } = {}) {
  if (!camera?.isCamera) throw new TypeError("Creative controls require a Three.js camera");
  const anchor = new THREE.Vector3();
  const orientation = new THREE.Quaternion();
  const forward = new THREE.Vector3(), side = new THREE.Vector3(), displacement = new THREE.Vector3();
  const cameraRay = new THREE.Raycaster();
  let cameraDistance = 0;
  let thirdPersonDistance = creativeConfig.thirdPersonDistance, preXRViewMode = "first";
  const touchPointers = new Map();
  let mouseDrag = null, suppressPointerClick = false;
  let cameraObstacleSnapshot = [];
  const keys = new Set();
  const lastMovementTap = new Map(), fastMovementKeys = new Set();
  let mode = "drone", viewMode = "first", yaw = 0, pitch = 0, roll = 0;
  let enabled = false, blocked = false, xr = false, suspendedXR = false;
  let flying = true, verticalVelocity = 0, jumpQueued = false;
  let wingFlight = false, wingSpeed = 0, fastClimb = false, animation = "idle";
  let lastSpace = -Infinity, elapsed = 0, moving = false, groundAvailable = false;
  let disposed = false, pointerError = null;
  const listeners = [];
  const listen = (target, type, handler, options) => {
    target?.addEventListener?.(type, handler, options);
    listeners.push(() => target?.removeEventListener?.(type, handler, options));
  };
  const locked = () => Boolean(domElement && documentTarget?.pointerLockElement === domElement);
  const dialogOpen = () => Boolean(documentTarget?.querySelector?.('dialog[open], [role="dialog"][aria-modal="true"]:not([hidden])'));
  const inputBlocked = (event) => blocked || editable(event?.target) || editable(documentTarget?.activeElement) || dialogOpen();
  const active = () => !disposed && mode === "creative" && enabled && !blocked && !xr && !suspendedXR;
  function notify() { onChange(getState()); }
  function releasePointer() {
    if (locked()) {
      try { documentTarget?.exitPointerLock?.(); } catch { /* Already released by browser. */ }
    }
  }
  function clearInput({ release = false } = {}) {
    stopMouseDrag();
    suppressPointerClick = false;
    touchPointers.clear();
    keys.clear(); lastSpace = -Infinity; jumpQueued = false;
    lastMovementTap.clear(); fastMovementKeys.clear();
    verticalVelocity = 0; moving = false;
    wingFlight = false; wingSpeed = 0; fastClimb = false; animation = "idle";
    if (release) releasePointer();
  }
  function worldView() {
    camera.updateWorldMatrix(true, false);
    return { position: camera.getWorldPosition(new THREE.Vector3()).toArray(),
      quaternion: camera.getWorldQuaternion(new THREE.Quaternion()).toArray() };
  }
  function setWorldView(position, quaternion) {
    if (camera.parent) {
      camera.parent.updateWorldMatrix(true, false);
      camera.position.copy(camera.parent.worldToLocal(position.clone()));
      camera.quaternion.copy(camera.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(quaternion));
    } else {
      camera.position.copy(position); camera.quaternion.copy(quaternion);
    }
    camera.up.set(0, 1, 0);
    camera.updateMatrixWorld(true);
  }
  function adopt(view, nextView = "first") {
    if (!validView(view)) throw new TypeError("A finite camera view is required");
    const rotation = new THREE.Euler().setFromQuaternion(
      new THREE.Quaternion().fromArray(view.quaternion).normalize(), "YXZ");
    yaw = rotation.y; pitch = rotation.x; roll = rotation.z;
    anchor.fromArray(view.position); anchor.y -= creativeConfig.eyeHeight;
    viewMode = creativeViews.includes(nextView) ? nextView : "back";
  }
  function headOrientation() {
    return orientation.setFromEuler(new THREE.Euler(pitch, yaw, roll, "YXZ"));
  }
  function eyePosition() { return anchor.clone().add(new THREE.Vector3(0, creativeConfig.eyeHeight, 0)); }
  function updateAvatar() {
    avatar?.update?.({ position: anchor.toArray(), yaw, pitch, moving, animation,
      time: elapsed, visible: mode === "creative" && viewMode !== "first" && cameraDistance > 0.7 && !xr && !suspendedXR && !disposed });
  }
  function renderView(obstacles) {
    const eye = eyePosition(), rotation = headOrientation().clone();
    if (viewMode === "first") { cameraDistance = 0; setWorldView(eye, rotation); }
    else {
      const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(rotation);
      const position = eye.clone().addScaledVector(direction,
        viewMode === "back" ? -thirdPersonDistance : thirdPersonDistance);
      // Looking upwards near ground must not put the rear camera underneath
      // the real terrain. Unknown terrain remains unknown, never a fake plane.
      let cameraGround;
      try { cameraGround = groundHeight(position.x, position.z); } catch { cameraGround = null; }
      if (typeof cameraGround === "number" && Number.isFinite(cameraGround)) {
        position.y = Math.max(position.y, cameraGround + 0.25);
      }
      // Cast both ways so a back-facing wall also bounds the camera. Do not
      // mutate shared city material sides or move the player's signed pose.
      const segment = position.clone().sub(eye), length = segment.length();
      if (length > 0) {
        const meshes = obstacles ?? cameraObstacles() ?? [];
        cameraObstacleSnapshot = [...meshes];
        for (const mesh of meshes) mesh.updateWorldMatrix(true, false);
        const direction = segment.clone().normalize();
        cameraRay.near = 0; cameraRay.far = length;
        cameraRay.set(eye, direction);
        let distance = length;
        for (const hit of cameraRay.intersectObjects(meshes, false)) distance = Math.min(distance, hit.distance);
        cameraRay.set(position, direction.clone().negate());
        for (const hit of cameraRay.intersectObjects(meshes, false)) distance = Math.min(distance, length - hit.distance);
        if (distance < length) position.copy(eye).addScaledVector(direction, Math.max(0.05, distance - 0.2));
      }
      cameraDistance = position.distanceTo(eye);
      // Look at the player's head, not at a shifted OrbitControls target.
      const matrix = new THREE.Matrix4().lookAt(position, eye, new THREE.Vector3(0, 1, 0));
      setWorldView(position, new THREE.Quaternion().setFromRotationMatrix(matrix));
    }
    updateAvatar();
  }
  function syncFromCamera() {
    if (disposed || xr || suspendedXR) return;
    adopt(worldView(), viewMode); clearInput();
    if (mode === "creative") { getControls() && (getControls().enabled = false); renderView(); }
    updateAvatar(); notify();
  }
  function setMode(value) {
    if (!["drone", "creative"].includes(value)) throw new RangeError("Unknown control mode");
    if (disposed || mode === value) return;
    if (xr || suspendedXR) throw new Error("Control mode cannot change during XR");
    clearInput({ release: true });
    if (value === "creative") {
      adopt(worldView(), initialView); flying = true;
      mode = value;
      const controls = getControls();
      if (controls) controls.enabled = false;
      renderView();
    } else {
      // Drone starts at the player's eyes, never at the detached rear/front
      // camera. A mode round-trip must not move the shared player anchor.
      setWorldView(eyePosition(), headOrientation().clone());
      mode = value;
      const controls = getControls();
      if (controls) {
        controls.enabled = true;
        controls.target?.copy(camera.position).add(new THREE.Vector3(0, 0, -12).applyQuaternion(camera.quaternion));
      }
      updateAvatar();
    }
    notify();
  }
  function handleKeyDown(event) {
    if (disposed || mode !== "creative" || xr || suspendedXR) return;
    // F5 must not unexpectedly reload and discard a workshop, even while a
    // form is focused. It never changes the view while input is blocked.
    if (event.code === "F5") {
      event.preventDefault?.();
      if (!inputBlocked(event) && !event.repeat) {
        cycleView();
      }
      return;
    }
    if (event.code === "Escape") { clearInput({ release: true }); return; }
    if (!active() || inputBlocked(event) || !movementCodes.has(event.code)) return;
    event.preventDefault?.();
    if (event.repeat || keys.has(event.code)) return;
    keys.add(event.code);
    if (event.code === "KeyX") { clearInput(); flying = true; notify(); return; }
    if (event.code === "KeyZ") {
      if (!wingFlight) { wingSpeed = wingConfig.launchSpeed; lastSpace = -Infinity; fastClimb = false; }
      wingFlight = true; flying = true; verticalVelocity = 0; jumpQueued = false; notify();
    }
    if (["KeyW", "KeyA", "KeyS", "KeyD"].includes(event.code)) {
      const time = now(), previous = lastMovementTap.get(event.code) ?? -Infinity;
      if (Number.isFinite(time) && time >= previous && time - previous <= creativeConfig.doubleMoveMs) fastMovementKeys.add(event.code);
      lastMovementTap.set(event.code, Number.isFinite(time) ? time : -Infinity);
    }
    if (event.code === "Space") {
      const time = now();
      // A released/re-pressed Space boosts climb only while wing flight is active.
      // Keep the normal flight/walk toggle outside wing flight unchanged.
      if (wingFlight) {
        fastClimb = Number.isFinite(time) && time >= lastSpace && time - lastSpace <= creativeConfig.doubleSpaceMs;
        lastSpace = fastClimb || !Number.isFinite(time) ? -Infinity : time;
        notify(); return;
      }
      if (Number.isFinite(time) && time >= lastSpace && time - lastSpace <= creativeConfig.doubleSpaceMs) {
        wingFlight = false; wingSpeed = 0;
        flying = !flying; verticalVelocity = 0; jumpQueued = false; lastSpace = -Infinity;
        notify();
      } else {
        lastSpace = Number.isFinite(time) ? time : -Infinity;
        if (!flying) jumpQueued = true;
      }
    }
  }
  function cycleView() {
    if (disposed || mode !== "creative" || xr || suspendedXR || dialogOpen()) return false;
    viewMode = creativeViews[(creativeViews.indexOf(viewMode) + 1) % creativeViews.length];
    renderView(); notify(); return true;
  }
  function handleKeyUp(event) {
    keys.delete(event.code); fastMovementKeys.delete(event.code);
    if (event.code === "Space") { fastClimb = false; }
  }
  function handleMouseMove(event) {
    if (!active() || !locked() || inputBlocked(event)) return;
    rotateMouse(Number(event.movementX), Number(event.movementY));
  }
  function rotateMouse(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    yaw -= Math.max(-1000, Math.min(1000, x)) * creativeConfig.mouseSensitivity;
    pitch = Math.max(-Math.PI * 0.49, Math.min(Math.PI * 0.49,
      pitch - Math.max(-1000, Math.min(1000, y)) * creativeConfig.mouseSensitivity));
    roll = 0; renderView();
  }
  function stopMouseDrag() {
    const pointerId = mouseDrag?.id; mouseDrag = null;
    if (pointerId !== undefined) {
      try { domElement?.releasePointerCapture?.(pointerId); } catch { /* Already released. */ }
    }
  }
  function flightMouseDown(event) {
    if (event.pointerType !== "mouse" || event.button !== 0 || !active() || !wingFlight || locked() || inputBlocked(event)) return;
    if (![event.clientX,event.clientY].every(Number.isFinite)) return;
    mouseDrag = {id:event.pointerId,x:event.clientX,y:event.clientY,startX:event.clientX,startY:event.clientY,dragged:false}; suppressPointerClick = true;
    try { domElement.setPointerCapture?.(event.pointerId); } catch { /* Window-up fallback below. */ }
    // In capture phase: a steering gesture must not also place the held STL.
    event.preventDefault?.(); event.stopImmediatePropagation?.();
  }
  function flightMouseMove(event) {
    if (!mouseDrag || event.pointerId !== mouseDrag.id) return;
    if (!active() || !wingFlight || locked() || inputBlocked(event) || (event.buttons & 1) === 0) { stopMouseDrag(); return; }
    if (![event.clientX,event.clientY].every(Number.isFinite)) return;
    if (!mouseDrag.dragged) {
      if (Math.hypot(event.clientX-mouseDrag.startX,event.clientY-mouseDrag.startY) <= 5) return;
      mouseDrag.dragged = true;
    }
    rotateMouse(event.clientX-mouseDrag.x,event.clientY-mouseDrag.y);
    mouseDrag.x=event.clientX; mouseDrag.y=event.clientY; event.preventDefault?.();
  }
  function flightMouseUp(event) {
    if (!mouseDrag || event.pointerId !== mouseDrag.id) return;
    const click = !mouseDrag.dragged && event.button === 0 &&
      [event.clientX,event.clientY].every(Number.isFinite) &&
      Math.hypot(event.clientX-mouseDrag.startX,event.clientY-mouseDrag.startY) <= 5 &&
      active() && wingFlight && !locked() && !inputBlocked(event);
    stopMouseDrag();
    if (click) onFlightClick(event);
  }
  const canTouchLook = (event) => !disposed && mode === "creative" && !enabled &&
    !xr && !suspendedXR && !documentTarget?.hidden && !inputBlocked(event);
  function touchDown(event) {
    if (event.pointerType !== "touch" || !canTouchLook(event)) return;
    if (![event.clientX, event.clientY].every(Number.isFinite)) return;
    touchPointers.set(event.pointerId, [event.clientX, event.clientY]);
    try { domElement.setPointerCapture?.(event.pointerId); } catch { /* Pointer may have ended. */ }
    event.preventDefault?.();
  }
  function touchMove(event) {
    if (!touchPointers.has(event.pointerId)) return;
    if (!canTouchLook(event)) { touchPointers.clear(); return; }
    if (![event.clientX, event.clientY].every(Number.isFinite)) return;
    const before = [...touchPointers.values()], previous = touchPointers.get(event.pointerId);
    touchPointers.set(event.pointerId, [event.clientX, event.clientY]);
    if (touchPointers.size === 1) {
      yaw -= (event.clientX - previous[0]) * .005;
      pitch = Math.max(-Math.PI * .49, Math.min(Math.PI * .49, pitch - (event.clientY - previous[1]) * .005));
      roll = 0;
    } else if (touchPointers.size === 2 && viewMode !== "first") {
      const after = [...touchPointers.values()];
      const span = points => Math.hypot(points[0][0]-points[1][0], points[0][1]-points[1][1]);
      if (span(before) > 0 && span(after) > 0) thirdPersonDistance = Math.max(1, Math.min(20, thirdPersonDistance * span(before) / span(after)));
    }
    event.preventDefault?.(); renderView();
  }
  async function requestPointer(event) {
    // Do not request unsupported pointer lock on the click ending a flight drag.
    if (suppressPointerClick) { suppressPointerClick = false; return; }
    if (!active() || inputBlocked(event) || locked() || typeof domElement?.requestPointerLock !== "function") return;
    try {
      await domElement.requestPointerLock(); pointerError = null;
      if (!active()) releasePointer();
    }
    catch { pointerError = "マウス操作を開始できません。3D画面をもう一度クリックしてください。"; }
    notify();
  }
  function step(dt, options = {}) {
    if (disposed) return;
    const previousActive = active();
    enabled = Boolean(options.enabled);
    blocked = Boolean(options.blocked) || dialogOpen() || editable(documentTarget?.activeElement);
    xr = Boolean(options.xr);
    if (!active()) {
      if (previousActive || keys.size || xr || blocked) clearInput({ release: true });
      if (mode === "creative" && viewMode !== "first" && !xr && !suspendedXR) {
        const meshes = cameraObstacles() ?? [];
        // Streaming can change the view even while movement is OFF. Refresh
        // on mesh changes without raycasting the same stationary scene each frame.
        if (meshes.length !== cameraObstacleSnapshot.length || meshes.some((mesh, index) => mesh !== cameraObstacleSnapshot[index])) renderView(meshes);
      }
      updateAvatar(); return;
    }
    const controls = getControls();
    if (controls) controls.enabled = false;
    const deltaTime = Number.isFinite(dt) ? Math.max(0, Math.min(0.1, dt)) : 0;
    elapsed += deltaTime;
    const previousAnchor = anchor.clone();
    let x = Number(keys.has("KeyD")) - Number(keys.has("KeyA"));
    let z = Number(keys.has("KeyW")) - Number(keys.has("KeyS"));
    const axes = options.touchAxes;
    const validAxes = axes && [axes.left, axes.right].every(values => Array.isArray(values) && values.length === 2 && values.every(Number.isFinite));
    if (validAxes) {
      x = Math.max(-1, Math.min(1, axes.right[0])); z = -Math.max(-1, Math.min(1, axes.right[1]));
      yaw -= Math.max(-1, Math.min(1, axes.left[0])) * deltaTime * 1.2;
    }
    const magnitude = Math.hypot(x, z);
    if (magnitude > 1) { x /= magnitude; z /= magnitude; }
    const sprint = keys.has("ControlLeft") || keys.has("ControlRight") || fastMovementKeys.size > 0;
    const shift = keys.has("ShiftLeft") || keys.has("ShiftRight");
    const speed = (flying ? creativeConfig.flySpeed : creativeConfig.walkSpeed) *
      (sprint ? creativeConfig.sprintMultiplier : 1) * (!flying && shift ? 0.3 : 1);
    forward.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    side.set(Math.cos(yaw), 0, -Math.sin(yaw));
    displacement.copy(forward).multiplyScalar(z * speed * deltaTime).addScaledVector(side, x * speed * deltaTime);
    const boosting = wingFlight && keys.has("KeyZ");
    if (wingFlight) {
      const travel = wingTravel(wingSpeed, boosting, deltaTime); wingSpeed = travel.speed;
      const flightPitch = Math.max(-1.1, Math.min(1.1, pitch));
      displacement.copy(forward).multiplyScalar(Math.cos(flightPitch) * travel.distance);
      displacement.y = Math.sin(flightPitch) * travel.distance +
        (boosting ? wingConfig.lift : -wingConfig.sink) * deltaTime;
      if (keys.has("Space")) displacement.y = Math.max(displacement.y,
        (fastClimb ? creativeConfig.fastClimbSpeed : creativeConfig.flySpeed) * deltaTime);
    }
    let height;
    try { height = groundHeight(anchor.x + displacement.x, anchor.z + displacement.z); } catch { height = null; }
    groundAvailable = typeof height === "number" && Number.isFinite(height);
    // Auto lift near the ground makes Z a launch even when looking downward.
    if (boosting && groundAvailable && anchor.y < height + 2) displacement.y = Math.max(displacement.y, wingConfig.lift * deltaTime);
    if (wingFlight) {
      // Streaming/DEM failure must not turn automatic glide into a fall below
      // an unknown surface. Continue horizontally; resume descent once known.
      if (!groundAvailable && displacement.y < 0) displacement.y = 0;
      verticalVelocity = 0; jumpQueued = false;
    } else if (flying) {
      const rise = validAxes ? -Math.max(-1, Math.min(1, axes.left[1])) : Number(keys.has("Space")) - Number(shift);
      displacement.y = rise * speed * deltaTime;
      verticalVelocity = 0; jumpQueued = false;
    } else if (groundAvailable) {
      const grounded = anchor.y <= height + 0.02;
      if (grounded && jumpQueued) verticalVelocity = creativeConfig.jumpSpeed;
      else if (grounded && verticalVelocity < 0) verticalVelocity = 0;
      verticalVelocity -= creativeConfig.gravity * deltaTime;
      displacement.y = verticalVelocity * deltaTime;
      jumpQueued = false;
    } else {
      // Missing streamed DEM is not a zero-metre floor or a reason to fall forever.
      verticalVelocity = 0; jumpQueued = false;
    }
    anchor.add(displacement);
    if (wingFlight && groundAvailable && anchor.y <= height) {
      anchor.y = height; wingFlight = false; wingSpeed = 0; flying = false; keys.delete("KeyZ");
      fastClimb = false; lastSpace = -Infinity;
    }
    if (!flying && groundAvailable && anchor.y < height) { anchor.y = height; verticalVelocity = 0; }
    // A stationary flying view may be outside currently loaded region bounds
    // (the initial aerial overview is). Do not teleport it merely by enabling
    // input. Real movement and walking gravity still apply the same limits.
    if (constrainPosition && displacement.lengthSq() > 0) {
      const previous = anchor.clone();
      try {
        const bounded = constrainPosition(anchor);
        if (bounded && bounded !== anchor && [bounded.x, bounded.y, bounded.z].every(Number.isFinite)) anchor.copy(bounded);
        if (![anchor.x, anchor.y, anchor.z].every(Number.isFinite)) anchor.copy(previous);
      } catch { anchor.copy(previous); }
    }
    moving = anchor.distanceToSquared(previousAnchor) > 1e-12;
    animation = !moving ? "idle" : wingFlight ? (boosting ? "boost" : "glide") :
      Math.hypot(anchor.x - previousAnchor.x, anchor.z - previousAnchor.z) > 1e-6 ? (sprint ? "run" : "walk") : "idle";
    renderView();
  }
  function captureForXR() {
    if (mode !== "creative") return worldView();
    preXRViewMode = viewMode;
    const view = { position: eyePosition().toArray(), quaternion: headOrientation().toArray() };
    suspendedXR = true; clearInput({ release: true }); updateAvatar();
    return view;
  }
  function restoreAfterXR(view, { entryFailed = false } = {}) {
    if (mode === "creative") adopt(view ?? worldView(), entryFailed ? preXRViewMode : "first");
    suspendedXR = false; xr = false; enabled = false;
    clearInput({ release: true });
    if (mode === "creative") renderView();
    updateAvatar(); notify();
  }
  function getState() {
    return { mode, viewMode, anchor: anchor.toArray(), eye: eyePosition().toArray(),
      yaw, pitch, flying, wingFlight, wingSpeed, fastClimb, animation, enabled, blocked, xr, suspendedXR, moving,
      pointerLocked: locked(), mouseSteering: Boolean(mouseDrag), pointerError, groundAvailable, pressedKeys: [...keys],
      sprinting: keys.has("ControlLeft") || keys.has("ControlRight") || fastMovementKeys.size > 0, cameraDistance, disposed };
  }
  function dispose() {
    if (disposed) return;
    clearInput({ release: true }); disposed = true;
    for (const remove of listeners) remove();
    const controls = getControls();
    if (controls && !xr) controls.enabled = true;
    updateAvatar();
  }
  listen(windowTarget, "keydown", handleKeyDown);
  listen(windowTarget, "keyup", handleKeyUp);
  listen(windowTarget, "blur", () => clearInput({ release: true }));
  listen(documentTarget, "mousemove", handleMouseMove);
  listen(domElement, "pointerdown", flightMouseDown, true);
  listen(domElement, "pointermove", flightMouseMove);
  listen(windowTarget, "pointerup", flightMouseUp);
  listen(domElement, "pointercancel", stopMouseDrag);
  listen(domElement, "lostpointercapture", () => { mouseDrag = null; });
  listen(domElement, "pointerdown", touchDown);
  listen(domElement, "pointermove", touchMove);
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
    listen(domElement, type, event => touchPointers.delete(event.pointerId));
  }
  listen(documentTarget, "pointerlockchange", () => {
    if (locked() && !active()) releasePointer();
    if (!locked()) clearInput();
    notify();
  });
  listen(documentTarget, "pointerlockerror", () => { pointerError = "マウス操作を開始できません。"; clearInput(); notify(); });
  listen(documentTarget, "visibilitychange", () => { if (documentTarget?.hidden) clearInput({ release: true }); });
  listen(domElement, "click", requestPointer);
  adopt(worldView());
  return { setMode, step, handleKeyDown, handleKeyUp, handleMouseMove,
    clearInput, cycleView, syncFromCamera, captureForXR, restoreAfterXR, getState, dispose };
}
