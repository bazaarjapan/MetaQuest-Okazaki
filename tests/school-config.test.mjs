import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const config = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

test("school Worker uses dedicated resources and API-first routing, not a public R2 bucket", () => {
  assert.equal(config.main, "worker/index.mjs");
  assert.equal(config.assets.binding, "ASSETS");
  assert.deepEqual(config.assets.run_worker_first, ["/api/*"]);
  assert.equal(config.assets.not_found_handling, "404-page");
  assert.deepEqual(config.d1_databases, [{ binding: "DB", database_name: "okazaki-school-worlds",
    database_id: "a6dae057-d386-42a8-b37e-1298ee4656e5", migrations_dir: "migrations" }]);
  assert.deepEqual(config.r2_buckets, [{ binding: "STL_BUCKET", bucket_name: "okazaki-school-assets" }]);
  assert.deepEqual(config.durable_objects.bindings, [{ name: "SCHOOL_ROOMS", class_name: "SchoolRoom" }]);
  assert.deepEqual(config.exports, { SchoolRoom: { type: "durable-object", storage: "sqlite" } });
  assert.equal(config.migrations, undefined, "Do not mix exports with legacy migrations");
});

test("registered public Google client is configured but teacher allowlist stays server secret only", () => {
  assert.deepEqual(config.vars, { APP_ORIGIN: "https://metaquest001.gigach.net",
    GOOGLE_CLIENT_ID: "995759572361-9ogma8658lvf8usle2o3ut47d8a1agjf.apps.googleusercontent.com" });
  assert.equal(config.vars.TEACHER_GOOGLE_SUBS, undefined);
  assert.equal(config.vars.TEACHER_GOOGLE_EMAILS, undefined);
});

test("local school gate pins its direct runtime dependencies and Worker check never publishes", () => {
  assert.equal(pkg.devDependencies.miniflare, "5.20260926.1-alpha");
  assert.equal(pkg.devDependencies.esbuild, "0.28.2");
  assert.equal(pkg.devDependencies.ws, "8.21.0");
  assert.equal(pkg.scripts["test:school-runtime"], "node scripts/verify-school-runtime.mjs");
  assert.match(pkg.scripts["check:worker"], /--dry-run(?:\s|$)/);
});
