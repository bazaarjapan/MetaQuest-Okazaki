import { Box3 } from "three";
import { sharedObjectOverlap } from "./workshop-access.js";

// The Blender scene uses metres relative to manifest.station in the same axes
// as the city. Keep it outside the PLATEAU meshes used for ground and placement.
export function createStationLandmark(scene, loadModel) {
  let enabled = false;
  let model = null;
  let status = "idle";
  let meshes = 0;
  let clock = null;
  let clockBounds = null;
  let works = [];

  function updateClockVisibility() {
    if (clock) clock.visible = !works.some(work => sharedObjectOverlap(clockBounds, work));
  }

  async function update(position, show) {
    enabled = show;
    if (model) model.visible = enabled;
    if (!enabled || model || status === "loading" || !position) return;

    status = "loading";
    try {
      const loaded = await loadModel();
      loaded.position.fromArray(position);
      loaded.visible = enabled;
      clock = loaded.getObjectByName("EastPlazaClock");
      if (clock) {
        loaded.updateWorldMatrix(true, true);
        const bounds = new Box3().setFromObject(clock);
        clockBounds = {min: bounds.min.toArray(), max: bounds.max.toArray()};
        updateClockVisibility();
      }
      loaded.traverse(child => {
        if (child.isMesh) meshes++;
      });
      scene.add(loaded);
      model = loaded;
      status = "ready";
    } catch {
      // The city is usable immediately. Selecting game style again retries.
      status = "unavailable";
    }
  }

  return {
    update,
    setWorks(objects) {
      if (objects === works) return;
      works = objects;
      updateClockVisibility();
    },
    getState: () => ({
      status, visible: model?.visible ?? false, meshes, position: model?.position.toArray() ?? null,
      clockVisible: Boolean(model?.visible && clock?.visible),
    }),
  };
}
