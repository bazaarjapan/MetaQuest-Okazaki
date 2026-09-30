import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";

// Capture the result of tests/xr-check.js from our isolated verification session.
const detail = process.argv[3] === "detail";
const browser = process.argv[3] === "browser";
const file = browser ? "test-results/detail-browser.json" : detail ? "test-results/detail-xr.json" : "test-results/analog-xr.json";
const output = execFileSync(process.execPath, [
  "node_modules/agent-browser/bin/agent-browser.js",
  "--session", process.argv[2] ?? "okazaki-mode2-system",
  "--json", "eval", browser ? "window.__detailBrowserReport" : detail ? "window.__detailXRReport" : "window.__xrAcceptanceReport",
], { encoding: "utf8", windowsHide: true });
const response = JSON.parse(output);
assert.equal(response.success, true);
const report = response.data.result;
assert.equal(report?.passed, true);
assert.ok(report.results.every((item) => item.ok));
await mkdir("test-results", { recursive: true });
await writeFile(file, JSON.stringify({
  capturedAt: new Date().toISOString(), origin: response.data.origin, ...report,
}, null, 2));
console.log(JSON.stringify({ passed: true, checks: report.results.length,
  environment: report.environment, file }));
