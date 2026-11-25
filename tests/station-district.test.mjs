import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { ArrayCamera, Box3, BoxGeometry, Group, Mesh, MeshBasicMaterial, OrthographicCamera, Scene, Vector3 } from "three";
import { createStationDistrict } from "../src/station-district.js";
import { planRegionTiles } from "../src/region-plan.js";

const root = new URL("../public/", import.meta.url);
const {station} = JSON.parse(await readFile(new URL("city/manifest.json", root)));
const [x, , z] = station;
const bytes = new Uint8Array(32);
const digest = createHash("sha256").update(bytes).digest("hex");
const manifest = {
  version: 2, tileSize: 250, origin: station, bounds: [x-1000,z-1000,x+1000,z+1000],
  surfaces: {file: "surfaces.png", bytes: 64, sha256: digest},
  tiles: Array.from({length:64}, (_, i) => {
    const row = Math.floor(i/8), col = i%8, id = `r${row}-c${col}`;
    const x0 = x-1000+250*col, z0 = z-1000+250*row;
    return {id, file: id+".glb", bounds: [x0,z0,x0+250,z0+250], bytes: bytes.length,
      triangles: 12000, sha256: digest, regionBuildings: [`b-${col}-${row}`], heightRange: [16,32]};
  }),
};

async function until(condition) {
  for (let i=0; i<200; i++) {
    if (condition()) return;
    await delay(5);
  }
  assert.fail("District state did not settle");
}

function fixture({hasBuilding = () => true, parse, response} = {}) {
  const requests = [];
  let disposed = 0;
  const scene = new Scene();
  const district = createStationDistrict(scene, {
    hasBuilding,
    fetchImpl: async (url, options) => {
      requests.push({url, options});
      if (response) return response(url, options);
      return url.endsWith(".json") ? Response.json(manifest) : new Response(bytes);
    },
    parse: parse ?? (async () => {
      const geometry = new BoxGeometry();
      geometry.addEventListener("dispose", () => disposed++);
      return new Group().add(new Mesh(geometry, new MeshBasicMaterial()));
    }),
  });
  const camera = new OrthographicCamera(-1100,1100,1100,-1100,.1,1800);
  camera.position.set(x,800,z); camera.up.set(0,0,-1);
  camera.lookAt(x,0,z); camera.updateMatrixWorld(true);
  let time = 0;
  const update = (options={}) => district.update({station,position:new Vector3(x,32,z),camera,
    enabled:true,quality:"balanced",xr:false,time:time+=350,...options});
  const state = district.getState;
  return {district, scene, requests, update, state, camera, disposed: () => disposed,
    async open(options={}) {
      update(options);
      await until(() => state().status === "ready");
      update(options);
      await until(() => !state().loading.length);
    }};
}

test("district respects distance, quality and headset limits and frees cells on photo or departure", async () => {
  const f = fixture();
  f.update({enabled:false});
  f.update({position:new Vector3(x+2500,20,z)});
  assert.equal(f.requests.length,0);
  await f.open({quality:"high"});
  assert.equal(f.state().available,64);
  assert.ok(f.state().resident.length > 7);
  assert.ok(f.state().triangles <= f.state().limits.triangles);
  const initial = f.state().resident.length;
  f.update({quality:"high",xr:true});
  await until(() => !f.state().loading.length);
  assert.ok(f.state().resident.length <= 4);
  assert.ok(f.disposed() >= initial-4);
  f.update({quality:"performance"});
  await until(() => !f.state().loading.length);
  assert.equal(f.state().resident.length,2);
  f.update({enabled:false});
  assert.deepEqual(f.state().resident,[]);
  assert.equal(f.scene.getObjectByName("station-district").children.length,0);
  await f.open();
  assert.ok(f.state().resident.length>0);
  f.update({position:new Vector3(x,900,z)});
  assert.deepEqual(f.state().resident,[],"high-altitude views keep the original city geometry");
  f.update({position:new Vector3(x-2000,20,z)});
  assert.deepEqual(f.state().resident,[]);
  assert.equal(f.state().errors,0);
  assert.ok(f.requests.every(r=>r.url.startsWith("/station/district/") && r.options.redirect==="error"));
});

test("district waits for original regional building geometry, stops stale decodes and releases their meshes", async () => {
  const pending = [];
  const available = new Set();
  const f = fixture({hasBuilding: id => available.has(id),
    parse: () => new Promise(resolve => pending.push(resolve))});
  await f.open();
  assert.equal(f.requests.length,1);
  available.add("b-3-3");
  f.update();
  await until(() => pending.length);
  assert.equal(f.state().loading.length,1);
  f.update({enabled:false});
  assert.equal(f.requests.at(-1).options.signal.aborted,true);
  const geometry = new BoxGeometry();
  let freed = false;
  geometry.addEventListener("dispose", () => { freed = true; });
  pending.pop()(new Group().add(new Mesh(geometry,new MeshBasicMaterial())));
  await until(() => !f.state().loading.length);
  assert.equal(freed,true);
  assert.deepEqual(f.state().resident,[]);
  assert.equal(f.state().errors,0);
});

test("district only fetches distant detail in view, including either eye in immersive mode", async () => {
  const f = fixture({hasBuilding:id=>id==="b-2-2" || id==="b-5-2"});
  const north = z - 375;
  const eyeAt = east => {
    const eye = new OrthographicCamera(-40,40,40,-40,.1,700);
    eye.position.set(east,250,north); eye.up.set(0,0,-1);
    eye.lookAt(east,0,north); eye.updateMatrixWorld(true);
    return eye;
  };
  const west = eyeAt(x-375), east = eyeAt(x+375);
  const observer = new Vector3(x,20,north);
  await f.open({position:observer,camera:west});
  assert.deepEqual(f.state().resident,["r2-c2"]);
  f.update({position:observer,camera:new ArrayCamera([west,east]),xr:true});
  await until(() => f.state().resident.length === 2);
  assert.deepEqual(f.state().resident.sort(),["r2-c2","r2-c5"]);
});

test("manifest paths cannot escape the authored collection; a failed file retries without removing the city", async () => {
  let brokenManifest = true, wrongBytes = true;
  const f = fixture({hasBuilding: id => id==="b-3-3", response: async url => {
    if (!url.endsWith(".json")) return new Response(wrongBytes ? bytes.slice(2) : bytes);
    const copy = structuredClone(manifest);
    if (brokenManifest) copy.tiles[0].file = "https://outside.invalid/x.glb";
    return Response.json(copy);
  }});
  f.update();
  await until(() => f.state().status === "unavailable");
  assert.equal(f.requests.length,1);
  brokenManifest = false;
  f.update({time:12000});
  await until(() => f.state().status === "ready");
  f.update({time:12500});
  await until(() => !f.state().loading.length);
  assert.deepEqual(f.state().resident,[]);
  assert.equal(f.state().errors,2);
  const count = f.requests.length;
  f.update({time:13500});
  assert.equal(f.requests.length,count);
  wrongBytes = false;
  f.update({time:24500});
  await until(() => f.state().resident.length === 1);
});

test("the shipped district loads through the normal GLB path in all 64 cells", async () => {
  const scene = new Scene();
  const region = JSON.parse(await readFile(new URL("region/buildings.json",root)));
  const authored = JSON.parse(await readFile(new URL("station/district/manifest.json",root)));
  let sourceBuildings = new Set();
  const district = createStationDistrict(scene, {hasBuilding: id => sourceBuildings.has(id),
    fetchImpl: async url => new Response(await readFile(new URL(url.split("?")[0].slice(1),root)))});
  const camera = new OrthographicCamera(-95,95,95,-95,.1,600);
  camera.up.set(0,0,-1);
  let time = 0;
  const check = () => district.update({station,position:camera.position,camera,enabled:true,
    quality:"performance",xr:false,time:time+=500});
  for (const cell of authored.tiles) {
    const [x0,z0,x1,z1] = cell.bounds;
    const centerX = (x0+x1)/2, centerZ = (z0+z1)/2;
    camera.position.set(centerX,210,centerZ);
    camera.lookAt(centerX,0,centerZ); camera.updateMatrixWorld(true);
    sourceBuildings = new Set(planRegionTiles(region.tiles,camera.position,"performance"));
    check();
    await until(() => district.getState().status === "ready");
    check();
    await until(() => district.getState().resident.includes(cell.id));
    const group = scene.getObjectByName("station-district");
    assert.deepEqual(group.position.toArray(),station);
    let triangles = 0, draws = 0;
    group.traverse(child => {
      if (!child.isMesh) return;
      triangles += (child.geometry.index?.count ?? child.geometry.getAttribute("position").count) / 3;
      draws += Math.max(1, child.geometry.groups.length);
      assert.equal(child.material.transparent,false);
      assert.ok(child.material.vertexColors && !child.material.map);
      const finish = child.geometry.getAttribute("uv");
      assert.ok(finish?.normalized && finish.itemSize === 2, "the batched cell preserves its Finish UV channel");
    });
    assert.equal(draws,1,"each cell is a single opaque vertex-coloured mesh");
    assert.equal(triangles,district.getState().triangles);
    assert.equal(district.getState().bytes,cell.bytes);
    const box = new Box3().setFromObject(group);
    assert.ok(!box.isEmpty() && box.max.y > box.min.y);
    assert.ok(box.min.x >= x0-.1 && box.max.x <= x1+.1 && box.min.z >= z0-.1 && box.max.z <= z1+.1,
      cell.id+" must stay on its source block at the same world origin");
    assert.equal(district.getState().errors,0);
  }
});
