import { BufferAttribute, Color } from 'three';

// The authored v2 tiles include original roof/terrace submeshes and older
// ground-floor bands in one primitive. Finish classes 1–3 identify roof skins.
// These remaining plain colors are the five roof-only pieces in the Blender
// export: gable ends, coping sides/tops and rooftop equipment sides/tops.
const roofTrim = [0x69716e, 0x606f74, 0xb4bfba, 0xc9ccc0, 0x82918d].map(hex => new Color(hex));

export function keepDistrictRoofs(model) {
  model.traverse(mesh => {
    if (!mesh.isMesh) return;
    const geometry = mesh.geometry, finish = geometry.getAttribute('uv'), paint = geometry.getAttribute('color');
    if (!finish || !paint || !geometry.index) throw Error('Missing authored roof attributes');
    const source = geometry.index.array, selected = new source.constructor(source.length);
    let count = 0;
    for (let triangle = 0; triangle < source.length; triangle += 3) {
      const vertex = source[triangle], kind = Math.floor(finish.getX(vertex) * 6);
      const partOfRoof = kind >= 1 && kind <= 3 || (kind === 0 && roofTrim.some(color =>
        Math.abs(color.r - paint.getX(vertex)) < .0035 && Math.abs(color.g - paint.getY(vertex)) < .0035 &&
        Math.abs(color.b - paint.getZ(vertex)) < .0035));
      if (partOfRoof) { selected.set(source.subarray(triangle, triangle + 3), count); count += 3; }
    }
    geometry.setIndex(new BufferAttribute(selected.slice(0, count), 1));
  });
  return model;
}
