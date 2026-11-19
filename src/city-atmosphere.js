// The clear color and distant terrain use the same horizon tint as the sky art.
export function cityFogRange(radius, evening = false) {
  return { near: Math.min(evening ? 400 : 650, radius * .3), far: radius + 500 };
}

export function createCitySky(THREE, scene, load = url => new THREE.TextureLoader().loadAsync(url)) {
  let selected = null, generation = 0, current = null;
  return {
    async set(evening) {
      if (selected === evening) return;
      selected = evening;
      const request = ++generation;
      const horizon = evening ? '#fcc09b' : '#c6e5ef';
      scene.fog.color.set(horizon);
      scene.background = new THREE.Color(horizon);
      current?.dispose();
      current = null;
      try {
        const sky = await load(evening ? '/sky/evening.webp' : '/sky/day.webp');
        if (request !== generation) { sky.dispose(); return; }
        sky.colorSpace = THREE.SRGBColorSpace;
        sky.mapping = THREE.EquirectangularReflectionMapping;
        sky.generateMipmaps = false;
        sky.minFilter = THREE.LinearFilter;
        current = scene.background = sky;
      } catch {
        if (request === generation) selected = null;
      }
    },
    dispose() {
      generation++;
      selected = null;
      if (current && scene.background === current) scene.background = null;
      current?.dispose();
      current = null;
    },
  };
}
