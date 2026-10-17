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
        color: "#e8bb74", roughness: .8, metalness: 0 }));
      mesh.name = "held-stl-model"; pivot.add(mesh);
    }
    const parent = thirdPerson ? avatar.hand : camera;
    if (root.parent !== parent) parent.add(root);
    root.position.set(...(thirdPerson ? [0,0,0] : [.32,-.27,-.85]));
    const key = `${draft.rotation.toArray().join(":")}:${thirdPerson}`;
    if (key !== transformKey) {
      transformKey = key;
      const geometry = draft.geometry;
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      const box = geometry.boundingBox, center = box.getCenter(new THREE.Vector3());
      // Fit even tilted or very large source units into a small hand-sized model.
      const centered = box.clone().translate(center.clone().negate());
      const rotated = centered.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(draft.rotation));
      const extent = Math.max(...rotated.getSize(new THREE.Vector3()).toArray(), .000001);
      const factor = (thirdPerson ? .65 : .28) / extent;
      mesh.position.copy(center).multiplyScalar(-1); mesh.scale.setScalar(1);
      pivot.scale.setScalar(factor); pivot.rotation.copy(draft.rotation);
    }
    avatar.setHolding(thirdPerson); root.visible = true; root.updateWorldMatrix(true,true);
  }
  return { update, clear, dispose() { clear(); disposed = true; },
    getState: () => ({ visible: root.visible, parent: root.parent?.name ?? null,
      sourceId: source?.userData.creationId ?? null, disposed }) };
}
