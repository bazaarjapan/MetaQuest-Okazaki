import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("browser diagnostics and release gates use the current package version", async () => {
  const root=new URL("../",import.meta.url);
  const {version}=JSON.parse(await readFile(new URL("package.json",root),"utf8"));
  const main=await readFile(new URL("src/main.js",root),"utf8");
  assert.equal(main.match(/version: "([\d.]+)"/)?.[1],version);
  for(const file of ["detail-browser-check.js","compact-desktop-check.js","quality-default-check.js","region-browser-check.js"]) {
    const source=await readFile(new URL(`tests/${file}`,root),"utf8");
    assert.equal(source.match(/\.version\s*===\s*["']([\d.]+)["']/)?.[1],version,file);
  }
});
