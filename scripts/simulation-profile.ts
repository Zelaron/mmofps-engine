import { Session, type Profiler } from 'node:inspector';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Game } from '../packages/server/src/game.js';
import { Bot, botName } from '../packages/server/src/bots.js';
import { EntityPool } from '../packages/server/src/entity-pool.js';
import { PLANETS } from '../packages/shared/src/universe.js';
import { MAX_ENTITY_BLOCK } from '../packages/shared/src/entity-id.js';

// Deterministic local simulation workload, without live characters or writes
// to user saves. An optional saved frontier is read once before construction.
// It uses production movement, bots and world generation. No network capacity
// claim can be made from these measurements; real-time soak tests are separate.
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log('npm run profile:simulation -- [--seed 7331] [--bots 15] [--warmup 1200] [--ticks 1800] [--label simulation-profile] [--world-save path] [--start-tick 0] [--first-block 0] [--human-city Meridian]');
  console.log('Writes a CPU profile, timing report and deterministic simulation state under artifacts/.');
  console.log('Optional world saves are read-only. Start tick and first entity block reproduce a coordinated worker cold start.');
  process.exit(0);
}
const options = new Map<string, string>();
for (let i = 0; i < args.length; i += 2) {
  const name = args[i], value = args[i + 1];
  if (!['--seed', '--bots', '--warmup', '--ticks', '--label', '--world-save', '--start-tick', '--first-block', '--human-city'].includes(name) || value === undefined || options.has(name))
    throw new Error(`Invalid or repeated profile option: ${name}`);
  options.set(name, value);
}
const seed = Number(options.get('--seed') ?? 7331);
const population = Number(options.get('--bots') ?? 15);
const warmup = Number(options.get('--warmup') ?? 1200);
const ticks = Number(options.get('--ticks') ?? 1800);
const label = options.get('--label') ?? 'simulation-profile';
const startTick = Number(options.get('--start-tick') ?? 0);
const firstBlock = Number(options.get('--first-block') ?? 0);
if (!PLANETS.some(p => p.seed === seed) || !Number.isInteger(population) || population < 0 || population > 384 ||
    !Number.isInteger(warmup) || warmup < 0 || warmup > 100_000 || !Number.isInteger(ticks) || ticks < 1 || ticks > 100_000 ||
    !Number.isSafeInteger(startTick) || startTick < 0 || !Number.isSafeInteger(startTick + warmup + ticks) ||
    !Number.isSafeInteger(firstBlock) || firstBlock < 0 || firstBlock > MAX_ENTITY_BLOCK - 31 ||
    label.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(label)) throw new Error('Invalid simulation profile parameters');

let savedWorld: unknown;
let worldSave: { path: string; sha256: string; bytes: number; territories: number } | undefined;
if (options.has('--world-save')) {
  const filename = path.resolve(options.get('--world-save')!);
  const bytes = await readFile(filename);
  savedWorld = JSON.parse(bytes.toString('utf8'));
  const saved = savedWorld as { seed?: number; territories?: unknown[] } | null;
  // The server ignores a foreign save. An explicitly requested profiling
  // input should instead fail visibly rather than measure a fresh campaign.
  if (!saved || typeof saved !== 'object' || saved.seed !== seed || !Array.isArray(saved.territories))
    throw new Error(`World save must contain territories for seed ${seed}: ${filename}`);
  worldSave = { path: filename, sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length, territories: saved.territories.length };
}

const pool = new EntityPool({ request: 'offline-benchmark', node: 'profile', planet: PLANETS.find(p => p.seed === seed)!.id,
  region: 'world', count: 32, firstBlock }, async () => { throw new Error('Offline profile exhausted its private ID buffer'); });
const beganConstruction = performance.now();
const game = new Game(seed, { vehicles: true, teleporters: true, wildlife: true, frontier: true, entityAllocator: pool });
// Match createGameServer -> Frontier.restore -> WorldNode.initializeClock,
// all before bot admission. world.json persists territory ownership only;
// encounter/vehicle layouts are regenerated from the seed after a restart.
if (worldSave) game.frontier?.restore(savedWorld);
// Leave the historical zero-clock default untouched unless explicitly set.
if (options.has('--start-tick')) game.initializeClock(startTick);
const initialFrontierHash = createHash('sha256').update(JSON.stringify(game.frontier?.save() ?? null)).digest('hex');
// Generation is time-sliced in production. Fix its candidate count here so
// faster/slower machines do not change the tick or ID of a later vehicle spawn.
// Keep the same eight-step upper bound; only the 1 ms early exit is disabled.
const field = (game as unknown as { encounterField?: { update(points: readonly { x: number; z: number }[], budget?: number, steps?: number): boolean } }).encounterField;
if (field) {
  const update = field.update.bind(field);
  field.update = (points, _budget, steps) => update(points, Infinity, steps);
}
const bots = Array.from({ length: population }, (_, i) => new Bot(game.addPlayer(botName(i), null, true), seed));
let humanCity: {name:string;x:number;y:number;z:number}|undefined;
if(options.has('--human-city')){
  const name=options.get('--human-city')!,city=game.world.collectCities().find(c=>c.name.toLowerCase()===name.toLowerCase());
  if(!city)throw new Error(`Unknown profile city ${name}`);
  const human=game.addPlayer('Interest observer',null);
  humanCity={name:city.name,x:city.x,y:game.world.groundY(city.x,city.z)+.1,z:city.z};
  Object.assign(human.state,{px:humanCity.x,py:humanCity.y,pz:humanCity.z,grounded:true});
}
const constructionMs = performance.now() - beganConstruction;
const yieldLoop = () => new Promise<void>(resolve => setImmediate(resolve));
const step = () => { for (const bot of bots) game.queueInput(bot.player, bot.think(game)); game.step(); };
for (let i = 0; i < warmup; i++) { step(); if (i % 60 === 59) await yieldLoop(); }

const stages = new Map<string, { ms: number; calls: number }>();
const actorWork = new Map<number, { ms: number; calls: number }>();
const internals = game as unknown as Record<string, (...args: unknown[]) => unknown>;
for (const name of ['updateVehicles', 'processPlayer', 'updateEncounters', 'updateTeleporters', 'updateCaveRecall',
  'updateAirlifts', 'updateProjectiles', 'updatePickups', 'updateCaveLoot', 'updateRespawnsAndRegen', 'recordHistory', 'broadcast']) {
  const original = internals[name], metric = { ms: 0, calls: 0 }; stages.set(name, metric);
  internals[name] = function (...args) {
    const start = performance.now();
    try { return original.apply(this, args); }
    finally {
      const elapsed = performance.now() - start;
      metric.ms += elapsed; metric.calls++;
      if (name === 'processPlayer') {
        const id = (args[0] as { id: number }).id;
        const actor = actorWork.get(id) ?? { ms: 0, calls: 0 };
        actor.ms += elapsed; actor.calls++; actorWork.set(id, actor);
      }
    }
  };
}
// Retain a few slow lock queries with their actual aim/target poses so a
// visibility hotspot can be reproduced without replaying the entire campaign.
const lockExamples: unknown[] = [], sampledLockActors = new Set<number>();
const originalLock = internals.updateHomingLock;
internals.updateHomingLock = function (...params) {
  const began = performance.now();
  const result = originalLock.apply(this, params);
  const elapsedMs = performance.now() - began, player = params[0] as { id: number };
  if (elapsedMs >= 1.5 && lockExamples.length < 6 && !sampledLockActors.has(player.id)) {
    sampledLockActors.add(player.id);
    lockExamples.push({ tick: game.tick, player: player.id, elapsedMs, cmd: { ...(params[1] as object) },
      players: [...game.players.values()].map(p => ({ id: p.id, faction: p.faction, vehicleId: p.vehicleId, state: { ...p.state } })),
      vehicles: [...game.vehicles.values()].map(v => ({ ...v })) });
  }
  return result;
};
const session = new Session(); session.connect();
const post = <T>(method: string, params = {}) => new Promise<T>((resolve, reject) => session.post(method, params,
  (error, result) => error ? reject(error) : resolve(result as T)));
let profile: Profiler.Profile;
const durations: number[] = []; let botMs = 0;
let wallMs = 0, cpuMs = 0;
try {
  await post('Profiler.enable'); await post('Profiler.setSamplingInterval', { interval: 1000 }); await post('Profiler.start');
  const start = performance.now(), cpu = process.cpuUsage();
  for (let i = 0; i < ticks; i++) {
    const tickStart = performance.now(), thinkStart = tickStart;
    for (const bot of bots) game.queueInput(bot.player, bot.think(game));
    botMs += performance.now() - thinkStart;
    game.step(); durations.push(performance.now() - tickStart);
    if (i % 60 === 59) await yieldLoop();
  }
  wallMs = performance.now() - start;
  const used = process.cpuUsage(cpu); cpuMs = (used.user + used.system) / 1000;
  profile = (await post<{ profile: Profiler.Profile }>('Profiler.stop')).profile;
} finally { session.disconnect(); await pool.close(); }

durations.sort((a, b) => a - b);
const quantile = (q: number) => durations[Math.min(durations.length - 1, Math.floor(q * durations.length))];
const samples = new Map<number, number>();
for (let i = 0; i < (profile.samples?.length ?? 0); i++) {
  const id = profile.samples![i]; samples.set(id, (samples.get(id) ?? 0) + (profile.timeDeltas?.[i] ?? 1000) / 1000);
}
const byFunction = new Map<string, { name: string; file: string; line: number; selfMs: number }>();
for (const node of profile.nodes) {
  const frame = node.callFrame, key = `${frame.url}:${frame.lineNumber}:${frame.functionName}`;
  const metric = byFunction.get(key) ?? { name: frame.functionName, file: frame.url, line: frame.lineNumber + 1, selfMs: 0 };
  metric.selfMs += samples.get(node.id) ?? 0; byFunction.set(key, metric);
}
const functions = [...byFunction.values()].filter(f => f.selfMs > 0).sort((a, b) => b.selfMs - a.selfMs).slice(0, 25);
const state = { players: [...game.players.values()].map(p => ({ id: p.id, state: p.state, health: p.health, ammo: p.ammo })),
  vehicles: [...game.vehicles.values()], projectiles: [...game.projectiles.values()], frontier: game.frontier?.save() };
const stateHash = createHash('sha256').update(JSON.stringify(state)).digest('hex');
const summary = { seed, population, warmup, ticks, startTick, firstBlock, worldSave, humanCity, initialFrontierHash, finalTick: game.tick,
  constructionMs, wallMs, cpuMs, generationScheduling: 'fixed-candidate-count', stateHash, meanTickMs: durations.reduce((a, b) => a + b, 0) / ticks,
  p50TickMs: quantile(.5), p95TickMs: quantile(.95), p99TickMs: quantile(.99), maxTickMs: durations.at(-1),
  botsMsPerTick: botMs / ticks, stages: [...stages].map(([name, m]) => ({ name, msPerTick: m.ms / ticks, calls: m.calls })).sort((a, b) => b.msPerTick - a.msPerTick),
  actors: [...actorWork].map(([id, work]) => {
    const p = game.players.get(id)!;
    return { id, name: p.name, faction: p.faction, msPerTick: work.ms / ticks, calls: work.calls,
      vehicle: p.state.vehicle, seat: p.state.seat, alive: p.state.alive, x: p.state.px, y: p.state.py, z: p.state.pz };
  }).sort((a, b) => b.msPerTick - a.msPerTick),
  entities: { players: game.players.size, vehicles: game.vehicles.size, pickups: game.pickups.size, projectiles: game.projectiles.size },
  gameplay: game.stats, botSimulation: game.botSimulation.stats, heapMB: process.memoryUsage().heapUsed / 1024 ** 2, functions };
await mkdir('artifacts', { recursive: true });
await writeFile(path.join('artifacts', `${label}.cpuprofile`), JSON.stringify(profile));
await writeFile(path.join('artifacts', `${label}-state.json`), JSON.stringify(state));
await writeFile(path.join('artifacts', `${label}-locks.json`), JSON.stringify(lockExamples, null, 2));
await writeFile(path.join('artifacts', `${label}.json`), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ ...summary, functions: functions.slice(0, 12).map(f => ({ ...f, file: f.file.split('/').slice(-2).join('/') })) }, null, 2));
