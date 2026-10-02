export const creativeConfig = Object.freeze({ eyeHeight: 1.65, walkSpeed: 4.3,
  flySpeed: 12, sprintMultiplier: 1.5, mouseSensitivity: 0.002,
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
  "ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight"]);

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
  windowTarget = globalThis.window, now = () => globalThis.performance?.now?.() ?? Date.now(),
  onChange = () => {} } = {}) {
  if (!camera?.isCamera) throw new TypeError("Creative controls require a Three.js camera");
  const anchor = new THREE.Vector3();
  const orientation = new THREE.Quaternion();
  const forward = new THREE.Vector3(), side = new THREE.Vector3(), displacement = new THREE.Vector3();
  const cameraRay = new THREE.Raycaster();
  let cameraDistance = 0;
  let cameraObstacleSnapshot = [];
  const keys = new Set();
  const lastMovementTap = new Map(), fastMovementKeys = new Set();
  let mode = "drone", viewMode = "first", yaw = 0, pitch = 0, roll = 0;
  let enabled = false, blocked = false, xr = false, suspendedXR = false;
  let flying = true, verticalVelocity = 0, jumpQueued = false;
  let lastSpace = -Infinity, elapsed = 0, moving = false, groundAvailable = false;
  let disposed = false, pointerError = null;
  const listeners = [];
  const listen = (target, type, handler) => {
    target?.addEventListener?.(type, handler);
    listeners.push(() => target?.removeEventListener?.(type, handler));
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
    keys.clear(); lastSpace = -Infinity; jumpQueued = false;
    lastMovementTap.clear(); fastMovementKeys.clear();
    verticalVelocity = 0; moving = false;
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
  function adopt(view) {
    if (!validView(view)) throw new TypeError("A finite camera view is required");
    const rotation = new THREE.Euler().setFromQuaternion(
      new THREE.Quaternion().fromArray(view.quaternion).normalize(), "YXZ");
    yaw = rotation.y; pitch = rotation.x; roll = rotation.z;
    anchor.fromArray(view.position); anchor.y -= creativeConfig.eyeHeight;
    viewMode = "first";
  }
  function headOrientation() {
    return orientation.setFromEuler(new THREE.Euler(pitch, yaw, roll, "YXZ"));
  }
  function eyePosition() { return anchor.clone().add(new THREE.Vector3(0, creativeConfig.eyeHeight, 0)); }
  function updateAvatar() {
    avatar?.update?.({ position: anchor.toArray(), yaw, pitch, moving,
      time: elapsed, visible: mode === "creative" && viewMode !== "first" && cameraDistance > 0.7 && !xr && !suspendedXR && !disposed });
  }
  function renderView(obstacles) {
    const eye = eyePosition(), rotation = headOrientation().clone();
    if (viewMode === "first") { cameraDistance = 0; setWorldView(eye, rotation); }
    else {
      const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(rotation);
      const position = eye.clone().addScaledVector(direction,
        viewMode === "back" ? -creativeConfig.thirdPersonDistance : creativeConfig.thirdPersonDistance);
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
    adopt(worldView()); clearInput();
    if (mode === "creative") { getControls() && (getControls().enabled = false); renderView(); }
    updateAvatar(); notify();
  }
  function setMode(value) {
    if (!["drone", "creative"].includes(value)) throw new RangeError("Unknown control mode");
    if (disposed || mode === value) return;
    if (xr || suspendedXR) throw new Error("Control mode cannot change during XR");
    clearInput({ release: true });
    if (value === "creative") {
      adopt(worldView()); flying = true;
      mode = value;
      const controls = getControls();
      if (controls) controls.enabled = false;
      renderView();
    } else {
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
    if (["KeyW", "KeyA", "KeyS", "KeyD"].includes(event.code)) {
      const time = now(), previous = lastMovementTap.get(event.code) ?? -Infinity;
      if (Number.isFinite(time) && time >= previous && time - previous <= creativeConfig.doubleMoveMs) fastMovementKeys.add(event.code);
      lastMovementTap.set(event.code, Number.isFinite(time) ? time : -Infinity);
    }
    if (event.code === "Space") {
      const time = now();
      if (Number.isFinite(time) && time >= lastSpace && time - lastSpace <= creativeConfig.doubleSpaceMs) {
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
  function handleKeyUp(event) { keys.delete(event.code); fastMovementKeys.delete(event.code); }
  function handleMouseMove(event) {
    if (!active() || !locked() || inputBlocked(event)) return;
    const x = Number(event.movementX), y = Number(event.movementY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    yaw -= Math.max(-1000, Math.min(1000, x)) * creativeConfig.mouseSensitivity;
    pitch = Math.max(-Math.PI * 0.49, Math.min(Math.PI * 0.49,
      pitch - Math.max(-1000, Math.min(1000, y)) * creativeConfig.mouseSensitivity));
    roll = 0; renderView();
  }
  async function requestPointer(event) {
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
    let height;
    try { height = groundHeight(anchor.x + displacement.x, anchor.z + displacement.z); } catch { height = null; }
    groundAvailable = typeof height === "number" && Number.isFinite(height);
    if (flying) {
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
    moving = magnitude > 0 || Math.abs(displacement.y) > 0;
    renderView();
  }
  function captureForXR() {
    if (mode !== "creative") return worldView();
    const view = { position: eyePosition().toArray(), quaternion: headOrientation().toArray() };
    suspendedXR = true; clearInput({ release: true }); updateAvatar();
    return view;
  }
  function restoreAfterXR(view) {
    if (mode === "creative") adopt(view ?? worldView());
    suspendedXR = false; xr = false; enabled = false;
    clearInput({ release: true });
    if (mode === "creative") renderView();
    updateAvatar(); notify();
  }
  function getState() {
    return { mode, viewMode, anchor: anchor.toArray(), eye: eyePosition().toArray(),
      yaw, pitch, flying, enabled, blocked, xr, suspendedXR, moving,
      pointerLocked: locked(), pointerError, groundAvailable, pressedKeys: [...keys],
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
