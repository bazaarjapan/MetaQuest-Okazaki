import { attachCitySurfaceShader } from './city-surface-map.js';
import { prepareBuildingGeometry } from './facade-geometry.js';
import { facadeDeclarations, facadeFragment, neutralFacadeUniforms } from './facade-material.js';

export const FIELD_STYLE_KEY = 'okazaki-field-style-v1';
// The station export consists of building material groups plus one terrain
// atlas. A material group is not a building-size or texture-presence test.
export function isCoreBuildingPart(part) {
  return part.texture !== 'Texture-001.png';
}
export function gameTerrainFile(manifest,quality) {
  return '../field/'+(manifest.profiles?.[quality]?.file??manifest.core.file);
}
export function readFieldStyle(storage) {
  try { return storage?.getItem(FIELD_STYLE_KEY)==='photo'?'photo':'game'; } catch { return 'game'; }
}
export { buildingAttributes, buildingColorBytes } from './facade-geometry.js';

export function buildingGeometryData(geometry, copy = false) {
  const attributes = Object.fromEntries(Object.entries(geometry.attributes).map(([name, {array, itemSize}]) =>
    [name, {array: copy ? array.slice() : array, itemSize}]));
  const index = geometry.index?.array;
  return {attributes, indices: copy ? index?.slice() : index};
}

export function applyBuildingGeometry(THREE, geometry, {vertices, indices, colors, spans, design}) {
  if (vertices) {
    for (const [name, array] of Object.entries(vertices)) {
      const {itemSize, normalized} = geometry.attributes[name];
      geometry.setAttribute(name, new THREE.BufferAttribute(array, itemSize, normalized));
    }
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  }
  geometry.setAttribute('fieldColor', new THREE.BufferAttribute(colors, 3, true));
  geometry.setAttribute('fieldSpan', new THREE.BufferAttribute(spans, 2));
  geometry.setAttribute('fieldFacade', new THREE.BufferAttribute(design, 4));
}

export function decorateBuildingGeometry(THREE, geometry) {
  const {attributes, indices} = buildingGeometryData(geometry);
  applyBuildingGeometry(THREE, geometry, prepareBuildingGeometry(attributes, indices));
}
export function createFieldBuildingMaterial(THREE, uniform, options = {}) {
  const { eveningUniform = {value: 0}, citySurfaceUniforms = null,
    facadeUniforms = neutralFacadeUniforms, ...materialOptions } = options;
  const material = new THREE.MeshStandardMaterial({roughness: 1, metalness: 0, ...materialOptions});
  material.userData ??= {};
  material.userData.fieldBuilding = true;
  material.onBeforeCompile = shader => {
    if (citySurfaceUniforms) attachCitySurfaceShader(shader, citySurfaceUniforms);
    Object.assign(shader.uniforms, facadeUniforms, {fieldGame: uniform, fieldEvening: eveningUniform});
    const varyings = `
      varying vec2 vFieldSpan;
      varying vec3 vFieldColor, vFieldPosition, vFieldNormal;
      varying vec4 vFieldFacade;
    `;
    shader.vertexShader = 'attribute vec3 fieldColor; attribute vec2 fieldSpan; attribute vec4 fieldFacade;\n' +
      varyings + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      vFieldColor=fieldColor;
      vFieldFacade=fieldFacade;
      vFieldPosition=(modelMatrix*vec4(position,1.0)).xyz;
      vFieldNormal=normalize(mat3(modelMatrix)*normal);
      vFieldSpan=vec2((modelMatrix*vec4(position.x,fieldSpan.x,position.z,1.0)).y,
        (modelMatrix*vec4(position.x,fieldSpan.y,position.z,1.0)).y);
    `);
    shader.fragmentShader = 'uniform float fieldGame; uniform float fieldEvening;\n' + varyings +
      facadeDeclarations + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `if(fieldGame<.5){
      #include <map_fragment>
    }`);
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
      float facadeRoughness = roughness;
      if(fieldGame>.5){${facadeFragment(Boolean(citySurfaceUniforms))}}
    `);
    shader.fragmentShader = shader.fragmentShader.replace('#include <roughnessmap_fragment>',
      '#include <roughnessmap_fragment>\nif (fieldGame>.5) roughnessFactor = facadeRoughness;');
  };
  material.customProgramCacheKey = () => 'okazaki-facade-atlas-v1' + (citySurfaceUniforms ? '-grounded' : '');
  return material;
}
