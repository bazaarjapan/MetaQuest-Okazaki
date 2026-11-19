export const stlFinishes = Object.freeze([
  "solid", "windows", "truss", "metal", "brick", "wood", "roofTiles", "stainedGlass",
  "mosaic", "honeycomb", "checker", "candy", "circuit", "galaxy", "aurora", "scales",
]);
const surfaces = ["all", "walls", "roof"];

export const validSTLFinish = value => stlFinishes.includes(value);
export const validSTLSurface = value => surfaces.includes(value);
export const stlFinish = value => validSTLFinish(value) ? value : "solid";
export const stlSurface = value => validSTLSurface(value) ? value : "all";
