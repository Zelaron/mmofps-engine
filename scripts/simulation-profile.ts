import { Session, type Profiler } from 'node:inspector';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Game } from '../packages/server/src/game.js';
import { Bot, botName } from '../packages/server/src/bots.js';
import { EntityPool } from '../packages/server/src/entity-pool.js';
import { PLANETS } from '../packages/shared/src/universe.js';

// Deterministic local simulation workload, without live characters or saves.
// It uses production movement, bots and world generation. No network capacity
// claim can be made from these measurements; real-time soak tests are separate.
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log('npm run profile:simulation -- [--seed 7331] [--bots 15] [--warmup 1200] [--ticks 1800] [--label simulation-profile]');
  console.log('Writes a CPU profile, timing report and deterministic simulation state under artifacts/.');
  process.exit(0);
}
const options = new Map<string, string>();
for (let i = 0; i < args.length; i += 2) {
  const name = args[i], value = args[i + 1];
  if (!['--seed', '--bots', '--warmup', '--ticks', '--label'].includes(name) || value === undefined || options.has(name))
    throw new Error(`Invalid or repeated profile option: ${name}`);
  options.set(name, value);
}
const seed = Number(options.get('--seed') ?? 7331);
const population = Number(options.get('--bots') ?? 15);
const warmup = Number(options.get('--warmup') ?? 1200);
const ticks = Number(options.get('--ticks') ?? 1800);
const label = options.get('--label') ?? 'simulation-profile';
if (!PLANETS.some(p => p.seed === seed) || !Number.isInteger(population) || population < 0 || population > 128 ||
    !Number.isInteger(warmup) || warmup < 0 || warmup > 100_000 || !Number.isInteger(ticks) || ticks < 1 || ticks > 100_000 ||
    label.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(label)) throw new Error('Invalid simulation profile parameters');

const pool = new EntityPool({ request: 'offline-benchmark', node: 'profile', planet: PLANETS.find(p => p.seed === seed)!.id,
  region: 'world', count: 32, firstBlock: 0 }, async () => { throw new Error('Offline profile exhausted its private ID buffer'); });
const beganConstruction = performance.now();
const game = new Game(seed, { vehicles: true, teleporters: true, wildlife: true, frontier: true, entityAllocator: pool });
// Generation is time-sliced in production. Fix its candidate count here so
// faster/slower machines do not change the tick or ID of a later vehicle spawn.
// Keep the same eight-step upper bound; only the 1 ms early exit is disabled.
const field = (game as unknown as { encounterField?: { update(points: readonly { x: number; z: number }[], budget?: number, steps?: number): boolean } }).encounterField;
if (field) {
  const update = field.update.bind(field);
  field.update = (points, _budget, steps) => update(points, Infinity, steps);
}
const bots = Array.from({ length: population }, (_, i) => new Bot(game.addPlayer(botName(i), null, true), seed));
const constructionMs = performance.now() - beganConstruction;
const yieldLoop = () => new Promise<void>(resolve => setImmediate(resolve));
const step = () => { for (const bot of bots) game.queueInput(bot.player, bot.think(game)); game.step(); };
for (let i = 0; i < warmup; i++) { step(); if (i % 60 === 59) await yieldLoop(); }

const stages = new Map<string, { ms: number; calls: number }>();
const internals = game as unknown as Record<string, (...args: unknown[]) => unknown>;
for (const name of ['updateVehicles', 'processPlayer', 'updateEncounters', 'updateTeleporters', 'updateCaveRecall',
  'updateAirlifts', 'updateProjectiles', 'updatePickups', 'updateCaveLoot', 'updateRespawnsAndRegen', 'recordHistory', 'broadcast']) {
  const original = internals[name], metric = { ms: 0, calls: 0 }; stages.set(name, metric);
  internals[name] = function (...args) {
    const start = performance.now();
    try { return original.apply(this, args); }
    finally { metric.ms += performance.now() - start; metric.calls++; }
  };
}
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
const summary = { seed, population, warmup, ticks, constructionMs, wallMs, cpuMs, generationScheduling: 'fixed-candidate-count', stateHash, meanTickMs: durations.reduce((a, b) => a + b, 0) / ticks,
  p50TickMs: quantile(.5), p95TickMs: quantile(.95), p99TickMs: quantile(.99), maxTickMs: durations.at(-1),
  botsMsPerTick: botMs / ticks, stages: [...stages].map(([name, m]) => ({ name, msPerTick: m.ms / ticks, calls: m.calls })).sort((a, b) => b.msPerTick - a.msPerTick),
  entities: { players: game.players.size, vehicles: game.vehicles.size, pickups: game.pickups.size, projectiles: game.projectiles.size },
  gameplay: game.stats, heapMB: process.memoryUsage().heapUsed / 1024 ** 2, functions };
await mkdir('artifacts', { recursive: true });
await writeFile(path.join('artifacts', `${label}.cpuprofile`), JSON.stringify(profile));
await writeFile(path.join('artifacts', `${label}-state.json`), JSON.stringify(state));
await writeFile(path.join('artifacts', `${label}.json`), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ ...summary, functions: functions.slice(0, 12).map(f => ({ ...f, file: f.file.split('/').slice(-2).join('/') })) }, null, 2));
