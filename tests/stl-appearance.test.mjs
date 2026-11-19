import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import * as THREE from "three";
import { stlFinishes, stlFinish, stlSurface, validSTLFinish, validSTLSurface } from "../src/stl-appearance.js";
import { applySTLFinish } from "../src/stl-finish-material.js";

test("the classroom accepts the sixteen supported finishes, with safe defaults for old placements", () => {
  assert.deepEqual(stlFinishes, ["solid", "windows", "truss", "metal", "brick", "wood", "roofTiles",
    "stainedGlass", "mosaic", "honeycomb", "checker", "candy", "circuit", "galaxy", "aurora", "scales"]);
  assert.ok(stlFinishes.every(validSTLFinish));
  assert.ok(["all", "walls", "roof"].every(validSTLSurface));
  for (const value of [null, undefined, "", "typo", "constructor", {}, 3]) {
    assert.equal(validSTLFinish(value), false); assert.equal(stlFinish(value), "solid");
    assert.equal(validSTLSurface(value), false); assert.equal(stlSurface(value), "all");
  }
});

test("finish changes reuse one material program and update its grid when the editor switches models", () => {
  const geometry = new THREE.BoxGeometry(4, 2, 1), material = new THREE.MeshStandardMaterial();
  const mesh = new THREE.Mesh(geometry, material);
  const stockHook = material.onBeforeCompile;
  applySTLFinish(mesh, undefined, undefined);
  assert.equal(material.onBeforeCompile, stockHook);
  applySTLFinish(mesh, "windows", "walls");
  const shader = { ...THREE.ShaderLib.standard, uniforms: {} };
  material.onBeforeCompile(shader);
  const programVersion = material.version;
  for (const [mode, finish] of stlFinishes.entries()) {
    applySTLFinish(mesh, finish, "roof");
    assert.equal(shader.uniforms.stlMode.value, mode);
    assert.equal(shader.uniforms.stlMask.value, 2);
    assert.equal(material.version, programVersion);
  }
  const nextGeometry = new THREE.BoxGeometry(1, 4, 2);
  mesh.geometry = nextGeometry;
  applySTLFinish(mesh, "wood", "all");
  assert.equal(shader.uniforms.stlOrigin.value, nextGeometry.boundingBox.min);
  assert.deepEqual(shader.uniforms.stlFrequency.value, [1, 1.25, 1.5]);
  nextGeometry.dispose(); geometry.dispose(); material.dispose();
});

// Set STL_WEBGL_BROWSER to a Chromium executable to exercise real pixels in software WebGL2.
const browser = process.env.STL_WEBGL_BROWSER;
test("WebGL renders the sixteen finishes, respects face masks and follows the chosen colour", { skip: !browser, timeout: 120000 }, async () => {
  const entry = `
    import * as T from "three";
    import { stlFinishes } from "./src/stl-appearance.js";
    import { applySTLFinish } from "./src/stl-finish-material.js";
    try {
      const errors = [];
      console.error = (...args) => errors.push(args.map(String).join(" "));
      const renderer = new T.WebGLRenderer();
      const target = new T.WebGLRenderTarget(96,96);
      renderer.setRenderTarget(target);
      const camera = new T.OrthographicCamera(-1.3,1.3,1.3,-1.3,0.1,20);
      const scene = new T.Scene();
      scene.background = new T.Color(0);
      const light = new T.DirectionalLight(0xffffff, 2);
      light.position.set(3,7,3);
      const mesh = new T.Mesh(new T.BoxGeometry(2,2,2), new T.MeshStandardMaterial({ side: T.DoubleSide }));
      scene.add(mesh,light,new T.HemisphereLight(0xffffff,0x888888,2));
      const bytes = new Uint8Array(96*96*4);
      const result = {};
      for (const angle of ["top","side"]) {
        const top = angle === "top";
        camera.up.set(0,top?0:1,top?-1:0); camera.position.set(0,top?5:0,top?0:5);
        camera.lookAt(0,0,0); camera.updateProjectionMatrix();
        for (const [index, color] of ["#d38b67","#427cbc"].entries()) {
          mesh.material.color.set(color);
          for (const mask of ["all","walls","roof"]) for (const finish of stlFinishes) {
            applySTLFinish(mesh,finish,mask); renderer.render(scene,camera);
            renderer.readRenderTargetPixels(target,0,0,96,96,bytes);
            let hash=2166136261, visible=0;
            for (let i=0; i<bytes.length; i+=4) {
              if (bytes[i]+bytes[i+1]+bytes[i+2]) visible++;
              for (let channel=0;channel<3;channel++) hash=Math.imul(hash^bytes[i+channel],16777619);
            }
            result[[angle,index,mask,finish].join("/")]={hash:hash>>>0,visible};
          }
        }
      }
      document.body.textContent="RESULT="+JSON.stringify({errors,result});
    } catch(error) { document.body.textContent="FAIL="+String(error.stack); }
  `;
  const built = await build({ stdin: { resolveDir: fileURLToPath(new URL("../", import.meta.url)),
    contents: entry }, bundle: true, write: false, format: "iife" });
  const server = createServer((req, res) => {
    const script = req.url === "/app.js";
    res.setHeader("Content-Type", script ? "text/javascript" : "text/html");
    res.end(script ? built.outputFiles[0].text : '<!doctype html><body><script src="/app.js"></script></body>');
  });
  const profile = await mkdtemp(join(tmpdir(), "okazaki-stl-webgl-"));
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const { stdout } = await promisify(execFile)(browser, ["--headless=new", "--no-first-run", "--disable-extensions",
      "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--user-data-dir=" + profile, "--dump-dom",
      "http://127.0.0.1:" + server.address().port], { timeout: 95000, windowsHide: true, maxBuffer: 4_000_000 });
    const message = stdout.match(/RESULT=([\s\S]*?)<\/body>/);
    assert.ok(message, stdout.slice(-2000));
    const { errors, result } = JSON.parse(message[1]);
    assert.deepEqual(errors, []);
    for (const [angle, selected, excluded] of [["top","roof","walls"], ["side","walls","roof"]]) {
      const pixel = (color, mask, finish) => result[[angle, color, mask, finish].join("/")];
      assert.equal(new Set(stlFinishes.map(finish => pixel(0, "all", finish).hash)).size, stlFinishes.length);
      for (const finish of stlFinishes) {
        assert.notEqual(pixel(0, "all", finish).hash, pixel(1, "all", finish).hash, finish + " retains base color");
        assert.equal(pixel(0, excluded, finish).hash, pixel(0, "all", "solid").hash, finish + " masks " + excluded);
        if (finish === "truss" && angle === "top") {
          // The intact bottom of the cube is visible through a roof-only truss.
          assert.equal(pixel(0, selected, finish).visible, pixel(0, "all", "solid").visible);
        } else {
          assert.equal(pixel(0, selected, finish).hash, pixel(0, "all", finish).hash, finish + " applies to " + selected);
        }
      }
      assert.ok(pixel(0, "all", "truss").visible < pixel(0, "all", "solid").visible * 0.8);
    }
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
});
