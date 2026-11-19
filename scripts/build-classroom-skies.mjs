import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';

// Bake the wraparound sky on the ground plane of a cloud layer. The renderer
// only changes a background texture when the player changes the time of day.
const width = 1024, height = 512;
const clamp = x => Math.max(0, Math.min(1, x));
const blend = (a, b, t) => a + (b - a) * t;
const smooth = t => t * t * (3 - 2 * t);
function hash(x, z) {
  let n = Math.imul(x, 374761393) + Math.imul(z, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
function noise(x, z) {
  const i = Math.floor(x), j = Math.floor(z);
  const tx = smooth(x - i), tz = smooth(z - j);
  return blend(blend(hash(i,j), hash(i+1,j), tx), blend(hash(i,j+1), hash(i+1,j+1), tx), tz);
}
function cloud(x, z) {
  let density = 0, weight = .52;
  for (let octave = 0; octave < 5; octave++) {
    density += weight * noise(x,z);
    [x,z] = [1.72*x+.98*z+19, 1.72*z-.98*x+7];
    weight *= .5;
  }
  return density;
}
await mkdir('public/sky', { recursive: true });
for (const evening of [false,true]) {
  const pixels = Buffer.alloc(width*height*3);
  const horizon = evening ? [252,192,155] : [198,229,239];
  const zenith = evening ? [75,94,156] : [50,137,207];
  const shade = evening ? [168,142,166] : [166,197,216];
  const lit = evening ? [255,219,172] : [255,251,232];
  const sun = evening ? [-380,100,150] : [-280,330,150], length = Math.hypot(...sun);
  for (let y=0; y<height; y++) {
    const elevation = (.5-(y+.5)/height)*Math.PI;
    const up = Math.sin(elevation), horizontal = Math.cos(elevation);
    for (let x=0; x<width; x++) {
      const longitude = ((x+.5)/width-.5)*2*Math.PI;
      const dx = Math.cos(longitude)*horizontal, dz = Math.sin(longitude)*horizontal;
      const sunDot = clamp((dx*sun[0]+up*sun[1]+dz*sun[2])/length);
      const heightMix = Math.pow(clamp(up),.65);
      const glow = Math.pow(sunDot, 13) * (evening ? .68 : .42);
      const disk = smooth(clamp((sunDot-.99984)/.00011));
      const plane = 1.9/Math.max(.028,up+.015);
      const cx = dx*plane+7.6, cz = dz*plane-11.3;
      let opacity = 0, light = 0;
      if (up>0) {
        const density = cloud(cx,cz);
        // Sampling towards the sun gives the cloud bank a lit edge and a shaded belly.
        const towardsSun = cloud(cx+sun[0]/length*.28,cz+sun[2]/length*.28);
        opacity = smooth(clamp((density-.48)/.12))*smooth(clamp(up/.10))*.94;
        light = clamp(.66 + (density-towardsSun)*4 - (density-.55)*1.8);
      }
      for(let c=0;c<3;c++) {
        let sky = blend(horizon[c],zenith[c],heightMix);
        sky = blend(sky,lit[c],glow);
        sky = blend(sky,[255,249,222][c],disk);
        pixels[(y*width+x)*3+c]=Math.round(blend(sky,blend(shade[c],lit[c],light),opacity));
      }
    }
  }
  await sharp(pixels,{raw:{width,height,channels:3}}).webp({quality:90}).toFile('public/sky/'+(evening?'evening':'day')+'.webp');
}
