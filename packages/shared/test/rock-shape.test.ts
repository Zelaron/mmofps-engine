import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rockProfile, sdBoulder } from '../src/rock-shape.js';
import { MAT, World, type Region } from '../src/worldgen.js';

test('fractured rocks stay within placement bounds and retain broad ground support', () => {
  for (const variation of [0, 0.2, 0.35, 0.5, 0.8, 1]) {
    assert.ok(rockProfile(0, 0, 0, variation) < -0.25);
    assert.equal(rockProfile(0, -1, 0, variation), 0);
    for (let a = -1.4; a <= 1.4; a += 0.2) {
      for (let b = -1.4; b <= 1.4; b += 0.2) {
        assert.ok(rockProfile(1.001, a, b, variation) > 0);
        assert.ok(rockProfile(-1.001, a, b, variation) > 0);
        assert.ok(rockProfile(a, b, 1.001, variation) > 0);
        assert.ok(rockProfile(a, b, -1.001, variation) > 0);
        assert.ok(rockProfile(a, -1.001, b, variation) > 0);
        assert.ok(rockProfile(a, 1.001, b, variation) > 0);
      }
    }
    for (const x of [-0.25, 0, 0.25]) {
      for (const z of [-0.25, 0, 0.25]) {
        assert.ok(rockProfile(x, -0.99, z, variation) < 0,
          'a broad flat base must remain embedded in the supporting terrain');
      }
    }
    assert.ok(rockProfile(0.85, 0.8, 0.85, variation) > 0,
      'upper corners must be broken away instead of resembling rounded boxes');
  }
});

test('fractured rock field is finite and conservative under nonuniform world scales', () => {
  const rock = { x: 17, y: 12, z: -6, hx: 2.8, hy: 0.72, hz: 1.8 };
  const epsilon = 0.0001;
  for (let i = 0; i < 1600; i++) {
    const x = rock.x + Math.sin(i * 1.72) * 4;
    const y = rock.y + Math.sin(i * 0.97) * 2;
    const z = rock.z + Math.cos(i * 2.36) * 3;
    const d = sdBoulder(x, y, z, rock);
    assert.ok(Number.isFinite(d));
    const dx = (sdBoulder(x + epsilon, y, z, rock) - d) / epsilon;
    const dy = (sdBoulder(x, y + epsilon, z, rock) - d) / epsilon;
    const dz = (sdBoulder(x, y, z + epsilon, rock) - d) / epsilon;
    assert.ok(Math.hypot(dx, dy, dz) <= 1.001,
      'distance gradient must not overstep a surface during collision traces');
  }
  assert.ok(Math.abs(sdBoulder(rock.x, rock.y - rock.hy, rock.z, rock)) < 1e-12);
  assert.notEqual(rockProfile(0.6, 0.8, 0, 0), rockProfile(-0.6, 0.8, 0, 0),
    'the sloping broken cap must make opposite shoulders visibly asymmetric');
});

test('canonical collision and mesher material use the same fractured rock silhouette', () => {
  const world = new World(1337);
  const col = world.column(120, 125);
  const rock = { x: 120, y: col.h + 20, z: 125, hx: 2, hy: 1.3, hz: 1.7, r: 0.6 };
  const region: Region = { sites: [], pads: [], solids: [], cuts: [], vegetation: [], boulders: [rock] };
  for (const offset of [[0, 0, 0], [0, 0.76, 0], [0.7, 0.8, 0.7], [-0.5, 0.4, -0.8]]) {
    const x = rock.x + offset[0] * rock.hx;
    const y = rock.y + offset[1] * rock.hy;
    const z = rock.z + offset[2] * rock.hz;
    assert.equal(world.sdfCol(x, y, z, col, region), sdBoulder(x, y, z, rock));
  }
  assert.equal(world.material(rock.x, rock.y + rock.hy * 0.76, rock.z, col, 1, region),
    col.volc > 0.4 ? MAT.BASALT : MAT.ROCK);
});
