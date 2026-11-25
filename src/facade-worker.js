import { prepareBuildingGeometry } from './facade-geometry.js';

self.onmessage = ({data: {attributes, indices}}) => {
  try {
    const prepared = prepareBuildingGeometry(attributes, indices);
    const arrays = [prepared.colors, prepared.spans, prepared.design, prepared.indices,
      ...Object.values(prepared.vertices ?? {})];
    self.postMessage({prepared}, arrays.filter(Boolean).map(array => array.buffer));
  } catch (error) {
    self.postMessage({error: error.message});
  }
};
