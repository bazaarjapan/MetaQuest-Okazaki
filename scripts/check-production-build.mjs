import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

export async function checkProductionBuild(directory = 'dist') {
  const files = [];
  async function walk(root) {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (/\.(?:js|mjs|cjs|map)$/i.test(entry.name)) files.push(path);
    }
  }
  await walk(directory);
  assert.ok(files.some(path => /\.(?:js|mjs|cjs)$/i.test(path)),
    'No production JavaScript found. Run npm run build first.');
  for (const path of files) {
    const source = await readFile(path, 'utf8');
    assert.doesNotMatch(source, /iwer|testxr|__xrTestDevice/i,
      `XR development/emulation code must not ship: ${path}`);
  }
  return { passed: true, checkedJavaScriptFiles: files.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await checkProductionBuild(process.argv[2])));
}
