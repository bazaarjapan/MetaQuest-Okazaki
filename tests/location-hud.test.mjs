import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formatLocation, createLocationHud } from '../src/location-hud.js';

const station = JSON.parse(readFileSync(new URL('../public/city/manifest.json', import.meta.url))).station;
const position = (x, z) => ({ x: station[0] + x, z: station[2] + z });

test('uses the actual station offset and world axes, not a camera heading', () => {
  assert.equal(formatLocation(position(120, -80), station), '東 120 m ／ 北 80 m');
  assert.equal(formatLocation(position(-120, 80), station), '西 120 m ／ 南 80 m');
  assert.equal(formatLocation(position(0, 0), station), 'JR岡崎駅付近');
  assert.equal(formatLocation(position(0.1, -500), station), '東西 0 m ／ 北 500 m');
  assert.equal(formatLocation(position(-500, -0.1), station), '西 500 m ／ 南北 0 m');
});
test('rounds metres, switches to kilometres and rejects unavailable coordinates', () => {
  assert.equal(formatLocation(position(999.6, -12456), station), '東 1.00 km ／ 北 12.46 km');
  assert.equal(formatLocation(position(999.4, -5), station), '東 999 m ／ 北 5 m');
  assert.equal(formatLocation({ x: NaN, z: 0 }, station), null);
  assert.equal(formatLocation({ x: 0, z: Infinity }, station), null);
  assert.equal(formatLocation(position(1, 1), null), null);
});
test('updates at 5 Hz, hides immediately on logout/XR, and retains VR text', () => {
  const element = { hidden: true }, detail = { textContent: '' };
  const hud = createLocationHud(element, detail);
  let calls = 0, current = position(120, -80);
  const update = (time, extra = {}) => hud.update({ time, active: true, xr: false,
    getPosition: () => { calls++; return current; }, station, ...extra });
  update(0);
  assert.deepEqual(hud.getState(), { text: '東 120 m ／ 北 80 m', visible: true });
  current = position(-300, 200);
  update(100); assert.equal(calls, 1);
  update(200); assert.equal(detail.textContent, '西 300 m ／ 南 200 m');
  update(210, { xr: true }); assert.equal(element.hidden, true);
  assert.equal(hud.getState().text, '西 300 m ／ 南 200 m');
  update(220); assert.equal(element.hidden, false);
  update(230, { active: false });
  assert.deepEqual(hud.getState(), { text: '', visible: false });
  current = position(10000, -5); update(240);
  assert.equal(detail.textContent, '東 10.00 km ／ 北 5 m');
});
test('missing station metadata never invents a location', () => {
  const element = { hidden: false }, detail = {};
  const hud = createLocationHud(element, detail);
  hud.update({ time: 0, active: true, station: null, getPosition: () => position(1, 1) });
  assert.equal(element.hidden, true);
});
