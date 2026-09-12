import { ControlClient } from './control-client.js';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { TICK_RATE, DEFAULT_SEED } from '@shared/index';
import { Game } from './game.js';
import { Bot, botName } from './bots.js';
import { PlayerConn } from './conn.js';
import { serveStatic } from './static.js';
import { advanceTicks, advanceSynchronizedTicks, synchronizedWakeup, SimulationOverload } from './tick-loop.js';
import { WorldStore, capturePlayer, restorePlayer, sessionKey, ensureSession } from './persistence.js';
import { EntityPool } from './entity-pool.js';
import { WorldNode, type WorldNodeOptions } from './world-node.js';

export interface ServerOptions {
  port?: number;
  host?: string;
  seed?: number;
  /**
   * Target world population. Bots fill the gap between connected humans and
   * this number, and step aside as real players join - a lone player always
   * has a fight waiting.
   */
  targetPopulation?: number;
  maxPlayers?: number;
  clientDir?: string;
  dataDir?: string;
  node?: WorldNodeOptions;
  log?: boolean;
  /** Called after a failed worker has closed and flushed its durable state. */
  onFailure?: (error: Error) => void;
  /** Embedded hosts can finish preparing other worlds before clocks start.
   * Public admission stays closed until this barrier and node startup finish. */
  beforeSimulationStart?: () => Promise<void>;
}

export interface RunningServer {
  game: Game;
  port: number;
  readonly failure: Error | null;
  close(): Promise<void>;
}

export const DEFAULT_TARGET_POPULATION = 15;

export function defaultClientDir(): string {
  // dist layout:  packages/server/dist/server.cjs  ->  ../../client/dist
  // src layout (tsx dev): packages/server/src/     ->  ../../client/dist
  const here =
    typeof __dirname !== 'undefined'
      ? __dirname
      : path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../client/dist');
}

export async function startServer(opts: ServerOptions = {}): Promise<RunningServer> {
  const port = opts.port ?? 8080;
  const host = opts.host ?? '0.0.0.0';
  const seed = opts.seed ?? DEFAULT_SEED;
  const targetPop = opts.targetPopulation ?? DEFAULT_TARGET_POPULATION;
  const maxPlayers = opts.maxPlayers ?? 64;
  const clientDir = opts.clientDir ?? defaultClientDir();
  const log = opts.log ?? true;

  const entities = opts.node ? await EntityPool.bootstrap(new ControlClient(opts.node.url, opts.node.secret),
    { node: opts.node.id, planet: opts.node.planet, region: opts.node.region ?? 'world' }) : undefined;
  const game = new Game(seed, { vehicles: true, teleporters: true, wildlife: true, frontier: true, entityAllocator: entities });
  const node = opts.node ? new WorldNode(game, opts.node, maxPlayers, entities) : null;
  const store = opts.dataDir ? new WorldStore(opts.dataDir) : null;
  if (store) game.frontier?.restore(await store.loadWorld());
  const sessions = new Map<string, PlayerConn>();
  const persist = async (): Promise<void> => {
    if (!store) return;
    const jobs: Promise<void>[] = [store.saveWorld(game.frontier?.save())];
    for (const [key, conn] of sessions) if (conn.player) jobs.push(store.savePlayer(key, capturePlayer(game, conn.player)));
    await Promise.all(jobs);
  };
  const saveTimer = setInterval(() => { void persist().catch(error => console.error('Persistence failed:', error)); }, 30_000);
  const bots: Bot[] = [];
  let botSerial = 0;
  let ready = !node;
  let failure: Error | null = null;
  const timing = { batches: 0, ticks: 0, workMs: 0, maxBatchMs: 0, maxDebt: 0,
    timers: 0, timerOvershootMs: 0, maxTimerOvershootMs: 0, immediateYields: 0, immediateWaitMs: 0, maxImmediateWaitMs: 0 };
  const simulationTiming = () => {
    const cpu = process.cpuUsage();
    return { processCpuMs: (cpu.user + cpu.system) / 1000, totalWorkMs: timing.workMs, batches: timing.batches, ticks: timing.ticks,
    meanTickWorkMs: timing.workMs / Math.max(1, timing.ticks), maxBatchMs: timing.maxBatchMs, maxDebt: timing.maxDebt,
    timerWakeups: timing.timers, meanTimerOvershootMs: timing.timerOvershootMs / Math.max(1, timing.timers),
    maxTimerOvershootMs: timing.maxTimerOvershootMs, immediateYields: timing.immediateYields,
    meanImmediateWaitMs: timing.immediateWaitMs / Math.max(1, timing.immediateYields), maxImmediateWaitMs: timing.maxImmediateWaitMs };
  };

  const refillBots = (): void => {
    if (!ready) return;
    let humans = 0;
    for (const p of game.players.values()) if (!p.isBot) humans++;
    const want = Math.max(0, Math.min(targetPop - humans, targetPop));
    while (bots.length < want) {
      const p = game.addPlayer(botName(botSerial++), null, true);
      bots.push(new Bot(p, seed));
    }
    while (bots.length > want) {
      const b = bots.pop()!;
      game.removePlayer(b.player.id);
    }
  };
  refillBots();
  const botTimer = setInterval(refillBots, 4000);

  const startedAt = Date.now();
  const httpServer = http.createServer((req, res) => {
    if (req.url === '/api/session') { ensureSession(req, res); return; }
    if (req.url === '/healthz') {
      const healthy = ready && !failure && (!node || node.status.ready);
      res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: healthy,
        authority: node?.status,
        clockDebt: ready && node ? Math.max(0, node.targetTick() - game.tick) : 0,
        simulation: simulationTiming(),
        failure: failure?.message,
        game: 'THE MMOFPS',
        territories: game.frontier?.territories.length ?? 0,
        players: game.players.size,
        bots: bots.length,
        tick: game.tick,
        seed,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      }));
      return;
    }
    serveStatic(clientDir, req, res);
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
  const conns = new Set<PlayerConn>();

  httpServer.on('upgrade', (req, socket, head) => {
    const urlPath = (req.url ?? '').split('?')[0];
    if (!ready || failure || urlPath !== '/ws') {
      socket.destroy();
      return;
    }
    const key = store ? sessionKey(req) : null;
    const load = async (): Promise<void> => {
      if (node) {
        const lease = await node.claim(req);
        if (socket.destroyed) { node.abandon(lease); return; }
        try {
          wss.handleUpgrade(req, socket, head, ws => {
            const lifecycle = node.lifecycle(lease);
            const conn = new PlayerConn(ws, game, maxPlayers, undefined, {
              ...lifecycle,
              joined(player) { lifecycle.joined?.(player); refillBots(); },
              closed() { lifecycle.closed?.(); refillBots(); },
            });
            node.bind(lease, conn);
            conns.add(conn);
            ws.on('close', () => conns.delete(conn));
          });
        } catch (error) { node.abandon(lease); throw error; }
        return;
      }
      const active = key ? sessions.get(key) : undefined;
      const saved = active?.player ? capturePlayer(game, active.player) : key ? await store!.loadPlayer(key) : null;
      if (socket.destroyed) return;
      wss.handleUpgrade(req, socket, head, (ws) => {
        const conn = new PlayerConn(ws, game, maxPlayers, undefined, {
          joined(player) {
            const previous = key ? sessions.get(key) : undefined;
            const latest = previous?.player ? capturePlayer(game, previous.player) : saved;
            if (key) { previous?.disconnect(); sessions.set(key, conn); }
            if (latest) restorePlayer(game, player, latest);
            refillBots();
          },
          leaving(player) {
            if (!key || !store) return;
            void store.savePlayer(key, capturePlayer(game, player)).catch(error => console.error('Player save failed:', error));
            if (sessions.get(key) === conn) sessions.delete(key);
          },
        });
        conns.add(conn);
        ws.on('close', () => conns.delete(conn));
      });
    };
    void load().catch(error => { console.error('Session load failed:', error); socket.destroy(); });
  });

  // Heartbeat: terminate dead sockets.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const anyWs = ws as unknown as { isAlive?: boolean };
      if (anyWs.isAlive === false) { ws.terminate(); continue; }
      anyWs.isAlive = false;
      ws.ping();
      ws.once('pong', () => { anyWs.isAlive = true; });
    }
  }, 10_000);

  // Fixed-timestep simulation loop with drift correction.
  const tickMs = 1000 / TICK_RATE;
  let nextTickAt = performance.now();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined, immediate: ReturnType<typeof setImmediate> | undefined;
  let scheduledAt: number | undefined, scheduledWait: number | null = null;
  const step = (): boolean => {
    if (node && !node.step()) return false;
    for (const b of bots) game.queueInput(b.player, b.think(game));
    game.step();
    return true;
  };
  const loop = (): void => {
    timer = undefined; immediate = undefined;
    if (stopped) return;
    const began = performance.now(), before = game.tick;
    if (scheduledAt !== undefined) {
      const waited = began - scheduledAt;
      if (scheduledWait === null) {
        timing.immediateYields++; timing.immediateWaitMs += waited;
        timing.maxImmediateWaitMs = Math.max(timing.maxImmediateWaitMs, waited);
      } else {
        const overshoot = Math.max(0, waited - scheduledWait);
        timing.timers++; timing.timerOvershootMs += overshoot;
        timing.maxTimerOvershootMs = Math.max(timing.maxTimerOvershootMs, overshoot);
      }
    }
    try {
      let wait: number | null;
      if (node) {
        timing.maxDebt = Math.max(timing.maxDebt, node.targetTick() - game.tick);
        const debt = advanceSynchronizedTicks(() => game.tick, () => node.targetTick(), step);
        timing.maxDebt = Math.max(timing.maxDebt, debt);
        wait = synchronizedWakeup(debt, game.tick > before, node.millisecondsUntil(game.tick + 1));
      } else {
        nextTickAt = advanceTicks(nextTickAt, tickMs, step);
        wait = Math.max(0, nextTickAt - performance.now());
      }
      // setImmediate gives sockets and timers a turn without imposing an
      // extra host timer quantum on already overdue physics.
      scheduledWait = wait; scheduledAt = performance.now();
      if (wait === null) immediate = setImmediate(loop);
      else timer = setTimeout(loop, wait);
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
      if (error instanceof SimulationOverload) timing.maxDebt = Math.max(timing.maxDebt, error.debt);
      if (log) console.error(`${new Date().toISOString()} World simulation stopped:`, failure.message,
        JSON.stringify({ seed, ...simulationTiming() }));
      void close().catch(error => console.error('Failed world cleanup:', error)).finally(() => opts.onFailure?.(failure!));
    } finally {
      const workMs = performance.now() - began;
      timing.batches++; timing.ticks += game.tick - before; timing.workMs += workMs;
      timing.maxBatchMs = Math.max(timing.maxBatchMs, workMs);
    }
  };

  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => closing ??= (async () => {
    stopped = true; ready = false;
    clearTimeout(timer); clearImmediate(immediate);
    clearInterval(heartbeat); clearInterval(botTimer); clearInterval(saveTimer);
    for (const conn of conns) conn.disconnect(1013, 'World restarting');
    await node?.close();
    await persist();
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>(done => wss.close(() => done()));
    await new Promise<void>(done => httpServer.close(() => done()));
    await store?.flush();
  })();

  return new Promise((resolve, reject) => {
    httpServer.once('error', error => { void close().finally(() => reject(error)); });
    httpServer.listen(port, host, () => { void (async () => {
      const addr = httpServer.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      await opts.beforeSimulationStart?.();
      await node?.start(actualPort);
      ready = true; refillBots();
      if (log) {
        console.log(`MMOFPS server on http://localhost:${actualPort}  (seed ${seed}, target population ${targetPop}, tick ${TICK_RATE} Hz)`);
        console.log(`Serving client from: ${clientDir}`);
      }
      loop();
      resolve({
        game,
        port: actualPort,
        get failure() { return failure; },
        close,
      });
    })().catch(error => { void close().finally(() => reject(error)); }); });
  });
}
