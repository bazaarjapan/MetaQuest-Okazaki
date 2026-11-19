import { stlFinish, stlFinishes, stlSurface } from "./stl-appearance.js";

// STL files have no texture coordinates. Project the pattern in model space so
// the same finish follows the original shape in the world and in a player's hand.
const modes = Object.fromEntries(stlFinishes.map((finish, index) => [finish, index]));
const masks = { all: 0, walls: 1, roof: 2 };
const states = new WeakMap();
const varying = "varying vec3 vStlGrid;\nvarying vec3 vStlNormal;";
const patternFunctions = /* glsl */ `
float stlNoise(vec2 id) {
  vec3 p = fract(vec3(id.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}
float stlLine(float distanceToLine, float width, float pixel) {
  return 1.0 - smoothstep(width - min(width, pixel * 0.5), width + pixel * 0.5, distanceToLine);
}
vec3 stlJewel(float seed) {
  if (seed < 0.25) return vec3(0.025, 0.45, 0.63);
  if (seed < 0.50) return vec3(0.42, 0.065, 0.32);
  if (seed < 0.75) return vec3(0.83, 0.35, 0.048);
  return vec3(0.115, 0.56, 0.38);
}`;
const fragment = /* glsl */ `
vec3 faceNormal = normalize(vStlNormal);
vec3 axis = abs(faceNormal);
bool stlEnabled = stlMask == 0 || (stlMask == 1 && axis.y < 0.55) || (stlMask == 2 && faceNormal.y >= 0.55);
vec2 uvStl = axis.y >= max(axis.x, axis.z) ? vStlGrid.xz : (axis.x > axis.z ? vStlGrid.zy : vStlGrid.xy);
vec2 aa = clamp(fwidth(uvStl), 0.001, 0.4);
float detail = 1.0 - smoothstep(0.18, 0.7, max(aa.x, aa.y) * 1.75);
vec2 cell = fract(uvStl);
vec3 stlEmission = vec3(0.0);
if (stlEnabled) {
  if (stlMode == 1) {
    // Recessed window pairs, a dividing mullion, and a narrow reflecting edge.
    vec2 pane = abs(cell - 0.5);
    vec2 edge = 1.0 - smoothstep(vec2(0.39, 0.31) - aa * 0.5, vec2(0.39, 0.31) + aa * 0.5, pane);
    float glass = edge.x * edge.y * smoothstep(0.018, 0.018 + aa.x, pane.x);
    vec3 glazing = mix(vec3(0.045, 0.105, 0.15), vec3(0.28, 0.50, 0.59), cell.y);
    glazing += 0.06 * smoothstep(0.68, 0.78, cell.x * 0.6 + cell.y);
    diffuseColor.rgb = mix(diffuseColor.rgb, glazing, mix(0.36, glass, detail));
  } else if (stlMode == 2) {
    // Open panels with horizontal beams, uprights and crossed steel braces.
    vec2 beam = min(cell, 1.0 - cell);
    float diagonal = min(abs(cell.x - cell.y), abs(cell.x + cell.y - 1.0));
    float steel = min(min(beam.x, beam.y), diagonal * 0.7071);
    if (steel > mix(0.50, 0.055, detail)) discard;
    diffuseColor.rgb *= mix(0.77, 1.12, smoothstep(0.0, 0.055, steel) * detail);
  } else if (stlMode == 3) {
    float grainDetail = 1.0 - smoothstep(0.018, 0.075, aa.y);
    float grain = sin(uvStl.y * 71.0 + 0.8*sin(uvStl.x)) * grainDetail;
    // A broad polished reflection survives downsampling; fine brush marks resolve up close.
    float sweep = fract(uvStl.x * 0.22 + uvStl.y * 0.105 + 0.13);
    float shine = exp(-75.0 * (sweep-0.49) * (sweep-0.49));
    float glint = stlLine(abs(sweep-0.66), 0.018, 0.22*aa.x + 0.105*aa.y);
    vec3 alloy = mix(diffuseColor.rgb, vec3(0.43,0.51,0.55), 0.42);
    diffuseColor.rgb = alloy * (0.68 + 0.23 * cos(6.2831853*sweep) + 0.085*grain)
      + (0.65*shine + 0.21*glint) * mix(vec3(0.73,0.85,0.91),alloy,0.28);
  } else if (stlMode == 4) {
    vec2 tile = uvStl * vec2(1.5, 3.0);
    tile.x += 0.5 * mod(floor(tile.y), 2.0);
    vec2 jointDistance = 0.5 - abs(fract(tile) - 0.5);
    vec2 joint = 1.0 - smoothstep(vec2(0.025, 0.05), vec2(0.025, 0.05) + aa * vec2(1.5, 3.0), jointDistance);
    float shade = 0.88 + 0.12 * fract(dot(floor(tile), vec2(0.372, 0.631)));
    vec3 brick = diffuseColor.rgb * mix(0.94, shade, detail);
    diffuseColor.rgb = mix(brick, mix(brick, vec3(0.69, 0.64, 0.53), 0.64), mix(0.14, max(joint.x, joint.y), detail));
  } else if (stlMode == 5) { // Wood: growth rings bend around elliptical knots.
    vec2 woodUV = uvStl * vec2(0.30, 0.43);
    vec2 board = floor(woodUV);
    vec2 knot = fract(woodUV) - vec2(0.37 + 0.24*stlNoise(board), 0.50);
    float oval = length(knot * vec2(0.94,1.87));
    float knotArea = 1.0-smoothstep(0.13,0.37,oval);
    float warp = exp(-3.9 * oval) * 2.4 + 0.23*sin(woodUV.x*4.6 + 0.8*sin(woodUV.y*2.0));
    float layer = woodUV.y*5.0 + warp;
    float grain = smoothstep(-0.24,0.90,cos(6.2831853*layer));
    float rings = 0.5+0.5*cos(oval*68.0);
    float pigment = mix(grain, rings, knotArea);
    float heart = 1.0-smoothstep(0.025,0.085,oval);
    vec3 earlywood = mix(vec3(0.72,0.39,0.15),diffuseColor.rgb,0.30);
    vec3 latewood = mix(vec3(0.21,0.074,0.025),diffuseColor.rgb*0.42,0.35);
    diffuseColor.rgb = mix(earlywood, latewood, mix(0.38, min(1.0,0.73*pigment + 0.58*heart), detail));
  } else if (stlMode == 6) { // Barrel tiles with curved ridges and a shadow at each overlapping course.
    vec2 tile = uvStl * vec2(2.0, 1.45);
    float row = floor(tile.y);
    float ridge = 0.5 + 0.5 * cos(6.2831853 * (tile.x + 0.12 * mod(row, 2.0)));
    float lipY = fract(tile.y + ridge * 0.10);
    float lip = stlLine(min(lipY, 1.0-lipY), 0.035, aa.y * 1.45);
    float shoulder = 0.5 + 0.5 * sin(6.2831853 * (tile.x + 0.12 * mod(row, 2.0)));
    float tileShade = 0.71 + 0.17 * ridge + 0.27 * shoulder - 0.43 * lip;
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.37, 0.18, 0.105), 0.28) * mix(0.91, tileShade, detail);
  } else if (stlMode == 7) { // Jewel-toned angular pieces meet at dark lead cames.
    vec2 warped = uvStl * 1.45 + 0.14 * sin(uvStl.yx * vec2(2.4, 2.9));
    vec2 facet = fract(warped);
    vec2 block = floor(warped);
    if (stlNoise(block) < 0.5) facet.x = 1.0 - facet.x;
    float seam = min(min(min(facet.x, 1.0-facet.x), min(facet.y, 1.0-facet.y)), abs(facet.x-facet.y) * 0.7071);
    float glassId = stlNoise(block + (facet.x < facet.y ? vec2(15.3, 9.0) : vec2(0.0)));
    vec3 glass = mix(stlJewel(glassId), diffuseColor.rgb, 0.32) * (0.79 + 0.33 * facet.y);
    float lead = stlLine(seam, 0.028, max(aa.x, aa.y) * 1.45);
    vec3 pane = mix(glass, vec3(0.032, 0.045, 0.052), lead);
    diffuseColor.rgb = mix(mix(diffuseColor.rgb, vec3(0.27, 0.30, 0.32), 0.5), pane, detail);
    stlEmission = glass * (0.12 * (1.0-lead) * detail);
  } else if (stlMode == 8) { // Offset ceramic tesserae, pale grout, individual glazes.
    vec2 tile = uvStl * 3.0;
    tile.x += 0.16 * mod(floor(tile.y), 2.0);
    vec2 local = fract(tile);
    float edge = min(min(local.x, 1.0-local.x), min(local.y, 1.0-local.y));
    float seed = stlNoise(floor(tile));
    vec3 glaze = mix(diffuseColor.rgb, stlJewel(seed), 0.38) * (0.74 + 0.40 * seed);
    float grout = stlLine(edge, 0.046, max(aa.x, aa.y) * 3.0);
    float visibleTiles = 1.0 - smoothstep(0.09, 0.26, max(aa.x, aa.y));
    diffuseColor.rgb = mix(mix(diffuseColor.rgb, vec3(0.42, 0.48, 0.44), 0.3),
      mix(glaze, vec3(0.68, 0.72, 0.65), grout), visibleTiles);
  } else if (stlMode == 9) { // True hexagonal cells, with a raised amber rim.
    vec2 p = uvStl * 2.05, period = vec2(1.0, 1.73205);
    vec2 h1 = mod(p, period) - period * 0.5;
    vec2 h2 = mod(p - period * 0.5, period) - period * 0.5;
    vec2 hex = dot(h1,h1) < dot(h2,h2) ? h1 : h2;
    float rim = 0.5 - max(abs(hex.x), dot(abs(hex), vec2(0.5,0.866025)));
    float pixel = max(aa.x, aa.y) * 2.05;
    float lip = stlLine(rim, 0.057, pixel);
    vec3 amber = mix(diffuseColor.rgb, vec3(0.85,0.46,0.084), 0.57);
    vec3 core = diffuseColor.rgb * (0.61 + hex.x * 0.22 + hex.y * 0.16);
    diffuseColor.rgb = mix(core, amber, mix(0.23, lip, detail));
  } else if (stlMode == 10) { // A two-colour racing flag.
    vec2 flag = sin(3.14159265 * uvStl * 1.6);
    vec2 pixel = aa * 4.0;
    vec2 squares = smoothstep(-pixel, pixel, flag);
    float alternate = squares.x + squares.y - 2.0 * squares.x * squares.y;
    vec3 ink = diffuseColor.rgb * 0.52;
    diffuseColor.rgb = mix(ink, mix(vec3(0.89, 0.91, 0.83), diffuseColor.rgb, 0.14), mix(0.5, alternate, detail));
  } else if (stlMode == 11) { // Wide diagonal ribbons separated by a narrow peppermint stripe.
    float ribbon = fract((uvStl.x + uvStl.y * 0.72) * 1.45);
    float pixel = (aa.x + aa.y * 0.72) * 1.45;
    float strip = stlLine(abs(ribbon - 0.28), 0.19, pixel);
    float pin = stlLine(abs(ribbon - 0.665), 0.036, pixel);
    vec3 cream = mix(vec3(0.96, 0.88, 0.76), diffuseColor.rgb, 0.13);
    vec3 candy = mix(diffuseColor.rgb, vec3(0.85, 0.075, 0.23), 0.48);
    diffuseColor.rgb = mix(cream, candy, mix(0.45, max(strip, pin), detail));
  } else if (stlMode == 12) { // PCB traces connect across tiles. Solder pads glow at their elbows.
    vec2 traceUV = uvStl * 1.6, tileId = floor(traceUV);
    vec2 trace = fract(traceUV) - 0.5;
    if (stlNoise(tileId) > 0.5) trace.x = -trace.x;
    if (stlNoise(tileId + 8.1) > 0.5) trace.y = -trace.y;
    float track = min(length(vec2(max(trace.x,0.0),trace.y)), length(vec2(trace.x,min(trace.y,0.0))));
    float pad = abs(length(trace) - 0.105);
    float path = min(track,pad);
    float glow = exp(-17.0 * path);
    float conductor = stlLine(path, 0.022, max(aa.x,aa.y) * 1.6);
    vec3 neon = mix(vec3(0.055,0.95,0.68), diffuseColor.rgb, 0.38);
    diffuseColor.rgb = mix(diffuseColor.rgb * 0.13, neon, mix(0.10, conductor, detail));
    stlEmission = neon * mix(0.04, 0.45 * conductor + 0.18 * glow, detail);
  } else if (stlMode == 13) { // A deep nebula behind sparsely scattered stars of different magnitudes.
    vec2 starUV = uvStl * 2.8;
    vec2 tile = floor(starUV);
    float seed = stlNoise(tile);
    vec2 star = fract(starUV) - (0.18 + 0.64 * vec2(seed, stlNoise(tile + 13.9)));
    float radius = 0.026 + 0.080 * seed * seed;
    float pixel = max(aa.x, aa.y) * 2.8;
    float point = stlLine(length(star), radius, pixel);
    if (seed > 0.83) point = max(point, 0.58 * stlLine(min(abs(star.x),abs(star.y)), 0.018, pixel) * (1.0-smoothstep(0.07,0.22,length(star))));
    float cloud = 0.5 + 0.5 * sin(uvStl.x * 1.4 + uvStl.y * 2.6 + 1.3 * sin(uvStl.x * 2.4));
    vec3 sky = mix(vec3(0.019,0.031,0.12), vec3(0.15,0.056,0.25), cloud * cloud) + diffuseColor.rgb * 0.15;
    point *= 1.0 - smoothstep(0.06,0.24,max(aa.x,aa.y));
    vec3 starColor = mix(vec3(0.61,0.82,1.0), vec3(1.0,0.77,0.44), seed);
    diffuseColor.rgb = mix(sky, starColor, point);
    stlEmission = sky * 0.22 + starColor * (point * 0.55);
  } else if (stlMode == 14) { // Broad aurora curtains with finer vertical filaments.
    float latitude = uvStl.y * 0.85 + 0.45 * sin(uvStl.x * 1.9) + 0.12 * sin(uvStl.x * 4.1);
    float ridge = abs(fract(latitude) - 0.40);
    float curtain = exp(-7.6 * ridge);
    float threads = 0.82 + 0.18 * sin(uvStl.x * 39.0 + sin(uvStl.x * 3.1)) * (1.0-smoothstep(0.025,0.12,aa.x));
    vec3 lightBand = mix(vec3(0.04,0.88,0.43), vec3(0.34,0.22,0.91), 0.5+0.5*sin(uvStl.x*1.3+latitude));
    lightBand = mix(lightBand, diffuseColor.rgb, 0.26);
    vec3 night = vec3(0.018,0.052,0.095) + diffuseColor.rgb * 0.16;
    diffuseColor.rgb = mix(night, lightBand, curtain * 0.76 * threads);
    stlEmission = lightBand * (0.25 * curtain * threads);
  } else if (stlMode == 15) { // Interlocking dragon scales with scalloped, warm-edged tips.
    vec2 rows = uvStl * vec2(1.9, 2.45);
    float row = floor(rows.y);
    float x = fract(rows.x + 0.5 * mod(row,2.0)) * 2.0 - 1.0;
    float y = fract(rows.y);
    float arc = 0.89 - 0.77 * sqrt(max(0.0, 1.0-x*x));
    float facet = 0.5 + 0.5 * sin(1.6*x - y*1.7);
    float contour = stlLine(abs(y-arc), 0.044, max(aa.x,aa.y)*2.45);
    vec3 hide = mix(diffuseColor.rgb,vec3(0.062,0.41,0.31),0.32) * (0.63 + 0.51*facet);
    vec3 tip = mix(diffuseColor.rgb,vec3(0.78,0.52,0.19),0.57);
    diffuseColor.rgb = mix(mix(diffuseColor.rgb,hide,0.52), mix(hide,tip,contour), detail);
  }
}`;

export function applySTLFinish(mesh, selectedFinish, selectedSurface) {
  const finish = stlFinish(selectedFinish), surface = stlSurface(selectedSurface);
  const material = mesh.material;
  const state = states.get(material);
  if (!state && finish === "solid") return;
  if (state) {
    state.mode.value = modes[finish];
    state.mask.value = masks[surface];
    if (state.geometry === mesh.geometry) return;
  }

  const geometry = mesh.geometry;
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const { min, max } = geometry.boundingBox;
  const spans = [max.x - min.x, max.y - min.y, max.z - min.z];
  const longest = Math.max(...spans);
  const frequency = spans.map(span => span > 0 ? Math.max(1, Math.round(5 * span / longest)) / span : 0);
  if (state) {
    state.geometry = geometry;
    state.origin.value = min;
    state.frequency.value = frequency;
    return;
  }
  const mode = { value: modes[finish] }, mask = { value: masks[surface] };
  const origin = { value: min }, gridFrequency = { value: frequency };
  states.set(material, { geometry, mode, mask, origin, frequency: gridFrequency });
  material.customProgramCacheKey = () => "stl-finish-v2";
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, { stlOrigin: origin, stlFrequency: gridFrequency, stlMode: mode, stlMask: mask });
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${varying}\nuniform vec3 stlOrigin;\nuniform vec3 stlFrequency;`)
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvStlGrid = (position - stlOrigin) * stlFrequency;\nvStlNormal = normal;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${varying}\nuniform int stlMode;\nuniform int stlMask;\n${patternFunctions}`)
      .replace("#include <color_fragment>", `#include <color_fragment>\n${fragment}`)
      .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\ntotalEmissiveRadiance += stlEmission;")
      .replace("#include <metalnessmap_fragment>", "#include <metalnessmap_fragment>\nif (stlEnabled && stlMode == 3) { metalnessFactor = 0.38; roughnessFactor = 0.34; }");
  };
  material.needsUpdate = true;
}
