import * as THREE from "three";

// Local visual only: never move the placement draft, mutate its material, or
// dispose geometry owned by the workshop cache. Server placement stays full size.
export function createHeldSTL({ avatar, camera }) {
  const root = new THREE.Group(); root.name = "held-stl"; root.visible = false;
  const pivot = new THREE.Group(); root.add(pivot);
  let source = null, mesh = null, transformKey = "", disposed = false;
  function clear() {
    if (mesh) { mesh.removeFromParent(); mesh.material.dispose(); }
    source = mesh = null; transformKey = ""; root.visible = false;
    root.removeFromParent(); avatar.setHolding(false);
  }
  function update({ draft = null, canEdit = false, xr = false, hidden = false,
    thirdPerson = false } = {}) {
    if (disposed) return;
    if (!canEdit || xr || hidden || !draft?.userData.isDraft) { clear(); return; }
    if (source !== draft) {
      clear(); source = draft;
      mesh = new THREE.Mesh(draft.geometry, new THREE.MeshStandardMaterial({
        color: "#e8bb74", roughness: .8, metalness: 0, side: THREE.DoubleSide }));
      mesh.name = "held-stl-model"; pivot.add(mesh);
    }
    // Camera collision may hide the body even in a front/rear view. Keep the
    // inventory indicator visible by using the same camera-mounted fallback.
    const useHand = thirdPerson && avatar.group.visible;
    const parent = useHand ? avatar.hand : camera;
    if (root.parent !== parent) parent.add(root);
    const halfHeight = .85 * Math.tan(THREE.MathUtils.degToRad(camera.getEffectiveFOV()) / 2);
    const halfWidth = halfHeight * camera.aspect;
    const size = useHand ? .65 : Math.min(.28, halfWidth * .6, halfHeight * .6);
    root.position.set(...(useHand ? [0,0,0] : [halfWidth*.45,-halfHeight*.45,-.85]));
    const key = `${draft.rotation.toArray().join(":")}:${size}`;
    if (key !== transformKey) {
      transformKey = key;
      const geometry = draft.geometry;
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      const box = geometry.boundingBox, center = box.getCenter(new THREE.Vector3());
      // Fit even tilted or very large source units into a small hand-sized model.
      const centered = box.clone().translate(center.clone().negate());
      const rotated = centered.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(draft.rotation));
      const extent = Math.max(...rotated.getSize(new THREE.Vector3()).toArray(), .000001);
      const factor = size / extent;
      mesh.position.copy(center).multiplyScalar(-1); mesh.scale.setScalar(1);
      pivot.scale.setScalar(factor); pivot.rotation.copy(draft.rotation);
    }
    avatar.setHolding(useHand); root.visible = true; root.updateWorldMatrix(true,true);
  }
  return { update, clear, dispose() { clear(); disposed = true; },
    getState: () => ({ visible: root.visible, parent: root.parent?.name ?? null,
      sourceId: source?.userData.creationId ?? null, disposed }) };
}
