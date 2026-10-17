import * as THREE from "three";

// Local visual only: never move the placement draft, mutate its material, or
// dispose geometry owned by the workshop cache. Server placement stays full size.
export function createHeldSTL({ avatar, camera }) {
  const root = new THREE.Group(); root.name = "held-stl"; root.visible = false;
  const pivot = new THREE.Group(); root.add(pivot);
  // A separate local view-model: never reveal the full avatar inside its eyes,
  // and never add these meshes to placement/collision or multiplayer objects.
  const arm = new THREE.Group(); arm.name = "first-person-arm"; arm.visible = false; camera.add(arm);
  const armGeometry = new THREE.BoxGeometry(1,1,1);
  const skin = new THREE.MeshStandardMaterial({roughness:1, transparent:true, depthTest:false, depthWrite:false});
  const sleeve = skin.clone();
  const parts = [skin, sleeve, skin, skin].map((material,index) => {
    const part = new THREE.Mesh(armGeometry,material);
    part.name = ["first-person-forearm","first-person-sleeve","first-person-palm","first-person-thumb"][index];
    part.renderOrder = 1000; arm.add(part); return part;
  });
  const up = new THREE.Vector3(0,1,0), wrist = new THREE.Vector3(), base = new THREE.Vector3();
  const direction = new THREE.Vector3(), midpoint = new THREE.Vector3();
  const avatarSkin = avatar.group.getObjectByName("right-arm").material.color;
  const avatarShirt = avatar.group.getObjectByName("torso").material.color;
  let source = null, mesh = null, transformKey = "", disposed = false;
  let heldHeight = 0;
  function clearItem() {
    if (mesh) { mesh.removeFromParent(); mesh.material.dispose(); }
    source = mesh = null; transformKey = ""; root.visible = false;
    root.removeFromParent(); avatar.setHolding(false);
  }
  function clear() { clearItem(); arm.visible = false; }
  function updateArm(halfWidth, halfHeight, holding) {
    skin.color.copy(avatarSkin); sleeve.color.copy(avatarShirt);
    const scale = Math.min(1,halfWidth/.28,halfHeight/.30);
    wrist.set(halfWidth*.56, holding ? -halfHeight*.22-heldHeight/2 : -halfHeight*.40, -.85);
    // Palm's top supports the model's lowest rotated bound, not its centre.
    parts[2].position.copy(wrist).add(new THREE.Vector3(0,-.035*scale,0));
    parts[2].scale.set(.16*scale,.07*scale,.17*scale);
    parts[3].position.copy(wrist).add(new THREE.Vector3(-.085*scale,-.015*scale,.02*scale));
    parts[3].scale.set(.045*scale,.08*scale,.09*scale);
    base.set(halfWidth*.90,-halfHeight*1.05,-.60);
    midpoint.copy(wrist).lerp(base,.58);
    for (const [part,start,end,width] of [[parts[0],wrist,midpoint,.13],[parts[1],midpoint,base,.16]]) {
      direction.copy(end).sub(start);
      part.position.copy(start).add(end).multiplyScalar(.5);
      part.quaternion.setFromUnitVectors(up,direction.clone().normalize());
      part.scale.set(width*scale,direction.length(),width*scale);
    }
    arm.visible = true; arm.updateWorldMatrix(true,true);
  }
  function update({ draft = null, canEdit = false, xr = false, hidden = false,
    thirdPerson = false, firstPerson = false } = {}) {
    if (disposed) return;
    if (xr || hidden) { clear(); return; }
    const halfHeight = .85 * Math.tan(THREE.MathUtils.degToRad(camera.getEffectiveFOV()) / 2);
    const halfWidth = halfHeight * camera.aspect;
    arm.visible = false;
    if (!canEdit || !draft?.userData.isDraft) {
      clearItem(); if (firstPerson) updateArm(halfWidth,halfHeight,false); return;
    }
    if (source !== draft) {
      clearItem(); source = draft;
      mesh = new THREE.Mesh(draft.geometry, new THREE.MeshStandardMaterial({
        color: "#e8bb74", roughness: .8, metalness: 0, side: THREE.DoubleSide }));
      mesh.name = "held-stl-model"; pivot.add(mesh);
    }
    // Camera collision may hide the body even in a front/rear view. Keep the
    // inventory indicator visible by using the same camera-mounted fallback.
    const useHand = thirdPerson && avatar.group.visible;
    const parent = useHand ? avatar.hand : camera;
    if (root.parent !== parent) parent.add(root);
    // Draw the camera view-model after the world so nearby walls/terrain cannot
    // cut through the hand. Restore ordinary depth for the third-person copy.
    const overlay = !useHand;
    if (mesh.material.transparent !== overlay) { mesh.material.transparent = overlay; mesh.material.needsUpdate = true; }
    mesh.material.depthTest = mesh.material.depthWrite = !overlay;
    mesh.renderOrder = overlay ? 1001 : 0;
    const size = useHand ? .65 : firstPerson ? Math.min(.20, halfWidth*.5, halfHeight*.5) : Math.min(.28, halfWidth*.6, halfHeight*.6);
    root.position.set(...(useHand ? [0,0,0] : firstPerson ? [halfWidth*.56,-halfHeight*.22,-.85] : [halfWidth*.45,-halfHeight*.45,-.85]));
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
      heldHeight = rotated.getSize(new THREE.Vector3()).y * factor;
      mesh.position.copy(center).multiplyScalar(-1); mesh.scale.setScalar(1);
      pivot.scale.setScalar(factor); pivot.rotation.copy(draft.rotation);
    }
    if (firstPerson && !useHand) updateArm(halfWidth,halfHeight,true);
    avatar.setHolding(useHand); root.visible = true; root.updateWorldMatrix(true,true);
  }
  return { update, clear, dispose() { if (disposed) return; clear(); disposed = true; arm.removeFromParent(); armGeometry.dispose(); skin.dispose(); sleeve.dispose(); },
    getState: () => ({ visible: root.visible, parent: root.parent?.name ?? null,
      sourceId: source?.userData.creationId ?? null, armVisible: arm.visible,
      armHolding: arm.visible && root.visible, disposed }) };
}
