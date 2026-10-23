import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { World } from '@shared/worldgen';
import { EncounterField, type CavePOI } from '@shared/encounters';
import type { TeleporterPad } from '@shared/teleporters';
import { EncounterStream, type EncounterWorkerEndpoint, type EncounterWorkerRequest,
  type EncounterWorkerState } from '../src/render/encounter-stream.js';

const base: TeleporterPad[] = [{ x: 0, y: 10, z: 0, cave: false, partner: 1 },
  { x: 4, y: -20, z: 8, cave: true, partner: 0 }];
class FakeWorker implements EncounterWorkerEndpoint {
  onmessage: EncounterWorkerEndpoint['onmessage'] = null;
  onerror: EncounterWorkerEndpoint['onerror'] = null;
  onmessageerror: EncounterWorkerEndpoint['onmessageerror'] = null;
  messages: EncounterWorkerRequest[] = [];
  terminated = false;
  postMessage(message: EncounterWorkerRequest) { this.messages.push(message); }
  terminate() { this.terminated = true; }
  emit(message: EncounterWorkerState) { this.onmessage?.({ data: message } as MessageEvent<EncounterWorkerState>); }
}

test('encounter startup gate retains base pads and selects only the latest position when released', () => {
  let terrainReady = false;
  const worker = new FakeWorker(), stream = new EncounterStream(1337, base, () => worker, () => terrainReady);
  try {
    stream.update([{ x: 1, z: 2 }]);
    stream.update([{ x: 1200, z: 4 }]);
    assert.equal(worker.messages.length, 1, 'cold regional generation waits for terrain');
    assert.deepEqual(stream.pads, base, 'authoritative base transport remains immediately available');
    terrainReady = true; stream.update([{ x: 2300, z: 4 }]);
    assert.deepEqual(worker.messages[1], { type: 'select', request: 1, points: [{ x: 2560, z: 512 }] });
    stream.update([{ x: 2301, z: 4 }]);
    assert.equal(worker.messages.length, 2);
  } finally { stream.dispose(); }
});

test('encounter stream sends district changes only and rejects stale background selections', () => {
  const worker = new FakeWorker(), stream = new EncounterStream(1337, base, () => worker);
  assert.deepEqual(stream.pads, base, 'base transport is available before any worker result');
  assert.deepEqual(worker.messages, [{ type: 'init', seed: 1337, base }]);
  stream.update([{ x: 1, z: 2 }, { x: 600, z: 900 }]);
  for (let i = 0; i < 100; i++) stream.update([{ x: 900 - i, z: i }]);
  assert.equal(worker.messages.length, 2, 'ordinary frame movement does not flood the worker');
  stream.update([{ x: 1200, z: 4 }]);
  assert.deepEqual(worker.messages[2], { type: 'select', request: 2, points: [{ x: 1536, z: 512 }] });
  const stats = { cached: 2, wanted: 9, pending: '1,0' };
  worker.emit({ type: 'state', request: 1, revision: 4, stats, pads: [] });
  assert.deepEqual(stream.pads, base, 'a late old region cannot overwrite the current selection');
  const pads = [...base, { x: 1200, y: 5, z: 0, cave: false, partner: 3 },
    { x: 1210, y: -30, z: 0, cave: true, partner: 2 }];
  const p = { x: 1200, y: -30, z: 0 };
  const pois: CavePOI[] = [{ ...p, id: '1,0:landmark', regionKey: '1,0', cave: true, kind: 'vault', weapon: 6,
    loot: { ...p, x: 1207, id: '1,0:loot', weapon: 6, cave: true }, returnPad: p,
    returnTarget: { ...p, y: 30 }, props: [] }];
  worker.emit({ type: 'state', request: 2, revision: 5, stats, pads, pois });
  assert.deepEqual(stream.pads, pads);
  assert.equal(stream.update([{ x: 1300, z: 20 }]), true);
  assert.equal(stream.update([{ x: 1301, z: 20 }]), false);
  worker.emit({ type: 'state', request: 2, revision: 5, stats: { ...stats, pending: null } });
  assert.equal(stream.revision, 1, 'progress reports do not rebuild GPU pad lists');
  assert.deepEqual(stream.pois, pois, 'stats-only progress must preserve loaded discoveries');
  const late = worker.onmessage;
  stream.dispose(); stream.dispose();
  late?.({ data: { type: 'state', request: 2, revision: 6, stats, pads: [] } } as unknown as MessageEvent<EncounterWorkerState>);
  assert.deepEqual(stream.pads, pads);
  assert.equal(worker.terminated, true);
  assert.equal(stream.update([{ x: 9000, z: 0 }]), false);
});

test('unavailable or failed encounter workers retain existing transport without foreground world generation', () => {
  const original = EncounterField.prototype.update;
  EncounterField.prototype.update = () => { throw new Error('foreground generation is forbidden'); };
  try {
    const unavailable = new EncounterStream(1, base, () => { throw new Error('worker unavailable'); });
    for (let i = 0; i < 100; i++) unavailable.update([{ x: i * 1024, z: 0 }]);
    assert.deepEqual(unavailable.pads, base);
    assert.equal(unavailable.stats.failed, true);
    const worker = new FakeWorker(), stream = new EncounterStream(1, base, () => worker);
    worker.onerror?.({} as ErrorEvent);
    stream.update([{ x: 4096, z: 4096 }]);
    assert.deepEqual(stream.pads, base);
    assert.equal(worker.terminated, true);
    assert.equal(stream.stats.worker, false);
    stream.dispose(); unavailable.dispose();
  } finally { EncounterField.prototype.update = original; }
});

test('encounter cold slices earn local rest that newer selections cannot bypass, while remote cadence stays unchanged', async () => {
  const result = await build({ entryPoints: [fileURLToPath(new URL('../src/render/encounters.worker.ts', import.meta.url))],
    bundle: true, format: 'iife', platform: 'browser', target: 'es2020', write: false, logLevel: 'silent',
    plugins: [{ name: 'measured-cold-encounter', setup(plugin) {
      plugin.onLoad({ filter: /[/\\]shared[/\\]src[/\\]encounters\.ts$/ }, () => ({ loader: 'js', contents: `
        export class EncounterField {
          revision = 0; regions = []; pois = [];
          stats = { cached: 0, wanted: 1, pending: 'cold' };
          constructor(world, base) { this.pads = base; }
          update(points, budget, steps) {
            globalThis.recordSlice(points, budget, steps);
            this.revision++;
            if (this.revision >= 2) {
              this.regions = [{}]; this.stats = { cached: 1, wanted: 1, pending: null };
            }
          }
        }` }));
    } }] });
  for (const hostname of ['localhost', 'game.example']) {
    let now = 0, timerId = 0;
    const pending = new Map<number, { callback: () => void; due: number }>();
    const messages: EncounterWorkerState[] = [], calls: { points: unknown; budget: number; steps: number }[] = [];
    const self = { onmessage: null as ((event: { data: EncounterWorkerRequest }) => void) | null,
      postMessage: (message: EncounterWorkerState) => messages.push(structuredClone(message)) };
    runInNewContext(result.outputFiles[0].text, { self, location: { hostname }, performance: { now: () => now },
      recordSlice: (points: unknown, budget: number, steps: number) => {
        calls.push({ points: structuredClone(points), budget, steps }); now += 100;
      },
      setTimeout: (callback: () => void, delay: number) => {
        pending.set(++timerId, { callback, due: now + delay }); return timerId;
      }, clearTimeout: (id: number) => pending.delete(id) });
    const send = (data: EncounterWorkerRequest) => self.onmessage!({ data });
    const runNext = () => {
      assert.equal(pending.size, 1);
      const [id, timer] = pending.entries().next().value!;
      pending.delete(id); now = timer.due; timer.callback();
    };
    send({ type: 'init', seed: 1337, base });
    send({ type: 'select', request: 1, points: [{ x: 1, z: 1 }] });
    assert.equal(pending.values().next().value!.due, 8, 'first selection keeps its original eight-ms wake');
    runNext();
    assert.equal(now, 108);
    const rest = hostname === 'localhost' ? 300 : 8;
    const deadline = 108 + rest;
    assert.equal(pending.values().next().value!.due, deadline, 'rest accounts for the entire cold overrun');
    now++;
    send({ type: 'select', request: 2, points: [{ x: 2, z: 2 }] });
    send({ type: 'select', request: 3, points: [{ x: 3, z: 3 }] });
    assert.equal(pending.size, 1);
    assert.equal(pending.values().next().value!.due, deadline, 'travel cannot reset the existing rest deadline');
    runNext();
    assert.deepEqual(calls, [
      { points: [{ x: 1, z: 1 }], budget: 4, steps: 12 },
      { points: [{ x: 3, z: 3 }], budget: 4, steps: 12 },
    ], 'the generator retains its canonical limits and receives the newest selection');
    assert.equal(messages.at(-1)!.request, 3);
    assert.equal(pending.size, 0, 'completed districts go idle');
    const completedAt = now;
    now++;
    send({ type: 'select', request: 4, points: [] });
    assert.ok(pending.values().next().value!.due >= completedAt + rest,
      'a new selection also respects the last completed slice\'s rest');
    send({ type: 'init', seed: 7331, base });
    assert.equal(pending.size, 0, 'world replacement cancels the old rest timer');
    send({ type: 'select', request: 1, points: [{ x: 9, z: 9 }] });
    assert.equal(pending.values().next().value!.due, now + 8, 'the replacement world starts with a fresh deadline');
  }
});

test('bundled encounter worker coalesces travel, yields between slices and matches canonical pads', async () => {
  const result = await build({ entryPoints: [fileURLToPath(new URL('../src/render/encounters.worker.ts', import.meta.url))],
    bundle: true, format: 'iife', platform: 'browser', target: 'es2020', write: false, logLevel: 'silent' });
  let now = 0, timerId = 0;
  const pending = new Map<number, () => void>(), messages: EncounterWorkerState[] = [];
  const self: { onmessage: ((event: { data: EncounterWorkerRequest }) => void) | null; postMessage: (message: EncounterWorkerState) => void } = {
    onmessage: null, postMessage: message => messages.push(structuredClone(message)),
  };
  runInNewContext(result.outputFiles[0].text, { self, performance: { now: () => now },
    setTimeout: (callback: () => void) => { pending.set(++timerId, callback); return timerId; },
    clearTimeout: (id: number) => pending.delete(id) });
  self.onmessage!({ data: { type: 'init', seed: 1337, base } });
  self.onmessage!({ data: { type: 'select', request: 1, points: [{ x: 512, z: 512 }] } });
  self.onmessage!({ data: { type: 'select', request: 2, points: [{ x: 8192, z: 8192 }] } });
  assert.equal(pending.size, 1, 'rapid travel coalesces into one scheduled background slice');
  let turns = 0;
  while (pending.size) {
    assert.equal(pending.size, 1, 'one worker cannot accumulate a generation timer backlog');
    const [id, callback] = pending.entries().next().value!;
    pending.delete(id); now += 8; callback();
    assert.ok(++turns < 3000, 'bounded district work must eventually go idle');
  }
  assert.ok(turns > 1, 'district generation is split across multiple event-loop turns');
  assert.ok(messages.every(message => message.request === 2), 'obsolete positions are discarded before generation');
  const final = messages.filter(message => message.pads).at(-1)!;
  assert.ok(final.pads!.length > base.length, 'the real worker must generate usable regional transport');
  const canonical = new EncounterField(new World(1337), base);
  for (let i = 0; i < 3000; i++) {
    canonical.update([{ x: 8192, z: 8192 }], Infinity, 12);
    if (canonical.stats.pending === null && canonical.regions.length === canonical.stats.wanted) break;
  }
  assert.deepEqual(final.pads, canonical.pads, 'client background generation matches authoritative pad destinations');
  assert.deepEqual(final.pois, canonical.pois, 'landmarks and their reward IDs match authoritative generation');
  self.onmessage!({ data: { type: 'select', request: 3, points: [] } });
  assert.equal(pending.size, 1, 'an idle worker wakes for new selection');
  const [id, callback] = pending.entries().next().value!;
  pending.delete(id); now += 8; callback();
  assert.equal(pending.size, 0);
  assert.deepEqual(messages.at(-1)!.pads, base, 'leaving all active districts releases regional pad data');
  assert.deepEqual(messages.at(-1)!.pois, []);
});
