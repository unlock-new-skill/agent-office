import assert from 'node:assert/strict';
import test from 'node:test';
import { currentHour, lightingAt } from '../../src/client/map3d/day-night.js';

test('noon is full day with a high sun; midnight is night with lamps on', () => {
  const noon = lightingAt(12); const midnight = lightingAt(0);
  assert.equal(noon.daylight, 1);
  assert.ok(noon.sunElevation > 1.1);
  assert.ok(noon.lampIntensity < 0.2);
  assert.equal(midnight.daylight, 0);
  assert.equal(midnight.lampIntensity, 1);
  assert.ok(midnight.sunIntensity < noon.sunIntensity);
});

test('sunrise and sunset fade in and out; the sun moves east to west; low sun is warmer', () => {
  assert.ok(lightingAt(6).daylight > 0 && lightingAt(6).daylight < 1);
  assert.ok(lightingAt(18).daylight > 0 && lightingAt(18).daylight < 1);
  assert.ok(lightingAt(9).sunAzimuth < lightingAt(15).sunAzimuth);
  const red = (color: number): number => (color >> 16) & 255; const blue = (color: number): number => color & 255;
  assert.ok(red(lightingAt(17).sunColor) - blue(lightingAt(17).sunColor) > red(lightingAt(12).sunColor) - blue(lightingAt(12).sunColor));
  assert.deepEqual(lightingAt(25), lightingAt(1), 'hours wrap');
});

test('?hour= overrides the clock for previews', () => {
  assert.equal(currentHour('?hour=21.5'), 21.5);
  assert.equal(currentHour('?hour=-2'), 22);
  const real = currentHour('');
  assert.ok(real >= 0 && real < 24);
});
