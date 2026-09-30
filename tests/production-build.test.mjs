import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkProductionBuild } from '../scripts/check-production-build.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'okazaki-production-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('production check traverses nested chunks and accepts normal JavaScript', async t => {
  const directory = await fixture(t);
  await mkdir(join(directory, 'assets'));
  await writeFile(join(directory, 'assets', 'app.js'), 'console.log("city");');
  await writeFile(join(directory, 'assets', 'chunk.mjs'), 'export const ready = true;');
  // Manuals and binary model data are not executable chunks.
  await writeFile(join(directory, 'teacher.html'), 'Developer guide: testxr');
  assert.deepEqual(await checkProductionBuild(directory), { passed: true, checkedJavaScriptFiles: 2 });
});

for (const marker of ['IWER', 'testxr', '__xrTestDevice']) {
  test(`production check rejects ${marker} in JavaScript`, async t => {
    const directory = await fixture(t);
    await writeFile(join(directory, 'app.js'), `const forbidden = "${marker}";`);
    await assert.rejects(checkProductionBuild(directory), /must not ship/);
  });
}

test('production check also rejects emulation markers in source maps', async t => {
  const directory = await fixture(t);
  await writeFile(join(directory, 'app.js'), 'console.log("city");');
  await writeFile(join(directory, 'app.js.map'), '{"sourcesContent":["import IWER"]}');
  await assert.rejects(checkProductionBuild(directory), /must not ship/);
});

test('production check fails if the build directory is missing', async t => {
  const directory = await fixture(t);
  await assert.rejects(checkProductionBuild(join(directory, 'missing')), { code: 'ENOENT' });
});

test('production check fails if there are no JavaScript chunks', async t => {
  const directory = await fixture(t);
  await writeFile(join(directory, 'index.html'), '<html></html>');
  await assert.rejects(checkProductionBuild(directory), /No production JavaScript/);
});

test('source maps alone do not count as a JavaScript build', async t => {
  const directory = await fixture(t);
  await writeFile(join(directory, 'app.js.map'), '{"sourcesContent":[]}');
  await assert.rejects(checkProductionBuild(directory), /No production JavaScript/);
});
