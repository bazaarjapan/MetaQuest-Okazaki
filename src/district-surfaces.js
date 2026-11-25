import { LinearFilter, LinearMipmapLinearFilter, MeshStandardMaterial, RepeatWrapping, Texture } from "three";

// The UV layer stores (surface class + 0.5) / 6 and the building's roof or wall
// bearing. All dimensions below are metres. No per-building texture or material.
export function createDistrictSurfaceMaterial(image) {
  const texture = new Texture(image);
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  const material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.88 });
  material.name = "Okazaki building finishes";
  material.onBeforeCompile = shader => {
    shader.uniforms.districtWeathering = { value: texture };
    shader.vertexShader = `
      varying vec3 vDistrictPoint;
      varying vec3 vDistrictFacing;
      varying vec3 vDistrictSurface;
    ` + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace("#include <begin_vertex>", `#include <begin_vertex>
      vDistrictPoint = (modelMatrix * vec4(position, 1.0)).xyz;
      vDistrictFacing = normalize(mat3(modelMatrix) * normal);
      float finish = floor(uv.x * 6.0);
      float bearing = (1.0 - uv.y) * 6.28318531;
      vec2 along = vec2(cos(bearing), sin(bearing));
      float u = dot(vDistrictPoint.xz, along);
      float v = finish < 3.5 ? dot(vDistrictPoint.xz, vec2(-along.y, along.x)) : vDistrictPoint.y;
      vDistrictSurface = vec3(u, v, finish);
    `);
    shader.fragmentShader = `
      uniform sampler2D districtWeathering;
      varying vec3 vDistrictPoint;
      varying vec3 vDistrictFacing;
      varying vec3 vDistrictSurface;

      float districtJoint(float coordinate, float footprint, float width) {
        float d = abs(fract(coordinate + 0.5) - 0.5);
        return (1.0 - smoothstep(width, width + max(0.003, footprint), d))
             * (1.0 - smoothstep(0.10, 0.44, footprint));
      }
    ` + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace("#include <color_fragment>", `#include <color_fragment>
      float districtRoughness = 0.88;
      vec2 p = vDistrictSurface.xy;
      vec2 dx = dFdx(p);
      vec2 dy = dFdy(p);
      vec2 px = abs(dx) + abs(dy);
      float kind = vDistrictSurface.z;
      float near = 1.0 - smoothstep(35.0, 105.0, distance(vDistrictPoint, cameraPosition));
      if (kind > 0.5 && near > 0.0) {
        float repeats = kind < 1.5 ? 0.222 : kind < 2.5 ? 0.167 : kind < 3.5 ? 0.125 : 0.20;
        vec4 weather = textureGrad(districtWeathering, p * repeats, dx * repeats, dy * repeats);
        float grain = (weather.g - 0.5) * (1.0 - smoothstep(0.018, 0.07, max(px.x, px.y)));
        float tone = 1.0 + (weather.r - 0.5) * 0.18 + grain * 0.08;
        float rough = 0.88 + (weather.b - 0.5) * 0.10;
        if (kind < 1.5) {
          vec2 tile = p / 0.30;
          float shift = 0.5 * mod(floor(tile.y), 2.0);
          float grout = districtJoint(tile.y, px.y / 0.30, 0.065);
          float ribs = districtJoint(tile.x + shift, px.x / 0.30, 0.025);
          tone += 0.12 * cos(tile.x * 6.283 + shift * 3.142) * (1.0 - smoothstep(0.06, 0.26, px.x));
          tone -= 0.28 * grout + 0.18 * ribs;
          rough = 0.59 + (weather.b - 0.5) * 0.14;
        } else if (kind < 2.5) {
          float seam = districtJoint(p.x / 0.42, px.x / 0.42, 0.030);
          float rim = districtJoint(p.x / 0.42 - 0.095, px.x / 0.42, 0.035);
          tone += 0.22 * rim - 0.26 * seam + 0.11 * (weather.a - 0.6);
          rough = 0.48 + (weather.b - 0.5) * 0.14;
        } else if (kind < 3.5) {
          float lap = max(districtJoint(p.x / 1.5, px.x / 1.5, 0.012),
                          districtJoint(p.y / 1.5, px.y / 1.5, 0.012));
          tone -= 0.16 * lap;
        } else if (kind < 4.5) {
          float siding = districtJoint(p.y / 0.60, px.y / 0.60, 0.019);
          float join = districtJoint(p.x / 1.80 + 0.5 * mod(floor(p.y / 0.60), 2.0), px.x / 1.80, 0.008);
          tone += 0.12 * (weather.a - 0.63) - 0.11 * siding - 0.065 * join;
        } else {
          vec3 toEye = normalize(cameraPosition - vDistrictPoint);
          float sky = 1.0 - smoothstep(0.12, 0.88, abs(dot(normalize(vDistrictFacing), toEye)));
          float mullion = districtJoint(p.x / 1.75, px.x / 1.75, 0.021);
          tone = 0.83 + weather.b * 0.31 + sky * 0.34 - mullion * 0.33;
          diffuseColor.rgb += vec3(0.026, 0.042, 0.057) * sky * near;
          rough = 0.25 + weather.b * 0.15;
        }
        diffuseColor.rgb *= mix(1.0, tone, near);
        districtRoughness = mix(0.88, rough, near);
      }
    `);
    shader.fragmentShader = shader.fragmentShader.replace("#include <roughnessmap_fragment>",
      "#include <roughnessmap_fragment>\nroughnessFactor = districtRoughness;");
  };
  material.customProgramCacheKey = () => "district-surfaces-v2";
  return material;
}
