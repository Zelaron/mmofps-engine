import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CREATURE, CREATURE_DEFS, PLANET_ECOLOGIES, ecologyForWorld, ecologyCandidates, chooseEcologyEntry } from '@shared/wildlife';

test('planet ecology keeps undead local to Meridian and unknown worlds use a native roster', () => {
  assert.equal(ecologyForWorld(1337).id, 'meridian'); assert.equal(ecologyForWorld(7331).id, 'cinder');
  assert.equal(ecologyForWorld(20077).id, 'nacre'); assert.equal(ecologyForWorld(987654).id, 'native');
  assert.equal(ecologyForWorld(987654, 'cinder').id, 'cinder');
  assert.ok(PLANET_ECOLOGIES.meridian.roster.filter(e => CREATURE_DEFS[e.species].undead).length >= 4);
  for (const id of ['cinder', 'nacre', 'native']) assert.ok(PLANET_ECOLOGIES[id].roster.every(e => !CREATURE_DEFS[e.species].undead));
  for (const ecology of Object.values(PLANET_ECOLOGIES)) for (const entry of ecology.roster) {
    assert.ok(CREATURE_DEFS[entry.species]); assert.ok(entry.weight > 0);
    assert.ok(entry.group[0] > 0 && entry.group[0] <= entry.group[1] && entry.group[1] <= 5);
  }
});

test('habitat selection reserves coastal and volcanic bosses for suitable dry terrain', () => {
  const plain = { h: 20, temp: .5, volc: 0 };
  assert.ok(!ecologyCandidates(PLANET_ECOLOGIES.nacre, 'surface', plain, false).some(e => e.species === CREATURE.TIDE_BEHEMOTH));
  assert.ok(ecologyCandidates(PLANET_ECOLOGIES.nacre, 'surface', plain, true).some(e => e.species === CREATURE.TIDE_BEHEMOTH));
  assert.ok(!ecologyCandidates(PLANET_ECOLOGIES.nacre, 'surface', { ...plain, h: 120 }, true).some(e => e.species === CREATURE.TIDE_BEHEMOTH));
  assert.ok(!ecologyCandidates(PLANET_ECOLOGIES.cinder, 'surface', plain).some(e => e.species === CREATURE.CINDER_COLOSSUS));
  assert.ok(ecologyCandidates(PLANET_ECOLOGIES.cinder, 'surface', { ...plain, volc: .8 }).some(e => e.species === CREATURE.CINDER_COLOSSUS));
  assert.ok(ecologyCandidates(PLANET_ECOLOGIES.meridian, 'cave', plain).every(e => CREATURE_DEFS[e.species].cave));
  assert.equal(chooseEcologyEntry([], .5), undefined);
});

test('rare boss encounters remain a small deterministic share of each suitable habitat', () => {
  for (const id of ['meridian', 'cinder', 'nacre']) {
    const entries = ecologyCandidates(PLANET_ECOLOGIES[id], 'surface', { h: 20, temp: .5, volc: .8 }, true);
    let bosses = 0, hostile = 0;
    for (let i = 0; i < 10000; i++) {
      const entry = chooseEcologyEntry(entries, i / 10000)!;
      if (CREATURE_DEFS[entry.species].boss) bosses++;
      if (CREATURE_DEFS[entry.species].damage) hostile++;
    }
    assert.ok(bosses > 50 && bosses < 400, id + ': bosses are rare team encounters');
    assert.ok(hostile > 4500, id + ': exploration contains frequent local threats');
  }
});
