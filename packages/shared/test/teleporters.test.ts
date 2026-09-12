import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/worldgen.js';
import { generateTeleporters } from '../src/teleporters.js';

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
