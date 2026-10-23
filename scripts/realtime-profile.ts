import { Session, type Profiler } from 'node:inspector';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Coordinator } from '../packages/server/src/coordinator.js';
import { startControlPlane } from '../packages/server/src/control-plane.js';
import { startServer } from '../packages/server/src/server.js';
import { PLANETS } from '../packages/shared/src/universe.js';
import { Bot } from '../packages/server/src/bots.js';

// A real coordinated worker, using production encounter time slicing, bots,
// physics, heartbeats and scheduler. The optional bounded pause/cost floor
// model a busy host; they are diagnostic inputs, never production settings.
const args = process.argv.slice(2), options = new Map<string, string>();
if (args.length === 1 && args[0] === '--help') {
  console.log('profile:realtime --seed 7331 --bots 192 --seconds 90 --warmup 10 --step-floor-ms 0 --pause-ms 0 --first-block 0 --label realtime-profile');
  console.log('Runs an isolated coordinated worker; writes CPU profile, health samples and timing report to artifacts/.');
  process.exit(0);
}
for (let i = 0; i < args.length; i += 2) {
  const key = args[i], value = args[i + 1];
  if (!['--seed', '--bots', '--seconds', '--warmup', '--step-floor-ms', '--pause-ms', '--first-block', '--label'].includes(key) ||
    value === undefined || options.has(key)) throw new Error(`Invalid/repeated profile option: ${key}`);
  options.set(key, value);
}
const seed = Number(options.get('--seed') ?? 7331), bots = Number(options.get('--bots') ?? 15);
const seconds = Number(options.get('--seconds') ?? 90), warmup = Number(options.get('--warmup') ?? 10);
const floorMs = Number(options.get('--step-floor-ms') ?? 0), pauseMs = Number(options.get('--pause-ms') ?? 0);
const firstBlock = Number(options.get('--first-block') ?? 0);
const label = options.get('--label') ?? 'realtime-profile', planet = PLANETS.find(p => p.seed === seed);
if (!planet || !Number.isInteger(bots) || bots < 0 || bots > 384 || !Number.isInteger(seconds) || seconds < 1 || seconds > 600 ||
  !Number.isInteger(firstBlock) || firstBlock < 0 || firstBlock > 32 ||
  !Number.isInteger(warmup) || warmup < 0 || warmup > 120 || !Number.isFinite(floorMs) || floorMs < 0 || floorMs > 15 ||
  !Number.isFinite(pauseMs) || pauseMs < 0 || pauseMs > 2000 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(label) || label.length > 64)
  throw new Error('Invalid realtime profile parameters');

await mkdir('artifacts', { recursive: true });
const coordinator = new Coordinator(':memory:'), secret = randomBytes(32).toString('hex');
// Reproduce another worker's entity/RNG namespace without running extra worlds.
if(firstBlock)coordinator.reserveEntities({request:randomUUID(),node:`profile-padding:${randomUUID()}`,
  planet:'meridian',region:'world',count:firstBlock});
const control = await startControlPlane(coordinator, secret);
let failure: string | null = null, measured = false;
const work: number[] = [], gameTimes: number[] = [], yields: number[] = [];
const health: unknown[] = [], stages = new Map<string, { ms: number; calls: number }>();
const actorWork = new Map<number,{ms:number;calls:number}>();
const actorLocks = new Map<number,{ms:number;calls:number}>();
let previousEnd = 0, thinkMs = 0, firstTick = 0, lastTick = 0, ticksMeasured = 0, gaps = 0, expectedTick = 0;
const server = await startServer({ port: 0, host: '127.0.0.1', seed, targetPopulation: bots, log: false,
  node: { id: `${planet.id}:${randomUUID()}`, planet: planet.id, secret, url: `http://127.0.0.1:${control.port}` },
  onFailure: error => { failure = error.message; } });
// Re-read the worker's asynchronous failure state across awaits.
const currentFailure = (): Error | null => server.failure;
const game = server.game, originalStep = game.step.bind(game), originalThink = Bot.prototype.think;
Bot.prototype.think = function (g) {
  const began = performance.now();
  try { return originalThink.call(this, g); }
  finally { if (measured) thinkMs += performance.now() - began; }
};
game.step = () => {
  const began = performance.now();
  if (measured && previousEnd) yields.push(began - previousEnd);
  originalStep();
  const realWork = performance.now() - began;
  while (performance.now() - began < floorMs) { /* explicit test workload */ }
  if (measured) {
    if (game.tick !== ++expectedTick) gaps++;
    ticksMeasured++; gameTimes.push(realWork); work.push(performance.now() - began);
    previousEnd = performance.now();
  }
};
const internals = game as unknown as Record<string, (...args: unknown[]) => unknown>;
for (const name of ['updateVehicles', 'processPlayer', 'updateEncounters', 'updateTeleporters', 'updateCaveRecall',
  'updateAirlifts', 'updateProjectiles', 'updatePickups', 'updateCaveLoot', 'updateRespawnsAndRegen', 'recordHistory', 'broadcast', 'updateHomingLock']) {
  const original = internals[name], metric = { ms: 0, calls: 0 }; stages.set(name, metric);
  internals[name] = function (...params) {
    const began = performance.now();
    try { return original.apply(this, params); }
    finally { if (measured) {
      const elapsed=performance.now()-began;metric.ms+=elapsed;metric.calls++;
      if(name==='processPlayer'){
        const id=(params[0] as {id:number}).id,work=actorWork.get(id)??{ms:0,calls:0};
        work.ms+=elapsed;work.calls++;actorWork.set(id,work);
      }
      if(name==='updateHomingLock'){
        const id=(params[0] as {id:number}).id,work=actorLocks.get(id)??{ms:0,calls:0};
        work.ms+=elapsed;work.calls++;actorLocks.set(id,work);
      }
    } }
  };
}
const session = new Session();
const post = <T>(method: string, params = {}) => new Promise<T>((resolve, reject) => session.post(method, params,
  (error, result) => error ? reject(error) : resolve(result as T)));
let profile: Profiler.Profile | undefined, elapsedMs = 0, cpuMs = 0;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
try {
  await sleep(warmup * 1000);
  if (currentFailure()) throw currentFailure();
  session.connect(); await post('Profiler.enable'); await post('Profiler.setSamplingInterval', { interval: 1000 });
  await post('Profiler.start');
  const began = performance.now(), cpu = process.cpuUsage();
  firstTick = expectedTick = game.tick; measured = true;
  if (pauseMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pauseMs);
  while (performance.now() - began < seconds * 1000 && !currentFailure()) {
    const sampledAt = performance.now();
    try {
      const h = await fetch(`http://127.0.0.1:${server.port}/healthz`, { signal: AbortSignal.timeout(5000) }).then(r => r.json());
      health.push({ elapsedMs: sampledAt - began, responseMs: performance.now() - sampledAt, ...h });
    } catch (error) { health.push({ elapsedMs: sampledAt - began, error: String(error) }); }
    await sleep(200);
  }
  measured = false; lastTick = game.tick; elapsedMs = performance.now() - began;
  const used = process.cpuUsage(cpu); cpuMs = (used.user + used.system) / 1000;
  failure = currentFailure()?.message ?? failure;
  profile = (await post<{ profile: Profiler.Profile }>('Profiler.stop')).profile;
} finally {
  measured = false; Bot.prototype.think = originalThink;
  session.disconnect(); await server.close(); await control.close(); coordinator.close();
}
const distribution = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
  return { count: n, mean: values.reduce((a, b) => a + b, 0) / Math.max(1, n),
    p50: sorted[Math.floor(n * .5)], p95: sorted[Math.min(n - 1, Math.floor(n * .95))],
    p99: sorted[Math.min(n - 1, Math.floor(n * .99))], max: sorted.at(-1) };
};
const sampleMs = new Map<number, number>();
for (let i = 0; i < (profile?.samples?.length ?? 0); i++) {
  const id = profile!.samples![i]; sampleMs.set(id, (sampleMs.get(id) ?? 0) + (profile!.timeDeltas?.[i] ?? 1000) / 1000);
}
const byFunction = new Map<string, { name: string; file: string; line: number; selfMs: number }>();
for (const node of profile?.nodes ?? []) {
  const f = node.callFrame, key = `${f.url}:${f.lineNumber}:${f.functionName}`;
  const value = byFunction.get(key) ?? { name: f.functionName, file: f.url, line: f.lineNumber + 1, selfMs: 0 };
  value.selfMs += sampleMs.get(node.id) ?? 0; byFunction.set(key, value);
}
const functions = [...byFunction.values()].sort((a, b) => b.selfMs - a.selfMs).slice(0, 35);
const summary = { seed, bots, seconds, warmup, firstBlock, floorMs, pauseMs, elapsedMs, cpuMs, firstTick, finalTick: lastTick,
  ticksMeasured, gaps, failure, step: distribution(work), gameStep: distribution(gameTimes), betweenSteps: distribution(yields),
  botsMsPerTick: thinkMs / Math.max(1, ticksMeasured),
  botSimulation: game.botSimulation.stats,
  actors: [...actorWork].map(([id,work])=>{const p=game.players.get(id);return{id,msPerTick:work.ms/Math.max(1,ticksMeasured),calls:work.calls,
    lockMsPerTick:(actorLocks.get(id)?.ms??0)/Math.max(1,ticksMeasured),
    state:p?.state,weapon:p?.weapon,faction:p?.faction,vehicleId:p?.vehicleId,lastCmd:p?.lastCmd};}).sort((a,b)=>b.msPerTick-a.msPerTick),
  vehicles: [...game.vehicles.values()].map(v=>({id:v.id,type:v.type,variant:v.variant,x:v.x,y:v.y,z:v.z,
    heading:v.heading,occupant:v.occupant,health:v.health,respawnAtTick:v.respawnAtTick,motionState:v.motionState})),
  stages: [...stages].map(([name, v]) => ({ name, msPerTick: v.ms / Math.max(1, ticksMeasured) })).sort((a, b) => b.msPerTick - a.msPerTick),
  gameplay: game.stats, entities: { players: game.players.size, vehicles: game.vehicles.size, projectiles: game.projectiles.size }, functions };
await writeFile(path.join('artifacts', `${label}.cpuprofile`), JSON.stringify(profile));
await writeFile(path.join('artifacts', `${label}-health.json`), JSON.stringify(health, null, 2));
await writeFile(path.join('artifacts', `${label}.json`), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ ...summary, functions: functions.slice(0, 8) }, null, 2));
