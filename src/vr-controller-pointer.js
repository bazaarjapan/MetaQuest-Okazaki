export const vrControllerPointerStyle = Object.freeze({
  colors: Object.freeze({ left: "#6fe7ff", right: "#ffce75" }),
  blocked: "#909ca7", success: "#a8ffd7", noHitDistance: 3,
  beamRadius: .0025, ringRadius: .012, ringThickness: .0018,
  dotRadius: .003, flashMs: 180,
});

const finiteVector = value => value && Number.isFinite(value.x) &&
  Number.isFinite(value.y) && Number.isFinite(value.z);

// Pointer geometry is created once. All coordinates below are world-space, so
// a transformed parent cannot enlarge the beam or shift the actual ray target.
export function createVRControllerPointer(THREE, { parent, handedness } = {}) {
  const color = vrControllerPointerStyle.colors[handedness];
  if (!color || !parent?.add) throw new TypeError("A left/right pointer parent is required");
  const group = new THREE.Group();
  group.name = `vr-controller-pointer-${handedness}`;
  group.visible = false; parent.add(group);
  const material = value => new THREE.MeshBasicMaterial({ color: value,
    transparent: true, opacity: .95, depthTest: false, depthWrite: false,
    toneMapped: false });
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(vrControllerPointerStyle.beamRadius,
    vrControllerPointerStyle.beamRadius, 1, 8, 1), material(color));
  const ring = new THREE.Mesh(new THREE.TorusGeometry(vrControllerPointerStyle.ringRadius,
    vrControllerPointerStyle.ringThickness, 6, 24), material(color));
  const dot = new THREE.Mesh(new THREE.SphereGeometry(vrControllerPointerStyle.dotRadius, 8, 6), material(color));
  for (const mesh of [beam, ring, dot]) {
    mesh.matrixAutoUpdate = false; mesh.frustumCulled = false;
    mesh.renderOrder = mesh === beam ? 1002 : 1003; group.add(mesh);
  }
  const unitY = new THREE.Vector3(0, 1, 0), unitZ = new THREE.Vector3(0, 0, 1);
  const origin = new THREE.Vector3(), direction = new THREE.Vector3(), end = new THREE.Vector3();
  const midpoint = new THREE.Vector3(), offset = new THREE.Vector3(), normal = new THREE.Vector3();
  const scale = new THREE.Vector3(1, 1, 1), beamOrientation = new THREE.Quaternion(), targetOrientation = new THREE.Quaternion();
  const inverse = new THREE.Matrix4(), world = new THREE.Matrix4();
  let disposed = false, visible = false, reticleVisible = false, target = null;
  let distance = 0, blocked = false, pressed = false, flashUntil = 0, shownColor = color;
  function hide() {
    visible = reticleVisible = blocked = pressed = false; target = null; distance = 0;
    flashUntil = 0; shownColor = color; group.visible = ring.visible = dot.visible = false;
    return false;
  }
  function place(mesh, position, orientation, size) {
    world.compose(position, orientation, size);
    mesh.matrix.multiplyMatrices(inverse, world); mesh.matrixWorldNeedsUpdate = true;
  }
  function update({ enabled = false, origin: nextOrigin, direction: nextDirection,
    hit = null, pressed: nextPressed = false, time = 0 } = {}) {
    if (disposed || !enabled || !finiteVector(nextOrigin) || !finiteVector(nextDirection) ||
      !Number.isFinite(time)) return hide();
    origin.copy(nextOrigin); direction.copy(nextDirection);
    const magnitude = direction.lengthSq();
    if (!Number.isFinite(magnitude) || magnitude < 1e-12) return hide();
    direction.normalize();
    distance = vrControllerPointerStyle.noHitDistance; target = null; blocked = false;
    reticleVisible = Boolean(hit);
    if (hit) {
      if (!finiteVector(hit.point)) return hide();
      offset.copy(hit.point).sub(origin);
      distance = offset.dot(direction);
      // Only an intersection of this exact physical ray can receive a reticle.
      if (!Number.isFinite(distance) || distance <= 1e-6 ||
        offset.addScaledVector(direction, -distance).lengthSq() > Math.max(1e-8, distance * distance * 1e-10)) return hide();
      target = typeof hit.action === "string" && hit.action.length ? hit.action : null;
      blocked = !target;
      end.copy(hit.point);
    } else end.copy(origin).addScaledVector(direction, distance);
    group.updateWorldMatrix(true, false);
    const determinant = group.matrixWorld.determinant();
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return hide();
    inverse.copy(group.matrixWorld).invert();
    midpoint.copy(origin).addScaledVector(direction, distance / 2);
    beamOrientation.setFromUnitVectors(unitY, direction); scale.set(1, distance, 1);
    place(beam, midpoint, beamOrientation, scale);
    normal.copy(direction).negate(); targetOrientation.setFromUnitVectors(unitZ, normal);
    scale.set(1, 1, 1); place(ring, end, targetOrientation, scale); place(dot, end, targetOrientation, scale);
    shownColor = blocked ? vrControllerPointerStyle.blocked :
      time < flashUntil ? vrControllerPointerStyle.success : color;
    beam.material.color.set(color); ring.material.color.set(shownColor); dot.material.color.set(shownColor);
    visible = true; pressed = Boolean(nextPressed); group.visible = true;
    ring.visible = dot.visible = reticleVisible;
    return true;
  }
  return { group, beam, ring, dot, update, hide,
    flash(time) {
      if (disposed || !visible || !Number.isFinite(time)) return false;
      flashUntil = time + vrControllerPointerStyle.flashMs; return true;
    },
    getState() {
      return { handedness, visible, target, reticleVisible, distance, color: shownColor,
        beamColor: color, blocked, pressed,
        origin: visible ? origin.toArray() : null, end: visible ? end.toArray() : null,
        rayOrigin: visible ? origin.toArray() : null, rayDirection: visible ? direction.toArray() : null,
        hitPoint: visible && reticleVisible ? end.toArray() : null,
        beamWidth: vrControllerPointerStyle.beamRadius * 2 };
    },
    dispose() {
      if (disposed) return;
      disposed = true; hide(); group.removeFromParent();
      for (const mesh of [beam, ring, dot]) { mesh.geometry.dispose(); mesh.material.dispose(); }
    } };
}
