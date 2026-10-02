import { stickAxes } from "./motion.js";

// The panels stay below the city and outside its central viewing corridor.
// Coordinates are metres relative to the user's camera, not world locations.
export const hudLayout = Object.freeze({
  left: Object.freeze({ position: Object.freeze([-0.6, -0.43, -1.5]), size: Object.freeze([0.5, 0.35]) }),
  right: Object.freeze({ position: Object.freeze([0.6, -0.43, -1.5]), size: Object.freeze([0.5, 0.35]) }),
  canvasSize: Object.freeze([512, 360]),
  maxRefreshHz: 15,
});

function clampAxis(value) {
  return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
}

function clampProgress(value) {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

/** A detached snapshot of one XRInputSource; missing devices never retain input. */
export function normalizeControllerInput(source) {
  const gamepad = source?.gamepad;
  // The caller supplies active XRSession.inputSources only. Source presence is
  // authoritative; some XR emulators leave Gamepad.connected false even while
  // reporting live input. Removal from inputSources clears this snapshot.
  const connected = Boolean(gamepad);
  const axes = connected ? (gamepad.axes ?? []) : [];
  const rawAxes = [clampAxis(axes.length >= 4 ? axes[2] : axes[0]), clampAxis(axes.length >= 4 ? axes[3] : axes[1])];
  const normalizedStick = connected ? stickAxes({ axes: rawAxes }) : [0, 0];
  // xr-standard: trigger, squeeze, touchpad, thumbstick, X/A, Y/B.
  const buttons = Array.from({ length: 6 }, (_, index) => {
    const button = connected ? gamepad.buttons?.[index] : null;
    const pressed = Boolean(button?.pressed);
    return {
      value: Number.isFinite(button?.value) ? clampProgress(button.value) : Number(pressed),
      pressed,
      touched: Boolean(button?.touched || pressed),
    };
  });
  return {
    connected,
    rawAxes,
    normalizedStick,
    stickPercent: Math.round(Math.min(1, Math.hypot(...rawAxes)) * 100),
    pressedButtonBits: buttons.reduce((mask, button, index) => mask | (Number(button.pressed) << index), 0),
    touchedButtonBits: buttons.reduce((mask, button, index) => mask | (Number(button.touched) << index), 0),
    buttons,
  };
}

const palette = {
  background: "rgba(8, 20, 35, 0.94)",
  border: "#38556a",
  text: "#eaf6fa",
  subdued: "#99acbc",
  teal: "#40dfc3",
  orange: "#ffb354",
  track: "#1e3549",
};

function roundedRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
}

function drawController(canvas, hand, input, free, flight, xr) {
  const ctx = canvas.getContext("2d");
  const left = hand === "left";
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = palette.background;
  roundedRect(ctx, 2, 2, 508, 356, 24);
  ctx.fill();
  ctx.strokeStyle = input.connected ? palette.teal : palette.border;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.font = '600 26px system-ui, "Noto Sans JP", sans-serif';
  ctx.textAlign = "left";
  ctx.fillStyle = palette.text;
  ctx.fillText(left ? "L  左コントローラー" : "R  右コントローラー", 24, 42);
  const active = Boolean(xr && free && input.connected);
  ctx.fillStyle = active ? palette.teal : palette.subdued;
  ctx.font = "600 19px system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.fillText(active ? "移動 ON" : "移動 OFF", 487, 42);

  // Positive raw Y is downward on Quest, matching canvas screen coordinates.
  const centerX = 128;
  const centerY = 164;
  const radius = 62;
  ctx.fillStyle = palette.track;
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = palette.border;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(centerX - radius, centerY);
  ctx.lineTo(centerX + radius, centerY);
  ctx.moveTo(centerX, centerY - radius);
  ctx.lineTo(centerX, centerY + radius);
  ctx.stroke();
  // A dotted deadzone ring makes small physical inputs visible, even while stopped.
  ctx.setLineDash([3, 4]);
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius * 0.18, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  const magnitude = Math.hypot(...input.rawAxes);
  const scale = magnitude > 1 ? 1 / magnitude : 1;
  const dotX = centerX + input.rawAxes[0] * radius * scale;
  const dotY = centerY + input.rawAxes[1] * radius * scale;
  ctx.strokeStyle = input.connected ? palette.teal : palette.subdued;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(centerX, centerY);
  ctx.lineTo(dotX, dotY);
  ctx.stroke();
  ctx.fillStyle = input.buttons[3].pressed ? palette.orange : input.connected ? palette.teal : palette.subdued;
  ctx.beginPath();
  ctx.arc(dotX, dotY, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.textAlign = "center";
  ctx.fillStyle = palette.subdued;
  ctx.font = '18px system-ui, "Noto Sans JP", sans-serif';
  ctx.fillText(left ? "上昇" : "前進", centerX, 88);
  ctx.fillText(left ? "下降" : "後退", centerX, 251);
  ctx.font = "16px system-ui, sans-serif";
  ctx.fillText(left ? "旋回" : "横移動", centerX, 276);
  ctx.fillStyle = input.connected ? palette.text : palette.subdued;
  ctx.font = "600 25px system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(`倒し量 ${input.stickPercent}%`, 249, 91);

  for (const [offset, index, label] of [[0, 4, left ? "X" : "A"], [76, 5, left ? "Y" : "B"]]) {
    const button = input.buttons[index];
    const x = 251 + offset;
    ctx.fillStyle = button.pressed ? palette.orange : button.touched ? palette.teal : palette.track;
    roundedRect(ctx, x, 106, 60, 40, 12);
    ctx.fill();
    ctx.strokeStyle = button.touched ? palette.teal : palette.border;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.textAlign = "center";
    ctx.font = "700 24px system-ui, sans-serif";
    ctx.fillStyle = button.pressed || button.touched ? "#091725" : palette.text;
    ctx.fillText(label, x + 30, 134);
  }

  for (const [y, index, label] of [[177, 0, "トリガー"], [229, 1, "グリップ"]]) {
    const button = input.buttons[index];
    ctx.textAlign = "left";
    ctx.fillStyle = palette.subdued;
    ctx.font = '17px system-ui, "Noto Sans JP", sans-serif';
    ctx.fillText(label, 249, y);
    ctx.textAlign = "right";
    ctx.fillStyle = button.pressed ? palette.orange : palette.text;
    ctx.fillText(`${Math.round(button.value * 100)}%`, 484, y);
    ctx.fillStyle = palette.track;
    roundedRect(ctx, 249, y + 8, 235, 11, 5);
    ctx.fill();
    if (button.value > 0) {
      ctx.fillStyle = button.pressed ? palette.orange : palette.teal;
      roundedRect(ctx, 249, y + 8, Math.max(1, 235 * button.value), 11, 5);
      ctx.fill();
    }
  }

  ctx.textAlign = "left";
  ctx.fillStyle = palette.text;
  ctx.font = '20px system-ui, "Noto Sans JP", sans-serif';
  const speed = left ? flight.verticalSpeed : flight.horizontalSpeed;
  ctx.fillText(left ? "上下・旋回" : "前後・横移動", 25, 310);
  ctx.textAlign = "right";
  ctx.fillStyle = palette.teal;
  ctx.fillText(`${active ? speed.toFixed(1) : "0.0"} m/s`, 487, 310);
  ctx.font = '16px system-ui, "Noto Sans JP", sans-serif';
  ctx.fillStyle = input.connected ? palette.subdued : palette.orange;
  ctx.textAlign = "left";
  ctx.fillText(input.connected ? (active ? "離すと停止 · 倒し量で速度変化" : "自由移動 OFF · B で切り替え") : "未接続 · Quest の VR 中に操作を表示", 25, 339);
}

function finiteSpeed(value) {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/** Shared controller canvases, with optional spatial planes and passive PC previews. */
export function createControllerHud(THREE, camera, viewport, { spatial = true } = {}) {
  let xr = false;
  let lastDrawTime = -Infinity;
  let renderCount = 0;
  let free = false;
  let embeddedVisible = false;
  let flight = { horizontalSpeed: 0, verticalSpeed: 0 };
  let hands = { left: normalizeControllerInput(null), right: normalizeControllerInput(null) };
  const panels = {};
  for (const hand of ["left", "right"]) {
    const canvas = document.createElement("canvas");
    [canvas.width, canvas.height] = hudLayout.canvasSize;
    canvas.style.cssText = "position:relative;inset:auto;width:100%;height:auto;display:block;";
    canvas.setAttribute("aria-hidden", "true");
    let texture = null, mesh = null;
    if (spatial) {
      texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
      const material = new THREE.MeshBasicMaterial({
        map: texture, transparent: true, toneMapped: false, depthTest: false, depthWrite: false,
      });
      mesh = new THREE.Mesh(new THREE.PlaneGeometry(...hudLayout[hand].size), material);
      mesh.name = `controller-hud-${hand}`;
      mesh.position.fromArray(hudLayout[hand].position);
      mesh.renderOrder = 1001;
      mesh.frustumCulled = false;
      mesh.visible = false;
      camera.add(mesh);
    }
    const overlay = document.createElement("figure");
    overlay.className = `controller-hud-preview controller-hud-${hand}`;
    overlay.style.cssText = `position:absolute;${hand === "left" ? "left" : "right"}:14px;bottom:clamp(100px,8vw,112px);width:clamp(112px,12vw,160px);margin:0;pointer-events:none;z-index:3;`;
    overlay.setAttribute("aria-label", hand === "left" ? "Quest 左コントローラーの操作表示。VR 中に有効" : "Quest 右コントローラーの操作表示。VR 中に有効");
    overlay.append(canvas);
    viewport.append(overlay);
    panels[hand] = { canvas, texture, mesh, overlay, drawKey: "" };
  }

  function render(timeMs, force = false) {
    if (!force && timeMs - lastDrawTime < 1000 / hudLayout.maxRefreshHz) return;
    let drawn = false;
    for (const hand of ["left", "right"]) {
      const input = hands[hand];
      // Quantization avoids texture uploads for sub-pixel stick jitter while the
      // unrounded diagnostic state still reflects every input sample.
      const drawKey = JSON.stringify({
        xr, free,
        connected: input.connected,
        raw: input.rawAxes.map((axis) => Math.round(axis * 200)),
        stickPercent: input.stickPercent,
        pressed: input.pressedButtonBits,
        touched: input.touchedButtonBits,
        values: input.buttons.map((button) => Math.round(button.value * 100)),
        speed: (hand === "left" ? flight.verticalSpeed : flight.horizontalSpeed).toFixed(1),
      });
      const panel = panels[hand];
      if (panel.drawKey === drawKey) continue;
      drawController(panel.canvas, hand, input, free, flight, xr);
      if (panel.texture) panel.texture.needsUpdate = true;
      panel.drawKey = drawKey;
      drawn = true;
    }
    if (drawn) {
      renderCount += 1;
      lastDrawTime = timeMs;
    }
  }

  function update(inputSources, options = {}, timeMs = performance.now()) {
    const sources = Array.from(inputSources ?? []);
    hands = {
      left: normalizeControllerInput(xr ? sources.find((source) => source.handedness === "left" && source.gamepad) : null),
      right: normalizeControllerInput(xr ? sources.find((source) => source.handedness === "right" && source.gamepad) : null),
    };
    free = Boolean(xr && options.free);
    flight = {
      horizontalSpeed: finiteSpeed(options.flight?.horizontalSpeed),
      verticalSpeed: finiteSpeed(options.flight?.verticalSpeed),
    };
    render(Number.isFinite(timeMs) ? timeMs : performance.now());
  }

  function setXR(active) {
    xr = Boolean(active);
    // Session boundaries discard previous device state before a new sample.
    hands = { left: normalizeControllerInput(null), right: normalizeControllerInput(null) };
    free = false;
    flight = { horizontalSpeed: 0, verticalSpeed: 0 };
    for (const panel of Object.values(panels)) {
      if (panel.mesh) panel.mesh.visible = xr;
      panel.overlay.hidden = xr;
    }
    render(performance.now(), true);
  }

  function getState() {
    // Never expose arrays owned by the render loop or mutation handles to meshes.
    return JSON.parse(JSON.stringify({
      xr,
      visible: true,
      renderCount,
      free,
      layout: { left: hudLayout.left, right: hudLayout.right },
      hands: Object.fromEntries(Object.entries(hands).map(([hand, input]) => [hand, {
        ...input,
        active: Boolean(xr && free && input.connected),
        visible: true,
        spatialVisible: Boolean(panels[hand].mesh?.visible),
        embeddedVisible: Boolean(xr && embeddedVisible),
        previewVisible: !panels[hand].overlay.hidden,
      }])),
    }));
  }

  setXR(false);
  return { update, setXR, getState,
    getCanvases: () => ({ left: panels.left.canvas, right: panels.right.canvas }),
    setEmbeddedVisible: (value) => { embeddedVisible = Boolean(value); },
  };
}
