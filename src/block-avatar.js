// Original, low-cost block-shaped avatar. No third-party character assets.
export function createBlockAvatar(THREE, { color = 0x367fab } = {}) {
  const group = new THREE.Group();
  group.name = "school-block-avatar";
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const materials = new Map();
  let disposed = false;
  function material(value) {
    if (!materials.has(value)) materials.set(value,
      new THREE.MeshStandardMaterial({ color: value, roughness: 1, metalness: 0 }));
    return materials.get(value);
  }
  function block(name, size, position, value, parent = group) {
    const mesh = new THREE.Mesh(geometry, material(value));
    mesh.name = name;
    mesh.scale.set(...size);
    mesh.position.set(...position);
    parent.add(mesh);
    return mesh;
  }
  const torso = block("torso", [0.55, 0.6, 0.3], [0, 1.08, 0], color);
  const head = new THREE.Group();
  head.name = "head";
  head.position.set(0, 1.59, 0);
  group.add(head);
  block("face", [0.43, 0.43, 0.43], [0, 0, 0], 0xeac198, head);
  block("hair", [0.45, 0.12, 0.45], [0, 0.17, 0], 0x403631, head);
  for (const x of [-0.09, 0.09]) {
    block("eye", [0.07, 0.065, 0.012], [x, 0.02, -0.222], 0x253345, head);
  }
  const leftArm = block("left-arm", [0.2, 0.66, 0.25], [-0.4, 1.06, 0], 0xeac198);
  const rightArm = block("right-arm", [0.2, 0.66, 0.25], [0.4, 1.06, 0], 0xeac198);
  const leftLeg = block("left-leg", [0.22, 0.76, 0.27], [-0.145, 0.38, 0], 0x33455d);
  const rightLeg = block("right-leg", [0.22, 0.76, 0.27], [0.145, 0.38, 0], 0x33455d);
  // Derive all geometry from one cube, with only five simple materials.
  torso.userData.avatarPart = true;
  group.visible = false;
  function update({ position = [0, 0, 0], yaw = 0, pitch = 0,
    moving = false, time = 0, visible = true } = {}) {
    if (disposed) return;
    const coordinates = Array.isArray(position) ? position : [position.x, position.y, position.z];
    if (coordinates.length === 3 && coordinates.every(Number.isFinite)) group.position.fromArray(coordinates);
    if (Number.isFinite(yaw)) group.rotation.y = yaw;
    head.rotation.x = Number.isFinite(pitch) ? Math.max(-1.4, Math.min(1.4, pitch)) : 0;
    const swing = moving && Number.isFinite(time) ? Math.sin(time * 9) * 0.35 : 0;
    leftLeg.rotation.x = rightArm.rotation.x = swing;
    rightLeg.rotation.x = leftArm.rotation.x = -swing;
    group.visible = Boolean(visible);
    group.updateMatrixWorld(true);
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    group.removeFromParent();
    geometry.dispose();
    for (const entry of materials.values()) entry.dispose();
    group.visible = false;
  }
  function setColor(value) {
    if (!disposed && (typeof value === "number" || /^#[0-9a-f]{6}$/i.test(value))) torso.material.color.set(value);
  }
  return { group, update, setColor, dispose,
    getState: () => ({ position: group.position.toArray(), yaw: group.rotation.y,
      pitch: head.rotation.x, visible: group.visible, disposed,
      meshCount: 9, geometryCount: 1, materialCount: materials.size }) };
}
