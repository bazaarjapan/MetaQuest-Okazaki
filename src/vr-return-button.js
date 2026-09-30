// A small head-relative escape route, independent of the optional guide.
export function createVRReturnButton(THREE, camera) {
  const canvas = document.createElement("canvas");
  canvas.width = 768;
  canvas.height = 160;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.82, 0.16),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true,
      depthTest: false, depthWrite: false, toneMapped: false }));
  mesh.name = "vr-return-button";
  mesh.position.set(0.66, 0.80, -1.8);
  mesh.renderOrder = 1001;
  mesh.visible = false;
  camera.add(mesh);
  let progress = 0, exiting = false, hovered = false, lastKey = "";
  function draw() {
    const key = `${Math.round(progress * 100)}:${exiting}:${hovered}`;
    if (key === lastKey) return;
    lastKey = key;
    const c = canvas.getContext("2d");
    c.clearRect(0, 0, canvas.width, canvas.height);
    c.fillStyle = hovered ? "#244d60f5" : "#112b3df5";
    c.beginPath(); c.roundRect(2, 2, 764, 156, 22); c.fill();
    c.strokeStyle = hovered ? "#ffffff" : "#94e3d0";
    c.lineWidth = 3; c.stroke();
    // Browser-window pictogram and a return arrow, not a shutdown icon.
    c.strokeStyle = "#b4e9db"; c.lineWidth = 4;
    c.strokeRect(28, 48, 68, 54);
    c.beginPath(); c.moveTo(28, 62); c.lineTo(96, 62); c.stroke();
    c.beginPath(); c.moveTo(76, 83); c.lineTo(44, 83);
    c.lineTo(54, 73); c.moveTo(44, 83); c.lineTo(54, 93); c.stroke();
    c.textAlign = "left"; c.fillStyle = "white";
    c.font = "bold 44px sans-serif";
    c.fillText(exiting ? "2D画面に戻っています…" : "2D画面に戻る", 120, 70, 500);
    c.font = "24px sans-serif"; c.fillStyle = "#d0e8ed";
    c.fillText(exiting ? "ページはそのまま・移動は停止" :
      hovered ? "トリガーを押すと戻れます" : "Xを1.5秒長押しでも戻れます", 120, 114, 500);
    c.strokeStyle = "#436574"; c.lineWidth = 8;
    c.beginPath(); c.arc(690, 80, 40, 0, Math.PI * 2); c.stroke();
    if (progress > 0) {
      c.strokeStyle = "#94f5ce";
      c.beginPath(); c.arc(690, 80, 40, -Math.PI / 2,
        -Math.PI / 2 + progress * Math.PI * 2); c.stroke();
    }
    c.textAlign = "center"; c.fillStyle = "white"; c.font = "bold 30px sans-serif";
    c.fillText("X", 690, 90);
    texture.needsUpdate = true;
  }
  draw();
  return {
    mesh,
    setVisible: (value) => { mesh.visible = Boolean(value); },
    update: (next = {}) => {
      progress = Math.max(0, Math.min(1, next.progress ?? progress));
      exiting = Boolean(next.exiting ?? exiting);
      hovered = Boolean(next.hovered ?? hovered);
      draw();
    },
    getState: () => ({ position: mesh.position.toArray(), size: [0.82, 0.16],
      visible: mesh.visible, progress, exiting, hovered }),
  };
}
