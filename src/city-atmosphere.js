// A small gradient sky gives real DEM hills a readable horizon in both eyes.
export function createCitySky(THREE,scene,documentTarget=document) {
  const canvas=documentTarget.createElement('canvas');canvas.width=256;canvas.height=128;
  const context=canvas.getContext('2d');
  let texture=null;
  return {
    set(evening){
      const horizon=evening?'#e9b4a1':'#dce9ee';scene.fog.color.set(horizon);
      if(!context){scene.background.set(horizon);return;}
      const gradient=context.createLinearGradient(0,0,0,128);gradient.addColorStop(0,evening?'#707eaa':'#8db4cf');gradient.addColorStop(.47,horizon);gradient.addColorStop(.54,horizon);gradient.addColorStop(1,evening?'#c1a0a0':'#b4c3b8');
      context.fillStyle=gradient;context.fillRect(0,0,256,128);
      // Equirectangular backgrounds are converted once and cached by texture
      // identity. Replace/dispose on a time change so the sky follows the fog.
      texture?.dispose();texture=new THREE.CanvasTexture(canvas);
      texture.colorSpace=THREE.SRGBColorSpace;texture.mapping=THREE.EquirectangularReflectionMapping;
      texture.generateMipmaps=false;texture.minFilter=THREE.LinearFilter;scene.background=texture;
    },
    dispose(){texture?.dispose();}
  };
}
