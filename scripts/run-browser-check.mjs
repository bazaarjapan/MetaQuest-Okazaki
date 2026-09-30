import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const [session = 'okazaki-wide', file = 'tests/region-browser-check.js', output = 'test-results/region-browser.json'] = process.argv.slice(2);
const run = spawnSync(process.execPath, ['node_modules/agent-browser/bin/agent-browser.js', '--session', session, 'eval', '--stdin'], {
  input: await readFile(file, 'utf8'), encoding: 'utf8', timeout: 120000, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
});
assert.equal(run.status, 0, run.stderr || run.stdout);
let report = JSON.parse(run.stdout.trim());
if (typeof report === 'string') report = JSON.parse(report);
assert.equal(report.passed, true, JSON.stringify(report));
await mkdir('test-results', { recursive: true });
await writeFile(output, JSON.stringify({ ...report, checkedAt: new Date().toISOString(), test: file }, null, 2));
console.log(JSON.stringify({ passed: true, file, checks: report.results.length, report: output }));
