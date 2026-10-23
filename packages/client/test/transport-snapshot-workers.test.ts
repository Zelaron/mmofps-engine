import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

// Real worker entrypoints/scheduler with cheap deterministic generators. The
// shared snapshot tests own geometric equality; this fixture verifies init,
// replacement and cancellation ownership without rebuilding entire planets.
const worldSource = `export class World {
  constructor(seed,snapshot) { this.seed=seed;this.snapshot=snapshot;globalThis.captureWorld(this); }
  collectTransportPlan() { return this.snapshot?.plan; }
}`;
const meshSource = `const bundle=world=>({chunks:[],portals:{positions:new Float32Array([world.seed])}});
  export function meshColumnWithPortals(world){return bundle(world);}
  export function* meshColumnWithPortalsSteps(world){globalThis.work(5);yield;return bundle(world);}`;
const previewSource = `export const meshTerrainPreview=world=>({chunks:[],portals:{positions:new Float32Array([world.seed])}});
  export class TerrainPreviewBuilder {constructor(world){this.world=world;} advance(){return meshTerrainPreview(this.world);}}`;
const scenerySource = `export class ScenerySamples {
  constructor(world){this.world=world;} collect(){return[{seed:this.world.seed}];}
  *collectSteps(){globalThis.work(5);yield;return this.collect();}
}`;
const encounterSource = `export class EncounterField {
  constructor(world,base){this.world=world;this.pads=base;this.pois=[];this.revision=0;this.regions=[];this.stats={cached:0,wanted:1,pending:'cell'};}
  update(){globalThis.work(5);this.revision++;this.regions=[{}];this.stats={cached:1,wanted:1,pending:null};}
}`;

test('all worker entrypoints receive fresh init snapshots and canceled local jobs retain the warm World and rest', async () => {
  for (const kind of ['mesher', 'scenery', 'encounters', 'map']) {
    const entry = kind === 'map' ? '../src/map.worker.ts' : `../src/render/${kind}.worker.ts`;
    const result = await build({ entryPoints: [fileURLToPath(new URL(entry, import.meta.url))], bundle: true,
      write: false, format: 'iife', platform: 'browser', logLevel: 'silent', plugins: [{ name: 'init-observer', setup(plugin) {
        plugin.onResolve({ filter: /^@shared\/(index|worldgen|encounters)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
        plugin.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js',
          contents: args.path.endsWith('encounters') ? encounterSource : worldSource }));
        plugin.onLoad({ filter: /[/\\]surfacenets\.ts$/ }, () => ({ loader: 'js', contents: meshSource }));
        plugin.onLoad({ filter: /[/\\]terrain-preview\.ts$/ }, () => ({ loader: 'js', contents: previewSource }));
        plugin.onLoad({ filter: /[/\\]scenery-samples\.ts$/ }, () => ({ loader: 'js', contents: scenerySource }));
        plugin.onLoad({ filter: /[/\\]world-map\.ts$/ }, () => ({ loader: 'js',
          contents: 'export const worldMapSvg=(world,plan)=>JSON.stringify({seed:world.seed,plan}); export function* worldMapSvgSteps(world,plan){yield;return worldMapSvg(world,plan);}' }));
      } }] });
    let now = 0, sequence = 0;
    const tasks = new Map<number, { due: number; callback: () => void }>(), worlds: any[] = [], messages: any[] = [];
    const self = { onmessage: null as ((event: { data: any }) => void) | null,
      postMessage: (message: unknown) => messages.push(structuredClone(message)) };
    runInNewContext(result.outputFiles[0].text, { self, structuredClone, location: { hostname: 'localhost' },
      captureWorld: (world: unknown) => worlds.push(world), work: (ms: number) => { now += ms; }, performance: { now: () => now },
      setTimeout: (callback: () => void, delay: number) => { const id = ++sequence; tasks.set(id, { due: now + delay, callback }); return id; },
      clearTimeout: (id: number) => tasks.delete(id) });
    const send = (data: unknown) => self.onmessage!({ data: structuredClone(data) });
    const next = () => { const [id, task] = [...tasks].sort((a, b) => a[1].due - b[1].due)[0];
      tasks.delete(id); now = Math.max(now, task.due); task.callback(); };
    const snapshot = (seed: number) => ({ seed, version: 1, plan: { marker: seed } });
    const init = (seed: number) => send(kind === 'map' ? { type: 'map', seed, transportSnapshot: snapshot(seed) } :
      { type: 'init', seed, cooperative: true, base: [], transportSnapshot: snapshot(seed) });
    const job = (id: number) => send(kind === 'mesher' ? { type: 'mesh', reqId: id, cx: 0, cz: 0, caveDetail: false, step: 1 } :
      kind === 'scenery' ? { type: 'query', id, kind: 'rocks', bounds: { minX: 0, maxX: 1, minZ: 0, maxZ: 1 } } :
      { type: 'select', request: id, points: [{ x: 0, z: 0 }] });
    init(1337);
    assert.equal(worlds.length, 1); assert.deepEqual(worlds[0].snapshot, snapshot(1337));
    if (kind !== 'map') { job(1); next(); }
    if (kind === 'mesher') {
      const deadline = [...tasks.values()][0].due;
      send({ type: 'cancel', reqId: 1 }); job(2); send({ type: 'cancel', reqId: 1 });
      assert.equal(worlds.length, 1, 'cancel retains the installed snapshot/World');
      assert.equal([...tasks.values()][0].due, deadline, 'cancel retains owed worker rest');
    }
    init(7331);
    assert.equal(worlds.length, 2); assert.notEqual(worlds[1], worlds[0]);
    assert.equal(worlds[1].seed, 7331); assert.deepEqual(worlds[1].snapshot, snapshot(7331));
    if (kind !== 'map') job(3);
    for (let count = 0; tasks.size; count++) { assert.ok(count < 20); next(); }
    if (kind === 'mesher') assert.deepEqual(messages.map(message => message.reqId), [3]);
    if (kind === 'scenery') assert.deepEqual(messages.map(message => message.id), [3]);
    if (kind === 'encounters') assert.equal(messages.at(-1).request, 3);
    if (kind === 'map') assert.equal(JSON.parse(messages.at(-1).svg).plan.marker, 7331);
    assert.deepEqual(worlds[0].snapshot, snapshot(1337), 'reseed does not mutate old owned input');
  }
});
