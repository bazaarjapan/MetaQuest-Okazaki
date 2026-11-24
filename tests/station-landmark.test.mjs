import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Box3, BoxGeometry, Group, Mesh, Scene, Vector3 } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { createStationLandmark } from "../src/station-landmark.js";

const station = [95.92456, 16.5, 49.00273];

test("the shipped Blender model loads at the mapped station and plaza", async () => {
  const manifest = JSON.parse(await readFile(new URL("../public/city/manifest.json", import.meta.url)));
  const data = await readFile(new URL("../public/station/okazaki-station.glb", import.meta.url));
  const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  const {scene: model} = await new GLTFLoader().parseAsync(buffer, "");
  const scene = new Scene();
  const landmark = createStationLandmark(scene, async () => model);
  await landmark.update(manifest.station, true);
  assert.equal(landmark.getState().clockVisible, true);
  assert.deepEqual(landmark.getState().position, manifest.station);
  const building = model.getObjectByName("StationArchitecture");
  assert.ok(building);
  const architecture = new Box3().setFromObject(building);
  assert.ok(architecture.containsPoint(new Vector3(...manifest.station).add(new Vector3(0, 10.5, 0))),
    "station envelope must cover the existing PLATEAU concourse");
  const clock = new Box3().setFromObject(model.getObjectByName("EastPlazaClock"));
  const center = clock.getCenter(new Vector3());
  assert.ok(Math.hypot(center.x - 163, center.z + 4) < 1, "clock belongs on the east plaza island");
  assert.ok(Math.abs(clock.min.y - 16.57) < 0.2, "clock base meets the mapped terrain");
  assert.ok(clock.max.y - clock.min.y > 2);
  await landmark.update(manifest.station, false);
  assert.equal(model.visible, false);
});

test("the station loads once and honors photo style selected during loading", async () => {
  const scene = new Scene();
  const model = new Group().add(new Mesh());
  let requests = 0;
  let finish;
  const landmark = createStationLandmark(scene, () => {
    requests++;
    return new Promise(resolve => { finish = resolve; });
  });
  await landmark.update(station, false);
  assert.equal(requests, 0);
  const loading = landmark.update(station, true);
  await landmark.update(station, true);
  await landmark.update(station, false);
  finish(model);
  await loading;
  assert.deepEqual(landmark.getState(), {status: "ready", visible: false, meshes: 1, position: station, clockVisible: false});
  assert.equal(model.visible, false);
  await landmark.update(station, true);
  assert.equal(model.visible, true);
  assert.deepEqual(scene.children, [model]);
  assert.equal(requests, 1);
});

test("shared work on the clock's footprint takes precedence on load and removal", async () => {
  const clock = new Mesh(new BoxGeometry(2, 4, 1));
  clock.name = "EastPlazaClock";
  clock.position.set(20, 2, -15);
  const model = new Group().add(new Mesh(), clock);
  const landmark = createStationLandmark(new Scene(), async () => model);
  const overlapping = {bounds: {
    min: [station[0] + 19, 0, station[2] - 16],
    max: [station[0] + 21, 3, station[2] - 14],
  }};
  landmark.setWorks([overlapping]);
  await landmark.update(station, true);
  assert.equal(clock.visible, false);
  assert.equal(model.visible, true);
  landmark.setWorks([{bounds: {min: [5, 0, 5], max: [6, 3, 6]}}]);
  assert.equal(clock.visible, true);
  landmark.setWorks([overlapping]);
  assert.equal(clock.visible, false);
  landmark.setWorks([]);
  assert.equal(clock.visible, true);
});

test("an unavailable landmark preserves the city and can be loaded on a later selection", async () => {
  const scene = new Scene();
  const city = new Group();
  scene.add(city);
  let attempts = 0;
  const landmark = createStationLandmark(scene, async () => {
    if (++attempts === 1) throw new Error("asset unavailable");
    return new Group().add(new Mesh());
  });
  await landmark.update(station, true);
  assert.equal(landmark.getState().status, "unavailable");
  assert.deepEqual(scene.children, [city]);
  await landmark.update(station, false);
  await landmark.update(station, true);
  assert.equal(landmark.getState().visible, true);
  assert.equal(scene.children.length, 2);
});
