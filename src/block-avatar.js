import { validAvatarMotion } from "./avatar-motion.js";
// Original, low-cost block-shaped avatar. No third-party character assets.
export function avatarAppearance(identity) {
  // Only the server's opaque user ID seeds the look. No name, email, Google
  // profile image or third-party character asset is used or persisted here.
  let seed = 2166136261;
  for (const character of typeof identity === "string" ? identity.slice(0, 80) : "") {
    seed = Math.imul(seed ^ character.charCodeAt(0), 16777619) >>> 0;
  }
  return { skin: [0xeac198, 0xc99067, 0x936348, 0xf0d4b4][seed % 4],
    hair: [0x403631, 0x252f40, 0x80532e, 0xb38449][(seed >>> 4) % 4],
    trousers: [0x33455d, 0x4f5268, 0x315b53, 0x684d5a][(seed >>> 8) % 4],
    accent: [0xf5ba42, 0xe76b91, 0x72d8c0, 0xb7a2ed, 0xff8855, 0xe9eee9][(seed >>> 12) % 6],
    hairStyle: (seed >>> 16) % 3, pattern: (seed >>> 20) % 3 };
}
export function createBlockAvatar(THREE, { color = 0x367fab, identity = null, batchBlocks = false } = {}) {
  const group = new THREE.Group();
  group.name = "school-block-avatar";
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const geometries = new Set([geometry]);
  const materials = new Map();
  let disposed = false;
  function material(value, key) {
    if (!materials.has(key)) materials.set(key,
      new THREE.MeshStandardMaterial({ color: value, roughness: 1, metalness: 0 }));
    return materials.get(key);
  }
  function block(name, size, position, value, parent = group) {
    const key = name.startsWith("trim-") || name.startsWith("wing-") ? "accent" : name.startsWith("rocket-") ? "trousers" : name.startsWith("flame-") ? "flame" : name === "hair-side" ? "hair" : name === "torso" ? "shirt" : name === "face" || name.endsWith("arm") ? "skin" : name.endsWith("leg") ? "trousers" : name;
    const mesh = new THREE.Mesh(geometry, material(value, key));
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
  const face = block("face", [0.43, 0.43, 0.43], [0, 0, 0], 0xeac198, head);
  const hair = block("hair", [0.45, 0.12, 0.45], [0, 0.17, 0], 0x403631, head);
  for (const x of [-0.09, 0.09]) {
    block("eye", [0.07, 0.065, 0.012], [x, 0.02, -0.222], 0x253345, head);
  }
  const leftArm = block("left-arm", [0.2, 0.66, 0.25], [-0.4, 1.06, 0], 0xeac198);
  const rightArm = block("right-arm", [0.2, 0.66, 0.25], [0.4, 1.06, 0], 0xeac198);
  const hand = new THREE.Group(); hand.name = "held-stl-hand";
  hand.position.set(.4, .99, -.52); group.add(hand);
  let holding = false;
  function setHolding(value) {
    if (holding === Boolean(value)) return;
    holding = Boolean(value);
    batchDirty = true;
    rightArm.rotation.x = holding ? Math.PI / 3 : 0;
    rightArm.position.set(.4, holding ? .14 : .06, holding ? -.12 : 0);
  }
  const leftLeg = block("left-leg", [0.22, 0.76, 0.27], [-0.145, 0.38, 0], 0x33455d);
  const rightLeg = block("right-leg", [0.22, 0.76, 0.27], [0.145, 0.38, 0], 0x33455d);
  const hairSide = block("hair-side", [.12, .3, .45], [.19, .04, 0], 0x403631, head);
  const frontTrim = block("trim-front", [.56, .12, .016], [0, 1.08, -.158], 0xf5ba42);
  const backTrim = block("trim-back", [.56, .12, .016], [0, 1.08, .158], 0xf5ba42);
  // Original beetle-like elytra: rounded hard covers over thin, veined hindwings.
  // All avatars reuse these few geometries within the avatar, with no image assets.
  // User's shield outline: straight centre seam and top, curved outer edge
  // tapering to the bottom. Mirror the same thin shell for the other side.
  const shellOutline = new THREE.Shape(); shellOutline.moveTo(0,0);
  shellOutline.lineTo(.29,0);
  shellOutline.bezierCurveTo(.32,-.2,.33,-.47,.23,-.61);
  shellOutline.bezierCurveTo(.17,-.71,.07,-.78,0,-.83);
  shellOutline.lineTo(0,0);
  const shellGeometry = new THREE.ExtrudeGeometry(shellOutline, {depth:.055,steps:1,
    bevelEnabled:true,bevelThickness:.012,bevelSize:.01,bevelSegments:2,curveSegments:8});
  geometries.add(shellGeometry);
  const shellMaterial = material(0x285b45, "wing-shell");
  shellMaterial.roughness = .3; shellMaterial.metalness = .25;
  const shape = new THREE.Shape(); shape.moveTo(0, 0);
  // Draw the OPEN right hindwing directly: a firm upper leading edge,
  // broad/scalloped lower trailing edge, and veins fanning out from the root.
  // Mirroring X alone preserves the reference's top/bottom on BOTH sides.
  shape.bezierCurveTo(.38, -.01, .95, -.07, 1.34, -.36);
  shape.bezierCurveTo(1.18, -.31, 1.13, -.43, 1.10, -.50);
  shape.bezierCurveTo(.91, -.44, .91, -.61, .76, -.62);
  shape.bezierCurveTo(.57, -.53, .46, -.66, .31, -.55);
  shape.bezierCurveTo(.13, -.40, .04, -.21, 0, 0);
  const membraneGeometry = new THREE.ShapeGeometry(shape, 8); geometries.add(membraneGeometry);
  const membraneMaterial = material(0xe7c992, "wing-membrane");
  membraneMaterial.side = THREE.DoubleSide; membraneMaterial.transparent = true;
  membraneMaterial.opacity = .58; membraneMaterial.depthWrite = false;
  const veinPoints = [[0,0,.008],[1.30,-.35,.008], [0,0,.008],[1.08,-.48,.008],
    [0,0,.008],[.76,-.60,.008], [0,0,.008],[.33,-.53,.008],
    [.35,-.12,.008],[.75,-.27,.008], [.75,-.27,.008],[1.08,-.48,.008]];
  const veinGeometry = new THREE.BufferGeometry().setFromPoints(veinPoints.map(p => new THREE.Vector3(...p)));
  geometries.add(veinGeometry);
  const veinMaterial = new THREE.LineBasicMaterial({color:0x8f764c}); materials.set("wing-veins",veinMaterial);
  const wings = [-1, 1].map((sign, i) => {
    const hinge = new THREE.Group(); hinge.position.set(sign * .012, 1.38, .18); group.add(hinge);
    const shell = new THREE.Mesh(shellGeometry, shellMaterial); shell.name = `wing-shell-${i}`;
    shell.scale.x = sign; hinge.add(shell);
    const inner = new THREE.Group(); inner.name = `wing-inner-${i}`;
    inner.position.set(sign * .15, 1.27, .23); inner.scale.x = sign; group.add(inner);
    const membrane = new THREE.Mesh(membraneGeometry, membraneMaterial); membrane.name = `wing-membrane-${i}`;
    inner.add(membrane, new THREE.LineSegments(veinGeometry, veinMaterial)); inner.visible = false;
    return { hinge, inner, sign };
  });
  const flames = [-1, 1].map((sign, i) => {
    block(`rocket-${i}`, [.15, .48, .06], [sign * .14, 1.07, .19], 0x33455d);
    const flame = block(`flame-${i}`, [.12, .48, .12], [sign * .14, .62, .19], 0xffa529);
    flame.material.emissive.set(0xff6600); flame.visible = false; return flame;
  });
  // Tilt the body around its centre in flight, leaving the world-space feet and
  // nickname label stable. The held-STL hand follows this same body transform.
  const body = new THREE.Group(); body.name = "avatar-body"; body.position.y = 1;
  for (const child of [...group.children]) { child.position.y -= 1; body.add(child); }
  group.add(body);
  let motion = "idle";
  let appearance = { skin: 0xeac198, hair: 0x403631, trousers: 0x33455d };
  // Remote avatars share one draw for their solid cubes. The detached cubes
  // retain their transforms for the same limb, head and clothing animation.
  let batch = null, batchDirty = true, previousStance = null, previousPitch = null;
  const cubes = [], cubeMatrix = new THREE.Matrix4();
  if (batchBlocks) {
    body.traverse((part) => {
      if (part.geometry === geometry && !flames.includes(part)) cubes.push({ part, parent: part.parent });
    });
    batch = new THREE.InstancedMesh(geometry, material(0xffffff, "blocks"), cubes.length);
    batch.name = "avatar-blocks";
    batch.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // The bounding volume includes every limb throughout its full gait.
    batch.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 2);
    for (const { part } of cubes) part.removeFromParent();
    body.add(batch);
  }
  function updateBatch() {
    head.updateMatrix();
    let count = 0;
    for (const { part, parent } of cubes) {
      if (!part.visible) continue;
      part.updateMatrix();
      cubeMatrix.copy(part.matrix);
      if (parent === head) cubeMatrix.premultiply(head.matrix);
      batch.setMatrixAt(count, cubeMatrix);
      if (batchDirty) batch.setColorAt(count, part.material.color);
      count++;
    }
    batch.count = count;
    batch.instanceMatrix.needsUpdate = true;
    if (batchDirty) batch.instanceColor.needsUpdate = true;
    batchDirty = false;
  }
  function setIdentity(value) {
    if (disposed) return;
    appearance = avatarAppearance(value);
    face.material.color.set(appearance.skin);
    hair.material.color.set(appearance.hair);
    leftLeg.material.color.set(appearance.trousers);
    frontTrim.material.color.set(appearance.accent);
    hair.scale.set(...[[.45, .12, .45], [.25, .21, .45], [.45, .1, .33]][appearance.hairStyle]);
    hair.position.y = appearance.hairStyle === 1 ? .22 : .17;
    hairSide.visible = appearance.hairStyle === 2;
    for (const trim of [frontTrim, backTrim]) {
      trim.scale.set(...[[.56, .12, .016], [.13, .59, .016], [.22, .22, .016]][appearance.pattern]);
      trim.position.x = appearance.pattern === 2 ? .12 : 0;
    }
    batchDirty = true;
  }
  setIdentity(identity);
  // Body/rockets share a cube; shell, membrane and veins each share one geometry.
  torso.userData.avatarPart = true;
  group.visible = false;
  function update({ position = [0, 0, 0], yaw = 0, pitch = 0,
    moving = false, animation, time = 0, visible = true, distant = false } = {}) {
    if (disposed) return;
    if (Array.isArray(position)) {
      if (position.length === 3 && position.every(Number.isFinite)) group.position.fromArray(position);
    } else if (Number.isFinite(position.x) && Number.isFinite(position.y) && Number.isFinite(position.z)) {
      group.position.copy(position);
    }
    if (Number.isFinite(yaw)) group.rotation.y = yaw;
    head.rotation.x = Number.isFinite(pitch) ? Math.max(-1.4, Math.min(1.4, pitch)) : 0;
    motion = validAvatarMotion(animation) ? animation : moving ? "walk" : "idle";
    group.visible = Boolean(visible);
    // At a distance the colored body and nickname still track the player.
    // Idle or distant classmates can translate/turn without rebuilding bones.
    const stance = distant ? "distant" : motion;
    if (batch && !batchDirty && (distant || motion === "idle") &&
        stance === previousStance && head.rotation.x === previousPitch) return;
    previousStance = stance;
    previousPitch = head.rotation.x;
    const airborne = !distant && (motion === "glide" || motion === "boost");
    const swing = !distant && (motion === "walk" || motion === "run") && Number.isFinite(time) ?
      Math.sin(time * (motion === "run" ? 14 : 9)) * (motion === "run" ? .75 : .35) : 0;
    body.rotation.x = airborne ? -1.05 : 0;
    leftLeg.rotation.x = rightArm.rotation.x = swing;
    rightLeg.rotation.x = leftArm.rotation.x = -swing;
    // Rotating a box around its centre can dip a corner below the foot plane.
    for(const leg of [leftLeg,rightLeg])leg.position.y=-.62+Math.max(0,.38*Math.abs(Math.cos(leg.rotation.x))+.135*Math.abs(Math.sin(leg.rotation.x))-.38);
    leftArm.rotation.z = airborne ? -.35 : 0; rightArm.rotation.z = airborne ? .35 : 0;
    wings.forEach(({hinge, inner, sign}) => {
      hinge.visible = !distant;
      hinge.rotation.z = airborne ? sign * .65 : 0;
      hinge.rotation.y = airborne ? sign * -.4 : 0;
      inner.visible = airborne;
      // The fan outline already opens outwards and aft; no 90-degree rotation
      // that would invert the leading/trailing edges from the supplied photo.
      inner.rotation.z = 0;
      inner.rotation.y = sign * (Number.isFinite(time) ? Math.sin(time * 22) * .08 : 0);
    });
    for (const flame of flames) flame.visible = !distant && motion === "boost";
    if (holding) rightArm.rotation.x = Math.PI / 3;
    if (batch) updateBatch();
    else group.updateMatrixWorld(true);
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    group.removeFromParent();
    batch?.dispose();
    for (const entry of geometries) entry.dispose();
    for (const entry of materials.values()) entry.dispose();
    group.visible = false;
  }
  function setColor(value) {
    if (!disposed && (typeof value === "number" || /^#[0-9a-f]{6}$/i.test(value))) {
      torso.material.color.set(value);
      batchDirty = true;
    }
  }
  return { group, hand, update, setHolding, setColor, setIdentity, dispose,
    getState: () => ({ position: group.position.toArray(), yaw: group.rotation.y,
      pitch: head.rotation.x, visible: group.visible, disposed, holding, animation: motion,
      wingsOpen: motion === "glide" || motion === "boost", boosting: motion === "boost",
      meshCount: batch ? 21 - cubes.length : 20, lineCount: 2, geometryCount: geometries.size, materialCount: materials.size, appearance: { ...appearance } }) };
}
