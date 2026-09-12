import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cityThemeInfluence, CITY_THEME_INNER_SCALE, CITY_THEME_FADE_METRES, type CityThemeSite } from '../src/city-themes.js';

const cities: CityThemeSite[] = [
  { x: 0, y: 20, z: 0, radius: 384 },
  { x: -4096, y: 35, z: -4096, radius: 384, theme: 'vesper' },
  { x: 5120, y: 50, z: 5120, radius: 384, theme: 'aurelia' },
];

test('ordinary cities and distant wilderness retain the original environment', () => {
  assert.deepEqual(cityThemeInfluence(cities, 0, 20, 0), { vesper: 0, aurelia: 0 });
  assert.deepEqual(cityThemeInfluence(cities, 2000, 20, 1000), { vesper: 0, aurelia: 0 });
  assert.deepEqual(cityThemeInfluence(cities, -4096, 40, -4096), { vesper: 1, aurelia: 0 });
  assert.deepEqual(cityThemeInfluence(cities, 5120, 60, 5120), { vesper: 0, aurelia: 1 });
  assert.deepEqual(cityThemeInfluence(cities, NaN, 0, 0), { vesper: 0, aurelia: 0 });
});

test('capital approach and high-altitude departure blend continuously without step boundaries', () => {
  const c = cities[1], inner = c.radius * CITY_THEME_INNER_SCALE, outer = inner + CITY_THEME_FADE_METRES;
  let previous = 1;
  for (let d = inner - 2; d <= outer + 2; d += 1) {
    const w = cityThemeInfluence(cities, c.x + d, c.y, c.z).vesper;
    assert.ok(w <= previous + 1e-10 && previous - w < .003);
    previous = w;
  }
  assert.equal(previous, 0);
  assert.equal(cityThemeInfluence(cities, c.x, c.y + 320, c.z).vesper, 1);
  assert.equal(cityThemeInfluence(cities, c.x, c.y + 1200, c.z).vesper, 0);
  assert.ok(cityThemeInfluence(cities, c.x, c.y + 600, c.z).vesper > .5);
  assert.equal(cityThemeInfluence(cities, c.x, c.y - 150, c.z).vesper, 1,
    'an underground camera still sees the correct exterior sky through a cave exit');
});

test('overlapping themes remain normalized and queries reuse a supplied scratch object', () => {
  const overlap = [{ ...cities[1], x: 0, z: 0 }, { ...cities[2], x: 0, z: 0 }];
  const out = { vesper: 9, aurelia: -5 };
  assert.equal(cityThemeInfluence(overlap, 0, 50, 0, out), out);
  assert.deepEqual(out, { vesper: .5, aurelia: .5 });
  assert.deepEqual(cityThemeInfluence([], 0, 50, 0, out), { vesper: 0, aurelia: 0 });
});
