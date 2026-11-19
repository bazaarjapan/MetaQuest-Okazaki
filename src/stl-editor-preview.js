import { applySTLFinish } from "./stl-finish-material.js";
import { createSTLRenderSurface } from "./stl-thumbnail.js";

const dimension = meters => meters < .01 && meters > 0
  ? `${Number((meters * 1000).toPrecision(3))} mm`
  : `${Number(meters.toPrecision(3))} m`;

// Use the same model and material as the street. Keep the camera framing stable
// while sizing so shrinking a model visibly shrinks it against the floor grid.
export function createSTLEditorPreview(THREE, renderer, canvas, caption) {
  const surface = createSTLRenderSurface(THREE, renderer, canvas);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xe1efed);
  const light = new THREE.DirectionalLight(0xfff4db, 2.5);
  light.position.set(2, 4, 3);
  const grid = new THREE.GridHelper(8, 32, 0x7c9d98, 0xc1d5d1);
  scene.add(light, new THREE.HemisphereLight(0xf3ffff, 0xc5c2b8, 1.7), grid);
  const material = new THREE.MeshStandardMaterial({ roughness: .85, side: THREE.DoubleSide });
  const camera = new THREE.OrthographicCamera();
  const size = new THREE.Vector3(), center = new THREE.Vector3(), box = new THREE.Box3();
  let mesh, itemId, initialSpan, lastKey, lastTransform;
  function draw(item, color, finish, faces) {
    const geometry = item.mesh.geometry;
    const transform = JSON.stringify([geometry.uuid, item.scale, item.rotation]);
    const key = JSON.stringify([item.id, transform, color, finish, faces]);
    if (key === lastKey) return;
    if (!mesh || mesh.geometry !== geometry) {
      if (mesh) scene.remove(mesh);
      mesh = new THREE.Mesh(geometry, material);
      scene.add(mesh);
      itemId = null;
    }
    if (lastTransform !== transform) {
      mesh.position.set(0, 0, 0);
      mesh.rotation.set(...item.rotation, "XYZ");
      mesh.scale.fromArray(item.scale);
      // Measure the rotated triangles themselves; a rotated bounding box can
      // overstate the dimensions of a slanted roof or L-shaped footprint.
      box.setFromObject(mesh, true);
      box.getSize(size);
      box.getCenter(center);
      caption.textContent = `幅 ${dimension(size.x)} × 高さ ${dimension(size.y)} × 奥行 ${dimension(size.z)}`;
      lastTransform = transform;
    }
    const span = Math.max(size.x, size.y, size.z, .000001);
    if (itemId !== item.id) {
      itemId = item.id;
      initialSpan = span;
    }
    // Allow a visible change at normal scales, then reframe unusually large edits.
    const framing = Math.max(initialSpan * 1.8, span * 1.38);
    mesh.scale.fromArray(item.scale).divideScalar(framing);
    mesh.position.set(-center.x, -box.min.y, -center.z).divideScalar(framing);
    material.color.set(color);
    applySTLFinish(mesh, finish, faces);
    const aspect = canvas.width / canvas.height;
    camera.left = -aspect / 2; camera.right = aspect / 2;
    camera.top = .5; camera.bottom = -.5; camera.near = .01; camera.far = 20;
    camera.position.set(2.3, 1.65, 2.8);
    camera.lookAt(0, .25, 0);
    camera.updateProjectionMatrix();
    surface.render(scene, camera);
    lastKey = key;
  }
  return { draw, dispose() {
    surface.dispose(); grid.geometry.dispose(); grid.material.dispose(); material.dispose();
  } };
}
