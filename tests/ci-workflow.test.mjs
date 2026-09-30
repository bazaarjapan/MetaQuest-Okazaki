import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');

test('CI runs verification on pull requests, main pushes and manual requests', () => {
  assert.match(workflow, /\n  pull_request:\n  push:/);
  assert.match(workflow, /push:\s*\n\s+branches: \[main\]/);
  assert.match(workflow, /workflow_dispatch:/);
  for (const command of ['npm ci', 'npm test', 'npm run check:assets', 'npm run build', 'npm run check:production']) {
    assert.ok(workflow.includes(command), `Missing CI gate: ${command}`);
  }
});

test('CI has read-only permissions and does not persist checkout credentials', () => {
  assert.match(workflow, /permissions:\s*\n\s+contents: read/);
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(workflow, /(?:write-all|pull_request_target|id-token:\s*write)/);
});

test('all official CI actions use full commit SHA pins', () => {
  const actions = [...workflow.matchAll(/uses:\s*(\S+)/g)].map(match => match[1]);
  assert.equal(actions.length, 3);
  for (const action of actions) assert.match(action, /^actions\/[a-z-]+@[a-f0-9]{40}$/);
});

test('GitHub Actions never deploys or receives Cloudflare credentials', async () => {
  const directory = new URL('../.github/workflows/', import.meta.url);
  for (const entry of await readdir(directory)) {
    if (!/\.ya?ml$/.test(entry)) continue;
    const source = await readFile(new URL(entry, directory), 'utf8');
    assert.doesNotMatch(source, /npm run deploy|wrangler\s+deploy|CLOUDFLARE_|secrets\./i,
      'Publication must be performed locally by Codex, not by GitHub Actions.');
  }
  const jobNames = [...workflow.split('jobs:')[1].matchAll(/^  ([\w-]+):$/gm)].map(match => match[1]);
  assert.deepEqual(jobNames, ['verify']);
});
