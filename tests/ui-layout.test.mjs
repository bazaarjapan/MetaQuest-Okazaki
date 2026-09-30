import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextPanel, panelIds } from '../src/ui-layout.js';
test('compact tabs are fixed and keyboard navigation wraps both directions', () => {
  assert.deepEqual(panelIds, ['observe', 'region', 'settings']);
  assert.equal(nextPanel('observe', -1), 'settings');
  assert.equal(nextPanel('settings', 1), 'observe');
  assert.equal(nextPanel('region', 1), 'settings');
  assert.equal(nextPanel('bad', 1), 'region');
});
