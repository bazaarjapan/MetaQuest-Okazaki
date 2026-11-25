import { stationDistrictHalfWidth } from "./station-district.js";

// Decorations follow the surveyed street directions. All dimensions are metres.
// The square and the camera distance fade to the existing city materials.
export function applyDistrictStreetFinish(shader, layer, station, strength) {
  if (layer > 2) return;
  shader.uniforms.districtStation = station;
  shader.uniforms.districtStreetStrength = strength;
  let finish;
  if (layer === 0) {
    shader.vertexShader = "attribute vec3 streetMeasure; varying vec3 vStreetMeasure;\n" + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace("#include <begin_vertex>",
      "#include <begin_vertex>\nvStreetMeasure = streetMeasure;");
    shader.fragmentShader = "varying vec3 vStreetMeasure;\n" + shader.fragmentShader;
    finish = `
      float along = vStreetMeasure.x;
      float shoulder = abs(vStreetMeasure.y) - vStreetMeasure.z;
      float aa = max(fwidth(along), 0.012);
      float sideAA = max(fwidth(shoulder), 0.012);
      float joint = 1.0 - smoothstep(0.012, 0.012 + aa, abs(mod(along + 0.9, 1.8) - 0.9));
      float gutter = 1.0 - smoothstep(0.24, 0.24 + sideAA, shoulder);
      float edge = 1.0 - smoothstep(0.012, 0.012 + sideAA, abs(shoulder - 0.24));
      float grate = (1.0 - smoothstep(0.27, 0.27 + aa, abs(mod(along + 9.0, 18.0) - 9.0)))
                  * smoothstep(0.03, 0.03 + sideAA, shoulder) * gutter;
      float slats = smoothstep(0.18, 0.8, cos(along * 105.0)) * (1.0 - smoothstep(0.02, 0.055, aa));
      vec3 concrete = diffuseColor.rgb * mix(1.02, 0.76, gutter) * (1.0 - 0.21 * joint - 0.28 * edge);
      vec3 finishColor = mix(concrete, vec3(0.095, 0.114, 0.115) * (1.0 - 0.58 * slats), grate);`;
  } else {
    const ballast = layer === 2;
    finish = `
      vec2 grainPoint = mat2(0.8, -0.6, 0.6, 0.8) * vStreetWorld.xz * ${ballast ? "15.0" : "32.0"};
      float grain = districtStone(grainPoint);
      float resolved = 1.0 - smoothstep(0.2, 1.0, max(fwidth(grainPoint.x), fwidth(grainPoint.y)));
      vec3 finishColor = diffuseColor.rgb * (1.0 + (grain - 0.5) * resolved * ${ballast ? "0.55" : "0.13"});`;
  }
  shader.fragmentShader = `
    uniform vec2 districtStation;
    uniform float districtStreetStrength;
    float districtGrain(vec2 cell) {
      vec3 p = fract(vec3(cell.xyx) * 0.1031);
      p += dot(p, p.yzx + 33.33);
      return fract((p.x + p.y) * p.z);
    }
    float districtStone(vec2 point) {
      vec2 cell = floor(point), uv = fract(point);
      uv = smoothstep(vec2(0.12), vec2(0.88), uv);
      float a = mix(districtGrain(cell), districtGrain(cell + vec2(1,0)), uv.x);
      float b = mix(districtGrain(cell + vec2(0,1)), districtGrain(cell + vec2(1,1)), uv.x);
      return mix(a, b, uv.y);
    }
  ` + shader.fragmentShader;
  shader.fragmentShader = shader.fragmentShader.replace("#include <color_fragment>", `#include <color_fragment>
    vec2 stationOffset = abs(vStreetWorld.xz - districtStation);
    float inside = 1.0 - smoothstep(${stationDistrictHalfWidth - 4}.0, ${stationDistrictHalfWidth}.0, max(stationOffset.x, stationOffset.y));
    float nearby = 1.0 - smoothstep(45.0, 85.0, length(vStreetWorld.xz - streetCenter.xz));
    float districtMix = inside * nearby * districtStreetStrength;
    if (districtMix > 0.0) {
      ${finish}
      diffuseColor.rgb = mix(diffuseColor.rgb, finishColor, districtMix);
    }
  `);
}

export function appendRoadMeasures(output, positions, segment) {
  const {a, b, width, along, length} = segment;
  const dx = (b[0] - a[0]) / length, dz = (b[1] - a[1]) / length;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i] - a[0], z = positions[i + 2] - a[1];
    output.push(along + x * dx + z * dz, x * dz - z * dx, width / 2);
  }
}
