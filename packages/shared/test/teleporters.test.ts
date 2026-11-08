import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/worldgen.js';
import { generateTeleporters } from '../src/teleporters.js';
import { generateEncounterRegion } from '../src/encounters.js';

test('teleporter network is deterministic and structurally sound', () => {
  const world = new World(1337);
  const pads = generateTeleporters(world);

  assert.ok(pads.length >= 24, `expected a dense network, got ${pads.length} pads`);
  assert.equal(pads.filter(p => !p.cave).length, 9, 'surface access is one quarter of the previous36 pads');

  let caveLinks = 0;
  for (let i = 0; i < pads.length; i++) {
    const pad = pads[i];
    const partner = pads[pad.partner];
    assert.ok(partner && pad.partner !== i, 'directed destinations must exist and never self-link');
    assert.ok(!(pad.cave && partner.cave), 'no cave<->cave pairs exist');
    if (pad.cave || partner.cave) caveLinks++;

    const col = world.column(pad.x, pad.z);
    if (pad.cave) {
      assert.ok(world.roofedAbove(pad.x, pad.y + 1.6, pad.z),
        'cave pads sit under a rock roof');
      assert.ok(pad.y < col.h - 6, 'cave pads are genuinely below the surface');
      assert.ok(world.sdf(pad.x, pad.y + 1.2, pad.z) > 0,
        'cave pads have standing air above them');
    } else {
      assert.ok(Math.abs(pad.y - col.h) <= 1.2, 'surface pads sit on the terrain');
      assert.ok(!world.roofedAbove(pad.x, pad.y + 1.6, pad.z),
        'surface pads are under open sky');
    }
  }
  assert.ok(caveLinks >= 16, 'the network is dense with cave escape routes');
  assert.equal(pads.filter(p => p.cave).length, 28, 'shared surface anchors preserve underground lifelines');

  const again = generateTeleporters(new World(1337));
  assert.deepEqual(again, pads, 'generation is seed-deterministic');
});

test('surface pads and their weapon drops are never placed under water', () => {
  const world = new World(1337);
  const dry = (p: { x: number; y: number; z: number }) => !world.liquidAt(p.x, p.y + .05, p.z);
  // These coastal districts used to put pads and drops on the seabed.
  for (const [cx, cz] of [[-8, -9], [1, -9], [-9, -7]]) {
    const it = generateEncounterRegion(world, cx, cz);
    let step = it.next(); while (!step.done) step = it.next();
    const surface = [...step.value.pads, ...step.value.loot].filter(p => !p.cave);
    assert.ok(surface.length > 0, `district ${cx},${cz} keeps its surface access`);
    for (const p of surface) assert.ok(dry(p), `dry footing at ${Math.round(p.x)},${Math.round(p.z)}`);
  }
  for (const pad of generateTeleporters(world)) if (!pad.cave) assert.ok(dry(pad));
});
