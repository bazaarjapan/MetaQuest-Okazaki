// The editor and inventory borrow the world's WebGL context. Their DOM
// canvases keep a 2D copy, so a stationary preview costs no draw calls.
export function createSTLRenderSurface(THREE, renderer, canvas) {
  const context = canvas.getContext("2d");
  const clearColor = new THREE.Color();
  let target, pixels, image;

  function render(scene, camera) {
    const { width, height } = canvas;
    if (!context || !width || !height || renderer.xr.isPresenting) return false;
    if (!target || width !== target.width || height !== target.height) {
      target?.dispose();
      target = new THREE.WebGLRenderTarget(width, height, { colorSpace: THREE.SRGBColorSpace });
      image = context.createImageData(width, height);
      pixels = new Uint8Array(image.data.length);
    }
    const previousTarget = renderer.getRenderTarget();
    const previousFace = renderer.getActiveCubeFace();
    const previousLevel = renderer.getActiveMipmapLevel();
    const previousAlpha = renderer.getClearAlpha();
    renderer.getClearColor(clearColor);
    const previousXR = renderer.xr.enabled;
    const previousShadows = renderer.shadowMap.enabled;
    try {
      renderer.xr.enabled = false;
      renderer.shadowMap.enabled = false;
      renderer.setRenderTarget(target);
      renderer.setClearColor(0, 0);
      renderer.clear();
      renderer.render(scene, camera);
      renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
    } finally {
      renderer.setRenderTarget(previousTarget, previousFace, previousLevel);
      renderer.setClearColor(clearColor, previousAlpha);
      renderer.xr.enabled = previousXR;
      renderer.shadowMap.enabled = previousShadows;
    }
    const stride = width * 4;
    for (let y = 0; y < height; y++) {
      image.data.set(pixels.subarray(y * stride, (y + 1) * stride), (height - 1 - y) * stride);
    }
    context.putImageData(image, 0, 0);
    return true;
  }
  return { render, dispose() { target?.dispose(); target = pixels = image = null; } };
}

export function createSTLThumbnailRenderer(THREE, renderer) {
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, .1, 10);
  camera.position.set(1.25, .9, 1.65).setLength(4);
  camera.lookAt(0, 0, 0);
  const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
  keyLight.position.set(-2, 4, 3);
  scene.add(keyLight, new THREE.HemisphereLight(0xf1ffff, 0x66798b, 1.4));
  const material = new THREE.MeshLambertMaterial({ color: 0x477e88, side: THREE.DoubleSide, toneMapped: false });
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 80;
  const surface = createSTLRenderSurface(THREE, renderer, canvas);

  function render(geometry) {
    const { center, radius } = geometry.boundingSphere;
    if (!(radius > 0)) return null;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.scale.setScalar(.96 / radius);
    mesh.position.copy(center).multiplyScalar(-mesh.scale.x);
    scene.add(mesh);
    try {
      return surface.render(scene, camera) ? canvas.toDataURL("image/png") : null;
    } finally {
      scene.remove(mesh);
    }
  }
  return { render, dispose() { material.dispose(); surface.dispose(); } };
}
