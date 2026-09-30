/** Raw stick axes: right and down are positive, matching WebXR gamepads. */
export function normalizeTouchPoint(rect, clientX, clientY) {
  const values = [rect?.left, rect?.top, rect?.width, rect?.height, clientX, clientY];
  if (!values.every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) {
    return [0, 0];
  }
  const radius = Math.min(rect.width, rect.height) / 2;
  let x = (clientX - rect.left - rect.width / 2) / radius;
  let y = (clientY - rect.top - rect.height / 2) / radius;
  const magnitude = Math.hypot(x, y);
  if (magnitude > 1) {
    x /= magnitude;
    y /= magnitude;
  }
  return [x, y];
}

/**
 * Independent two-finger Mode 2 controls. The caller enables these only during
 * non-XR free flight and applies the same deadzone as physical thumbsticks.
 * DOM globals are deliberately read here, not when importing this module.
 */
export function createTouchControls(viewport, { onActivity } = {}) {
  const document = viewport?.ownerDocument;
  const window = document?.defaultView;
  if (!document?.createElement || !viewport?.append || !window?.addEventListener) {
    throw new TypeError("Touch controls require a viewport with an owner document.");
  }

  const container = document.createElement("div");
  container.className = "touch-flight-controls";
  container.hidden = true;
  container.dataset.enabled = "false";
  container.setAttribute("aria-label", "自由移動用のモード2タッチ操作");
  const listeners = [];
  const sticks = {};
  let enabled = false;
  let disposed = false;

  const getAxes = () => ({ left: [...sticks.left.axes], right: [...sticks.right.axes] });
  const activity = (hand, type) => {
    if (typeof onActivity === "function") onActivity({ hand, type, axes: getAxes() });
  };
  const listen = (target, type, handler, options) => {
    target.addEventListener(type, handler, options);
    listeners.push([target, type, handler, options]);
  };
  const consume = (event) => {
    if (event.cancelable) event.preventDefault();
    event.stopPropagation();
  };
  const paint = (stick) => {
    const rect = stick.pad.getBoundingClientRect();
    const radius = Math.max(0, Math.min(rect.width, rect.height) / 2);
    stick.dot.style.transform = `translate(-50%, -50%) translate(${stick.axes[0] * radius}px, ${stick.axes[1] * radius}px)`;
    stick.pad.dataset.active = String(stick.pointerId !== null);
  };
  const release = (hand, type = "release") => {
    const stick = sticks[hand];
    const pointerId = stick.pointerId;
    if (pointerId === null) return;
    // Clear ownership before releasing capture: lostpointercapture may fire
    // synchronously, and must not accidentally clear the next interaction.
    stick.pointerId = null;
    stick.captured = false;
    stick.axes = [0, 0];
    paint(stick);
    try {
      if (stick.pad.hasPointerCapture?.(pointerId)) stick.pad.releasePointerCapture(pointerId);
    } catch { /* Removing or hiding a captured element may already release it. */ }
    activity(hand, type);
  };
  const releaseAll = () => {
    release("left", "release-all");
    release("right", "release-all");
  };
  const move = (hand, event) => {
    const stick = sticks[hand];
    if (!enabled || disposed || event.pointerId !== stick.pointerId) return;
    consume(event);
    stick.axes = normalizeTouchPoint(stick.pad.getBoundingClientRect(), event.clientX, event.clientY);
    paint(stick);
    activity(hand, "move");
  };

  for (const hand of ["left", "right"]) {
    const pad = document.createElement("div");
    pad.className = `touch-stick touch-stick-${hand}`;
    pad.dataset.hand = hand;
    // Restrict gesture suppression to each pad, leaving the rest of the view
    // available for OrbitControls and ordinary page scrolling/pinch gestures.
    pad.style.touchAction = "none";
    pad.setAttribute("role", "group");
    pad.setAttribute("aria-label", hand === "left" ? "左スティック：上下・旋回" : "右スティック：前後・左右");
    const label = document.createElement("span");
    label.className = "touch-stick-label";
    label.textContent = hand === "left" ? "上下 / 旋回" : "前後 / 左右";
    const dot = document.createElement("span");
    dot.className = "touch-stick-dot";
    dot.setAttribute("aria-hidden", "true");
    pad.append(label, dot);
    container.append(pad);
    sticks[hand] = { pad, dot, axes: [0, 0], pointerId: null, captured: false };
    listen(pad, "pointerdown", (event) => {
      const stick = sticks[hand];
      if (!enabled || disposed || stick.pointerId !== null || (event.button != null && event.button !== 0)) return;
      consume(event);
      stick.pointerId = event.pointerId;
      try {
        pad.setPointerCapture(event.pointerId);
        stick.captured = true;
      } catch { /* Window listeners below still handle an uncaptured pointer. */ }
      stick.axes = normalizeTouchPoint(pad.getBoundingClientRect(), event.clientX, event.clientY);
      paint(stick);
      activity(hand, "start");
    });
    listen(pad, "pointermove", (event) => move(hand, event));
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
      listen(pad, type, (event) => {
        if (event.pointerId !== sticks[hand].pointerId) return;
        consume(event);
        release(hand, type);
      });
    }
    paint(sticks[hand]);
  }
  viewport.append(container);

  // Global events only affect pointer IDs owned by these pads. In particular,
  // touching elsewhere never suppresses the browser's normal gestures.
  listen(window, "pointermove", (event) => {
    for (const hand of ["left", "right"]) {
      if (!sticks[hand].captured) move(hand, event);
    }
  });
  for (const type of ["pointerup", "pointercancel"]) {
    listen(window, type, (event) => {
      for (const hand of ["left", "right"]) {
        if (event.pointerId === sticks[hand].pointerId) {
          consume(event);
          release(hand, type);
        }
      }
    });
  }
  listen(window, "blur", releaseAll);
  listen(window, "resize", releaseAll);
  listen(window, "orientationchange", releaseAll);
  listen(document, "visibilitychange", releaseAll);

  return {
    setEnabled(value) {
      if (disposed) return;
      const next = Boolean(value);
      if (next === enabled) return;
      enabled = next;
      container.hidden = !enabled;
      container.dataset.enabled = String(enabled);
      if (!enabled) releaseAll();
    },
    getAxes,
    getState() {
      const axes = getAxes();
      Object.freeze(axes.left);
      Object.freeze(axes.right);
      return Object.freeze({
        enabled,
        disposed,
        axes: Object.freeze(axes),
        pointers: Object.freeze({ left: sticks.left.pointerId, right: sticks.right.pointerId }),
        activePointers: Number(sticks.left.pointerId !== null) + Number(sticks.right.pointerId !== null),
      });
    },
    releaseAll,
    dispose() {
      if (disposed) return;
      enabled = false;
      releaseAll();
      disposed = true;
      for (const [target, type, handler, options] of listeners) target.removeEventListener(type, handler, options);
      listeners.length = 0;
      container.remove();
    },
  };
}
