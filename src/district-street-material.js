import { stationDistrictHalfWidth } from "./station-district.js";

export const railProfile = Object.freeze({ halfGauge: 1.067 / 2, width: .15, centerHeight: .175 });

// Decorations follow the surveyed street directions. All dimensions are metres.
// The square and the camera distance fade to the existing city materials.
export function applyDistrictStreetFinish(shader, layer, station, strength) {
  if (layer > 4) return;
  shader.vertexShader = "attribute vec3 streetMeasure; varying vec3 vStreetMeasure;\n" + shader.vertexShader;
  shader.vertexShader = shader.vertexShader.replace("#include <begin_vertex>",
    "#include <begin_vertex>\nvStreetMeasure = streetMeasure;");
  shader.fragmentShader = "varying vec3 vStreetMeasure;\n" + shader.fragmentShader;
  if (layer === 3) {
    // Centred on the line in metres. Fade before the closely spaced sleepers
    // alias. One draped strip replaces the individual projected rectangles.
    shader.fragmentShader = shader.fragmentShader.replace("#include <color_fragment>", `#include <color_fragment>
      float footprint = max(0.006, fwidth(vStreetMeasure.x));
      float tie = abs(fract(vStreetMeasure.x / 0.67 + 0.5) - 0.5) * 0.67;
      diffuseColor.a *= (1.0 - smoothstep(0.115, 0.115 + footprint, tie))
                      * (1.0 - smoothstep(0.13, 0.40, footprint));
      diffuseColor.rgb *= mix(1.03, 0.76, smoothstep(0.86, 1.18, abs(vStreetMeasure.y)));
    `);
    return;
  }
  if (layer === 4) {
    shader.fragmentShader = shader.fragmentShader.replace("#include <color_fragment>", `#include <color_fragment>
      float tread = abs(abs(vStreetMeasure.y) - ${railProfile.halfGauge});
      float polished = 1.0 - smoothstep(0.042, 0.064, tread);
      diffuseColor.rgb = mix(diffuseColor.rgb * vec3(0.45, 0.38, 0.31), diffuseColor.rgb, polished);
    `);
    return;
  }
  shader.uniforms.districtStation = station;
  shader.uniforms.districtStreetStrength = strength;
  let finish;
  if (layer === 0) {
    finish = `
      float along = vStreetMeasure.x;
      float shoulder = abs(vStreetMeasure.y) - vStreetMeasure.z;
      float aa = max(fwidth(along), 0.012);
      float sideAA = max(fwidth(shoulder), 0.012);
      float joint = 1.0 - smoothstep(0.012, 0.012 + aa, abs(mod(along + 0.9, 1.8) - 0.9));
      float gutter = 1.0 - smoothstep(0.28, 0.28 + sideAA, shoulder);
      float edge = 1.0 - smoothstep(0.018, 0.018 + sideAA, abs(shoulder - 0.30));
      float curb = smoothstep(0.30, 0.42, shoulder) * (1.0 - smoothstep(0.55, 0.64, shoulder));
      float grate = (1.0 - smoothstep(0.25, 0.25 + aa, abs(mod(along + 4.5, 9.0) - 4.5)))
                  * smoothstep(0.03, 0.03 + sideAA, shoulder) * gutter;
      float slats = smoothstep(0.18, 0.8, cos(along * 105.0)) * (1.0 - smoothstep(0.02, 0.055, aa));
      vec3 concrete = diffuseColor.rgb * mix(1.06 + curb * 0.18, 0.69, gutter) * (1.0 - 0.21 * joint - 0.28 * edge);
      vec3 finishColor = mix(concrete, vec3(0.095, 0.114, 0.115) * (1.0 - 0.58 * slats), grate);`;
  } else {
    const ballast = layer === 2;
    finish = `
      vec2 grainPoint = mat2(0.8, -0.6, 0.6, 0.8) * vStreetWorld.xz * ${ballast ? "9.0" : "29.0"};
      float grain = districtStone(grainPoint);
      float resolved = 1.0 - smoothstep(0.2, 1.0, max(fwidth(grainPoint.x), fwidth(grainPoint.y)));
      float across = abs(vStreetMeasure.y);
      ${ballast ? `
      float shoulder = smoothstep(1.02, 2.15, across);
      float fine = (grain - 0.5) * resolved * 0.62;
      vec3 finishColor = diffuseColor.rgb * (1.10 - 0.24 * shoulder + fine);
      ` : `
      float lane = abs(across - max(0.8, vStreetMeasure.z * 0.51));
      float worn = 1.0 - smoothstep(0.19, 0.64, lane);
      float edge = smoothstep(0.57, 0.95, across / max(vStreetMeasure.z, 1.0));
      float repairs = districtStone(vStreetWorld.xz * 0.36);
      vec3 finishColor = diffuseColor.rgb * (1.0 + worn * 0.095 - edge * 0.10
        + (repairs - 0.5) * 0.07 + (grain - 0.5) * resolved * 0.17);
      `}`;
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
    float nearby = 1.0 - smoothstep(39.0, 103.0, distance(vStreetWorld, streetCenter));
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
