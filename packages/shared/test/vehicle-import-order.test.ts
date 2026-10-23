import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { buildSync } from 'esbuild';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const source = (name: string) => new URL(`../src/${name}.ts`, import.meta.url).href;
const fixture = new URL('./vehicle-collision-fixture.ts', import.meta.url).href;

// The same analytic-world fixture as vehicle-collision.test.ts verifies more
// than successful import: CJS bundling can turn an early constant into
// undefined and silently prepare a NaN hull instead of throwing an ESM TDZ.
const probe = `
for (const key of ['VEHICLE', 'VEHICLE_VARIANT', 'validVehicleVariant', 'NOCTURNE_SCALE'])
  assert.equal(vehicles[key], identity[key], 'public vehicle export identity: ' + key);
assert.equal(vehicles.NOCTURNE_SCALE, 2.2);
const world = vehicleCollisionWorld(new World(1337), -100);
setVehicleColliders(world, 0, [{ id: 1, type: vehicles.VEHICLE.JET,
  variant: vehicles.VEHICLE_VARIANT.NOCTURNE, x: 0, y: 0, z: 0, heading: 0, health: 100 }]);
const foot = createMoveState(0, .02, 8);
withVehicleColliders(world, foot, 1 / 60, () => {
  const inside = world.sdf(0, 2.7, -1.2), bay = world.sdf(6.6, 2.8, -3.3);
  assert.ok(Number.isFinite(inside) && Math.abs(inside + .874) < 1e-12,
    'canonical scaled fuselage distance: ' + inside);
  assert.ok(Number.isFinite(bay) && bay > .5, 'crescent bay stays open: ' + bay);
});
assert.equal(world.pedestrianCollisions, undefined);
`;

const esmProbe = `
await import(process.argv[1]);
const { default: assert } = await import('node:assert/strict');
const vehicles = await import(${JSON.stringify(source('vehicles'))});
const identity = await import(${JSON.stringify(source('vehicle-identity'))});
const { World } = await import(${JSON.stringify(source('worldgen'))});
const { createMoveState } = await import(${JSON.stringify(source('movement'))});
const { setVehicleColliders, withVehicleColliders } = await import(${JSON.stringify(source('vehicle-collision'))});
const { vehicleCollisionWorld } = await import(${JSON.stringify(fixture)});
${probe}`;

// Each route gets a fresh native ESM module graph. Importing them sequentially
// in this test's process would hide an ordering bug after the first route.
for (const name of ['vehicles', 'vehicle-collision', 'physics-air', 'physics', 'worldgen', 'movement', 'lifts', 'vesper-city', 'bot-walk-clearance']) {
  test(`vehicle collision initializes from a fresh ${name} ESM entry`, () => {
    const entry = name === 'bot-walk-clearance'
      ? new URL('../../server/src/bot-walk-clearance.ts', import.meta.url).href : source(name);
    const child = spawnSync(process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', esmProbe, entry],
      { cwd: root, encoding: 'utf8', timeout: 20_000 });
    assert.equal(child.error, undefined);
    assert.equal(child.signal, null);
    assert.equal(child.status, 0, `${name}: ${child.stderr}\n${child.stdout}`);
  });
}

test('bundled CommonJS vehicle-first entry retains finite canonical Nocturne geometry', () => {
  const bundled = buildSync({ stdin: { resolveDir: root, loader: 'ts', contents: `
import * as vehicles from './packages/shared/src/vehicles.ts';
import * as identity from './packages/shared/src/vehicle-identity.ts';
import assert from 'node:assert/strict';
import { World } from './packages/shared/src/worldgen.ts';
import { createMoveState } from './packages/shared/src/movement.ts';
import { setVehicleColliders, withVehicleColliders } from './packages/shared/src/vehicle-collision.ts';
import { vehicleCollisionWorld } from './packages/shared/test/vehicle-collision-fixture.ts';
${probe}` }, bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent' });
  runInNewContext(bundled.outputFiles[0].text, { require: createRequire(import.meta.url),
    module: { exports: {} }, exports: {}, structuredClone, performance });
});
