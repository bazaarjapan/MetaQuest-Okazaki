import * as THREE from "three";

export function captureView(camera) {
  camera.updateWorldMatrix(true, false);
  return {
    position: camera.getWorldPosition(new THREE.Vector3()).toArray(),
    quaternion: camera.getWorldQuaternion(new THREE.Quaternion()).toArray(),
  };
}

export function captureXRView(rig, transform) {
  // Use the physical viewer centre for both save and resume. The renderer's
  // stereo-union camera can have a frustum offset and must not accumulate it.
  rig.updateWorldMatrix(true, false);
  const position = new THREE.Vector3(transform.position.x, transform.position.y, transform.position.z);
  const orientation = new THREE.Quaternion(transform.orientation.x,
    transform.orientation.y, transform.orientation.z, transform.orientation.w);
  return {
    position: rig.localToWorld(position).toArray(),
    quaternion: rig.getWorldQuaternion(new THREE.Quaternion()).multiply(orientation).toArray(),
  };
}

// Correct yaw and translation only. Never rotate the physical world in pitch
// or roll to force a previously saved head tilt onto a returning VR wearer.
export function alignRigToView(rig, view, transform) {
  const localPosition = new THREE.Vector3(transform.position.x, transform.position.y, transform.position.z);
  const localOrientation = new THREE.Quaternion(transform.orientation.x,
    transform.orientation.y, transform.orientation.z, transform.orientation.w);
  const desiredOrientation = new THREE.Quaternion().fromArray(view.quaternion);
  const localYaw = new THREE.Euler().setFromQuaternion(localOrientation, "YXZ").y;
  const desiredYaw = new THREE.Euler().setFromQuaternion(desiredOrientation, "YXZ").y;
  rig.rotation.set(0, desiredYaw - localYaw, 0);
  rig.position.fromArray(view.position).sub(localPosition.applyQuaternion(rig.quaternion));
  rig.updateMatrixWorld(true);
}
