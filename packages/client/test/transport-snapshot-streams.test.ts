import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { World } from '@shared/worldgen';
import { TRANSPORT_SNAPSHOT_VERSION, type TransportSnapshot } from '@shared/transport';
import { ChunkManager } from '../src/render/chunks.js';
import { SceneryStream } from '../src/render/scenery-stream.js';
import { EncounterStream } from '../src/render/encounter-stream.js';
import { WorldMapStream } from '../src/world-map-stream.js';

function snapshot(seed: number): TransportSnapshot {
  return { version: TRANSPORT_SNAPSHOT_VERSION, seed, plan: { stations: [], harbors: [], routes: [], solids: [],
    lifts: [], bridges: [], accesses: [], pods: [{ id: 1, stationId: 1, name: `Planet ${seed}`, x: seed, y: 0, z: 0 }] } };
}
class Endpoint {
  onmessage: ((event: any) => unknown) | null = null;
  onerror: ((event: any) => unknown) | null = null;
  onmessageerror: ((event: any) => unknown) | null = null;
  messages: any[] = [];
  terminated = false;
  postMessage(message: unknown): void { this.messages.push(structuredClone(message)); }
  terminate(): void { this.terminated = true; }
}

test('seed-specific snapshots are cloned only on initialization and retained through deferred scenery and map startup', () => {
  for (const seed of [1337, 7331]) {
    const data = snapshot(seed), sceneryWorker = new Endpoint(), encounterWorker = new Endpoint(), mapWorker = new Endpoint();
    const scenery = new SceneryStream(seed, () => sceneryWorker, true, data);
    const encounters = new EncounterStream(seed, [], () => encounterWorker, () => true, data);
    const map = new WorldMapStream(seed, 'overview', () => mapWorker, data);
    try {
      scenery.read('rocks', { minX: 0, maxX: 64, minZ: 0, maxZ: 64 });
      assert.equal(sceneryWorker.messages.length, 0);
      assert.equal(mapWorker.messages.length, 0);
      scenery.start(); map.start(); encounters.update([{ x: 0, z: 0 }]);
      for (const worker of [sceneryWorker, encounterWorker, mapWorker]) {
        assert.equal(worker.messages[0].seed, seed);
        assert.deepEqual(worker.messages[0].transportSnapshot, data);
        assert.notEqual(worker.messages[0].transportSnapshot.plan, data.plan, 'postMessage owns an isolated plan');
        for (const message of worker.messages.slice(1)) assert.ok(!('transportSnapshot' in message),
          'mesh/scenery/selection work must not repeatedly copy the startup plan');
      }
      sceneryWorker.messages[0].transportSnapshot.plan.pods[0].x++;
      assert.deepEqual(encounterWorker.messages[0].transportSnapshot, data);
      assert.deepEqual(mapWorker.messages[0].transportSnapshot, data);
    } finally { scenery.dispose(); encounters.dispose(); map.dispose(); }
  }
});

test('terrain replacement and watchdog workers reuse the snapshot while the main terrain World owns a separate plan', t => {
  const oldWorker = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: Endpoint });
  t.after(() => {
    if (oldWorker) Object.defineProperty(globalThis, 'Worker', oldWorker); else Reflect.deleteProperty(globalThis, 'Worker');
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const data = snapshot(1337), manager = new ChunkManager(1337, 1, 50, data);
  const internals = manager as unknown as { terrainWorld: World; workers: { worker: Endpoint; job: unknown }[];
    armWatchdog(slot: unknown, requestId: number): void };
  try {
    const slot = internals.workers[0], first = slot.worker;
    assert.deepEqual(first.messages[0].transportSnapshot, data);
    const plan = internals.terrainWorld.collectTransportPlan();
    assert.deepEqual(plan, data.plan); assert.notEqual(plan, data.plan);
    plan.pods[0].x++;
    assert.equal(data.plan.pods[0].x, 1337, 'emergency coverage cannot mutate retained restart payloads');
    first.onerror?.({ preventDefault() {} });
    assert.ok(first.terminated); assert.notEqual(slot.worker, first);
    assert.deepEqual(slot.worker.messages[0].transportSnapshot, data);
    const second = slot.worker;
    slot.job = { key: 'obsolete', requestId: 7 };
    internals.armWatchdog(slot, 7); t.mock.timers.tick(50);
    assert.ok(second.terminated); assert.notEqual(slot.worker, second);
    assert.deepEqual(slot.worker.messages[0].transportSnapshot, data);
    manager.dispose(); assert.ok(slot.worker.terminated);
  } finally { manager.dispose(); }
});
