import { applyBuildingGeometry, buildingGeometryData } from './field-style.js';

export function createFacadeDecorator(THREE, createWorker = () =>
  new Worker(new URL('./facade-worker.js', import.meta.url), {type: 'module'})) {
  let worker;
  let previous = Promise.resolve();

  function request(data) {
    worker ??= createWorker();
    const current = worker;
    const arrays = Object.values(data.attributes).map(({array}) => array.buffer);
    if (data.indices) arrays.push(data.indices.buffer);
    return new Promise((resolve, reject) => {
      function clear() {
        current.removeEventListener('message', receive);
        current.removeEventListener('error', fail);
        current.removeEventListener('messageerror', fail);
      }
      function receive({data}) {
        clear();
        if (data.error) reject(Error(data.error));
        else resolve(data.prepared);
      }
      function fail(event) {
        clear(); current.terminate(); worker = null;
        reject(Error(event.message || 'Could not prepare building facades'));
      }
      current.addEventListener('message', receive);
      current.addEventListener('error', fail);
      current.addEventListener('messageerror', fail);
      try { current.postMessage(data, arrays); }
      catch (error) { clear(); reject(error); }
    });
  }

  // The tile loader bounds concurrent requests. A single worker processes them
  // in order, skipping canceled queued tiles before copying or fitting them.
  return (geometry, signal) => {
    const job = previous.then(async () => {
      signal?.throwIfAborted();
      const prepared = await request(buildingGeometryData(geometry, true));
      signal?.throwIfAborted();
      applyBuildingGeometry(THREE, geometry, prepared);
    });
    previous = job.catch(() => {});
    return job;
  };
}
