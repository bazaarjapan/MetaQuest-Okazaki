import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

// Long XR acceptance sequences can outlast a CLI socket read timeout. Start
// browser-side work without blocking the CDP call, then poll its final report.
const [session, file, output] = process.argv.slice(2);
assert.ok(session && file && output, "session, test file and report path are required");
function evaluate(source) {
  const run = spawnSync(process.execPath,
    ["node_modules/agent-browser/bin/agent-browser.js", "--session", session, "eval", "--stdin"],
    { input: source, encoding: "utf8", timeout: 30000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  let value = JSON.parse(run.stdout.trim());
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { /* Ordinary start marker. */ }
  }
  return value;
}
const source = await readFile(file, "utf8");
evaluate(`window.__asyncBrowserCheck = null;
Promise.resolve(eval(${JSON.stringify(source)})).then(value => {
  window.__asyncBrowserCheck = typeof value === "string" ? JSON.parse(value) : value;
}).catch(error => { window.__asyncBrowserCheck = { passed: false, error: error.message, results: [] }; });
"started"`);
const deadline = Date.now() + 120000;
let report;
while (!report && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  report = evaluate("window.__asyncBrowserCheck");
}
assert.ok(report, "Browser acceptance did not finish within two minutes");
await mkdir("test-results", { recursive: true });
await writeFile(output, JSON.stringify({ ...report, checkedAt: new Date().toISOString(), test: file }, null, 2));
console.log(JSON.stringify({ passed: report.passed, file, checks: report.results?.length,
  failures: report.results?.filter((item) => !item.ok).map((item) => item.name),
  error: report.error, report: output }));
assert.equal(report.passed, true, report.error || "Browser acceptance failed");
