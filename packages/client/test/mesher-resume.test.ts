import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

// Keep the real worker/controller and replace only expensive geometry. Native
// interleaved mesh-byte equality is covered by mesher-coroutine.test.ts.
const meshSource = `
const bundle=(world,cx,cz,cave,step)=>({chunks:[],portals:{positions:new Float32Array([world.seed,cx,cz,Number(cave),step])}});
export const meshColumnWithPortals=bundle;
export function* meshColumnWithPortalsSteps(world,cx,cz,cave,step){
  const key=[world.seed,cx,cz,cave,step].join(',');globalThis.started(key);
  try {
    if(cx===0){globalThis.work(5);return bundle(world,cx,cz,cave,step);}
    for(let i=0;i<3;i++){
      if(cx===99&&i===1)throw new Error('native mesh failure');
      globalThis.advanced(key,i);globalThis.work(5);yield;
    }
    return bundle(world,cx,cz,cave,step);
  }finally{globalThis.closed(key);}
}`;
let bundled: Promise<string> | undefined;
function workerBundle(): Promise<string> {
  return bundled ??= build({ entryPoints: [fileURLToPath(new URL('../src/render/mesher.worker.ts', import.meta.url))],
    bundle: true, write: false, format: 'iife', platform: 'browser', logLevel: 'silent', plugins: [{
      name: 'bounded-mesh-fixture', setup(plugin) {
        plugin.onResolve({ filter: /^@shared\/index$/ }, args => ({ path: args.path, namespace: 'fixture' }));
        plugin.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'js',
          contents: 'export class World {constructor(seed){this.seed=seed;}}' }));
        plugin.onLoad({ filter: /[/\\]surfacenets\.ts$/ }, () => ({ loader: 'js', contents: meshSource }));
        plugin.onLoad({ filter: /[/\\]terrain-preview\.ts$/ }, () => ({ loader: 'js', contents: `
          export const meshTerrainPreview=(world,cx,cz)=>({chunks:[],portals:{positions:new Float32Array([world.seed,cx,cz])}});
          export class TerrainPreviewBuilder {constructor(world,cx,cz){this.world=world;this.cx=cx;this.cz=cz;}
          advance(){globalThis.started('preview');globalThis.work(5);return meshTerrainPreview(this.world,this.cx,this.cz);}}` }));
      },
    }] }).then(result => result.outputFiles[0].text);
}

async function harness() {
  let now = 0, sequence = 0;
  const tasks = new Map<number, { at: number; callback: () => void }>();
  const starts: string[] = [], closes: string[] = [], advances: [string, number][] = [], messages: any[] = [];
  const self = { onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage(message: unknown, transfer?: Transferable[]) {
      messages.push(structuredClone(message, { transfer: transfer as ArrayBuffer[] }));
    } };
  runInNewContext(await workerBundle(), { self, performance: { now: () => now },
    started: (key: string) => starts.push(key), closed: (key: string) => closes.push(key),
    advanced: (key: string, i: number) => advances.push([key, i]), work: (ms: number) => { now += ms; },
    setTimeout(callback: () => void, delay: number) { const id = ++sequence; tasks.set(id, { at: now + delay, callback }); return id; },
    clearTimeout(id: number) { tasks.delete(id); },
  });
  const send = (data: unknown) => self.onmessage!({ data });
  const next = () => {
    const entry = [...tasks].sort((a, b) => a[1].at - b[1].at)[0]; assert.ok(entry);
    tasks.delete(entry[0]); now = Math.max(now, entry[1].at); entry[1].callback();
  };
  return { send, next, starts, closes, advances, messages, tasks, now: () => now,
    drain() { for (let i = 0; tasks.size; i++) { assert.ok(i < 100); next(); } },
    init(seed = 1337, cooperative = true) { send({ type: 'init', seed, cooperative }); },
    mesh(reqId: number, cx: number, caveDetail = true, step = 4, preview = false) {
      send({ type: 'mesh', reqId, cx, cz: 2, caveDetail, step, preview, urgentCoverage: true });
    },
    cancel(reqId: number) { send({ type: 'cancel', reqId }); },
  };
}

test('canonical jobs resume exact request keys and publish only the current request after interleaving', async () => {
  const h = await harness(); h.init();
  h.mesh(1, 1); h.next(); h.cancel(1);
  const a = '1337,1,2,true,4', b = '1337,2,2,true,4';
  h.mesh(2, 2); h.next(); h.cancel(2);
  h.mesh(3, 1); h.cancel(1); h.drain();
  assert.deepEqual(h.messages.map(message => message.reqId), [3]);
  assert.equal(h.starts.filter(key => key === a).length, 1, 'A resumes without rebuilding its first slice');
  assert.deepEqual(h.advances.filter(([key]) => key === a).map(([, i]) => i), [0, 1, 2]);
  assert.equal(h.messages[0].workMs, 15, 'timing includes active work before the pause');
  assert.deepEqual(Array.from(h.messages[0].portals.positions), [1337, 1, 2, 1, 4]);
  assert.equal(h.closes.includes(b), false, 'the other job remains paused without draining');
  h.mesh(4, 2, false); h.drain();
  assert.equal(h.starts.includes('1337,2,2,false,4'), true, 'different cave detail cannot reuse the retained task');
  h.mesh(5, 2); h.drain();
  assert.equal(h.starts.filter(key => key === b).length, 1);
  h.mesh(6, 2, true, 1); h.drain();
  assert.equal(h.starts.includes('1337,2,2,true,1'), true, 'different resolution is an independent job');
  assert.deepEqual(h.messages.map(message => message.reqId), [3, 4, 5, 6]);
  h.init(); assert.equal(h.tasks.size, 0);
});

test('paused canonical cache stays at two tasks and reseed closes retained state', async () => {
  const h = await harness(); h.init();
  for (const cx of [10, 11, 12]) { h.mesh(cx, cx); h.next(); h.cancel(cx); }
  assert.deepEqual(h.closes, ['1337,10,2,true,4'], 'third paused job evicts and closes the oldest iterator');
  assert.equal(h.tasks.size, 0); assert.equal(h.messages.length, 0);
  h.init(7331);
  assert.deepEqual(h.closes.sort(), ['1337,10,2,true,4', '1337,11,2,true,4', '1337,12,2,true,4']);
  h.mesh(13, 12); h.drain();
  assert.deepEqual(Array.from(h.messages[0].portals.positions), [7331, 12, 2, 1, 4]);
  assert.deepEqual(h.messages.map(message => message.reqId), [13]);
});

test('completed canonical results retain final rest across cancel and new request identity', async () => {
  const h = await harness(); h.init(); h.mesh(1, 0); h.next();
  const deadline = [...h.tasks.values()][0].at;
  assert.equal(h.messages.length, 0); h.cancel(1); assert.equal(h.tasks.size, 0);
  h.mesh(2, 0); h.cancel(1);
  assert.equal([...h.tasks.values()][0].at, deadline);
  h.drain(); assert.deepEqual(h.messages.map(message => message.reqId), [2]);
  assert.equal(h.starts.length, 1, 'the saved done value is used instead of advancing a completed generator');
  assert.equal(h.now(), deadline);
  h.mesh(3, 0, false, 16, true); h.next(); h.cancel(3);
  h.mesh(4, 0, false, 16, true); h.drain();
  assert.equal(h.starts.filter(key => key === 'preview').length, 2, 'cheap previews are discarded rather than retained');
  assert.deepEqual(h.messages.map(message => message.reqId), [2, 4]);
});

test('native generator failure closes paused jobs and remote requests stay synchronous', async () => {
  const h = await harness(); h.init(); h.mesh(1, 20); h.next(); h.cancel(1);
  h.mesh(2, 99); h.next();
  assert.throws(() => h.next(), /native mesh failure/);
  assert.ok(h.closes.includes('1337,20,2,true,4'));
  assert.ok(h.closes.includes('1337,99,2,true,4'));
  assert.equal(h.tasks.size, 0); assert.equal(h.messages.length, 0);
  h.init(7331, false); h.mesh(3, 20);
  assert.equal(h.tasks.size, 0); assert.equal(h.messages[0].paced, undefined);
  assert.deepEqual(Array.from(h.messages[0].portals.positions), [7331, 20, 2, 1, 4]);
});
