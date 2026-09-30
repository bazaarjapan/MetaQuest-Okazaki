// Exercise real UI -> tile download -> live DEM -> resource eviction.
(async () => {
  const results = [], state = () => window.__okazaki.getState();
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const assert = (ok, name, detail) => {
    results.push({ ok: Boolean(ok), name, detail });
    if (!ok) throw new Error(name + ': ' + JSON.stringify(detail));
  };
  const until = async condition => {
    const deadline = performance.now() + 45000;
    while (!condition() && performance.now() < deadline) await wait(150);
    return condition();
  };
  const budget = () => {
    const r = state().region;
    return r.buildings <= r.limits.maxResident && r.buildingTriangles <= r.limits.maxTriangles &&
      r.terrain <= r.limits.terrainResident && r.textureBytes <= r.limits.terrainTextureBytes && r.loading <= 3;
  };
  await until(() => state().region.ready);
  const r = state().region;
  assert(r.ready && r.availableBuildings === 770 && r.availableTerrain === 154 &&
    r.bounds[2] - r.bounds[0] > 25000 && r.bounds[3] - r.bounds[1] > 19000,
  'official-wide-coverage-manifests-loaded', { buildings: r.availableBuildings, terrain: r.availableTerrain, bounds: r.bounds });
  assert(state().version === '1.6.0' && state().parts === 5 && state().triangles === 58845,
    'original-station-core-preserved');
  await until(() => state().region.buildings > 0 && state().region.terrain > 0 && !state().region.loading);
  assert(state().region.buildings > 0 && state().region.terrain > 0 && budget(),
    'nearby-only-loaded-with-budget', state().region);
  const oldIds = state().region.loadedIds;
  const manifest = await (await fetch('/region/buildings.json')).json();
  const dest = manifest.tiles.find(t => t.bounds[0] > 10000 && t.triangles > 1000);
  assert(Boolean(dest), 'distant-building-destination-exists');
  document.querySelector('#tab-region')?.click();
  document.querySelector('#region-cell').value = dest.id;
  document.querySelector('#region-go').click();
  await until(() => state().region.loadedIds.includes(dest.id) && state().region.terrain > 0 && !state().region.loading);
  assert(state().current === 'region' && !state().free && state().camera[0] > 10000 &&
    state().region.loadedIds.includes(dest.id), 'real-selector-jumps-over-ten-kilometres', state().camera);
  assert(!state().region.loadedIds.some(id => oldIds.includes(id)) && budget(),
    'old-region-evicted-and-new-region-within-budget', state().region);
  assert(state().region.terrainHeights.length > 0 && state().region.terrainHeights.every(t =>
    t.heightMode === 'live-gsi-dem' && t.validVertices > 0 && t.noDataVertices === 0 && t.heightRange[1] > 1),
    'live-gsi-png-decoded-and-nonflat-height-applied', state().region.terrainHeights);
  document.querySelector('#free-move').click();
  assert(state().free && state().current === 'region' && state().camera[0] > 10000,
    'free-flight-enabled-in-place-not-reset-to-station');
  const canvas = document.querySelector('#region-map'), rect = canvas.getBoundingClientRect();
  const click = new MouseEvent('click', { bubbles: true,
    clientX: rect.left + rect.width * 0.2, clientY: rect.top + rect.height * 0.25 });
  // MouseEvent client coordinates are integer CSS pixels in Chrome. Derive the
  // expected world coordinate from the dispatched pixel, not its fractional
  // request (one pixel spans ~90m on the compact 281px-wide city map).
  const expectedX = r.bounds[0] + (r.bounds[2] - r.bounds[0]) * ((click.clientX - rect.left) / rect.width);
  canvas.dispatchEvent(click);
  assert(!state().free && state().current === 'region' && Math.abs(state().camera[0] - expectedX) < 1,
    'real-map-click-jumps-and-pauses-flight', state().camera);
  const quality = document.querySelector('#quality-select');
  for (const id of ['high', 'performance', 'balanced']) {
    quality.value = id; quality.dispatchEvent(new Event('change', { bubbles: true }));
    await until(() => !state().qualityLoading);
    await wait(750);
    assert(state().quality.id === id && budget(), 'quality-replans-resident-budget-' + id, state().region);
  }
  document.querySelector('#home').click();
  await until(() => state().region.loadedIds.includes('b-0-0') && state().region.terrain > 0 && !state().region.loading);
  assert(state().current === 'overview' && !state().free && budget() && !state().error &&
    state().region.loadedIds.includes('b-0-0') && state().region.terrainHeights.some(t => t.id === 'g-14-14434-6493'),
    'home-returns-to-core-with-streaming-intact', state().region);
  assert(state().region.requested < state().region.totalAvailable,
    'entire-city-never-preloaded', { requested: state().region.requested, available: state().region.totalAvailable });
  const report = { passed: true, environment: 'Desktop browser, NOT physical Quest performance', results };
  window.__regionBrowserReport = report;
  return JSON.stringify(report);
})();
