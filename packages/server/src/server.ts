import { ControlClient } from './control-client.js';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { TICK_RATE, DEFAULT_SEED } from '@shared/index';
import { Game } from './game.js';
import { Bot, botName } from './bots.js';
import { AdaptivePopulation } from './adaptive-population.js';
import { selectAdaptiveRetirements, createAdaptiveRetirementDiagnostics, type AdaptiveRetirementDiagnostics } from './bot-retirement.js';
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
   * Maximum target world population, including humans. Bots fill available
   * capacity and step aside as humans join. Sustained server load can lower
   * the current target while adaptivePopulation is enabled.
   */
  targetPopulation?: number;
  /** Reduce distant bot reserves under sustained load, restoring them slowly
   * when headroom returns. Disable for fixed-population benchmarks. */
  adaptivePopulation?: boolean;
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

export const DEFAULT_TARGET_POPULATION = 192;

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
  const population = opts.adaptivePopulation === false ? null : new AdaptivePopulation(targetPop);
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
  node?.attachBots(bots,targetPop);
  let botRefill: ReturnType<typeof setTimeout> | undefined;
  let botSerial = 0;
  let adaptiveRetired = 0;
  let retirement: (AdaptiveRetirementDiagnostics & { tick: number }) | undefined;
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
    meanImmediateWaitMs: timing.immediateWaitMs / Math.max(1, timing.immediateYields), maxImmediateWaitMs: timing.maxImmediateWaitMs,
    botMovement: game.botSimulation.stats };
  };

  const refillBots = (): void => {
    if (!ready) return;
    clearTimeout(botRefill);botRefill=undefined;
    let humans = 0;
    for (const p of game.players.values()) if (!p.isBot) humans++;
    const ceiling = Math.max(0, targetPop - humans);
    const want = Math.max(0, (population?.target ?? targetPop) - humans);
    const retire = (bot: Bot): void => {
      const index = bots.indexOf(bot);
      if (index < 0) return;
      bots.splice(index, 1);
      node?.retireBot(bot);
      game.removePlayer(bot.player.id);
    };
    // Human admission retains the configured hard ceiling. Adaptive shedding
    // below it uses the more conservative, visibility-aware policy below.
    while (bots.length > ceiling) {
      let index=bots.length-1;
      while(index>=0 && node?.protectBot(bots[index]))index--;
      // Human admission retains the population ceiling even if every local
      // reserve recently arrived. Only unresolved detached ownership is held.
      if(index<0) {
        index=bots.length-1;
        while(index>=0 && node?.frozenBot(bots[index]))index--;
      }
      if(index<0)break;
      retire(bots[index]);
    }
    if (bots.length > want) {
      const diagnostics = createAdaptiveRetirementDiagnostics();
      const reserves = selectAdaptiveRetirements(game, bots, bots.length - want,
        bot => (node?.protectBot(bot) ?? false) || (node?.frozenBot(bot) ?? false), diagnostics);
      for (const bot of reserves) retire(bot);
      adaptiveRetired += reserves.length;
      retirement = { ...diagnostics, tick: game.tick };
    }
    // Stagger expensive safe-spawn searches while every new soldier joins
    // the live clock. A large roster must not pause the first world ticks.
    for (let added=0;bots.length < want && added<12;added++) {
      const p = game.addPlayer(botName(botSerial++), null, true);
      bots.push(new Bot(p, seed));
    }
    if(bots.length<want)botRefill=setTimeout(refillBots,150);
  };
  refillBots();
  // A protected soldier can become an eligible reserve after dying or leaving
  // combat. Retry without forcing a visible retirement to meet the target.
  const botTimer = setInterval(refillBots, 1000);

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
        population: { ...(population?.status ?? { maximum: targetPop, minimum: targetPop, target: targetPop, reason: 'fixed' }),
          adaptive: !!population, actual: game.players.size, bots: bots.length, retired: adaptiveRetired, retirement },
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
    for (const b of bots) if(game.players.get(b.player.id)===b.player) {
      const command=b.think(game);
      game.queueInput(b.player,node?.botCommand(b,command)??command);
    }
    game.step(node ? Math.max(0, node.targetTick() - game.tick - 1) : 0);
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
      if (population && !stopped && !failure && game.tick > before) {
        const adjustmentStarted = performance.now();
        const adjustment = population.observe({ nowMs: adjustmentStarted, workMs: timing.workMs, ticks: timing.ticks,
          debt: node ? Math.max(0, node.targetTick() - game.tick) : Math.max(0, Math.ceil((adjustmentStarted - nextTickAt) / tickMs)),
          population: game.players.size });
        if (adjustment.changed) {
          refillBots();
          if (log) console.log(`[population] seed ${seed}: target ${population.target}/${targetPop}, `+
            `${game.players.size} present (${adjustment.reason})`);
        }
        // Charge controller work and any population adjustment to subsequent
        // observations rather than making their cost invisible to the policy.
        const adjustmentMs = performance.now() - adjustmentStarted;
        timing.workMs += adjustmentMs;
        timing.maxBatchMs = Math.max(timing.maxBatchMs, workMs + adjustmentMs);
      }
    }
  };

  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => closing ??= (async () => {
    stopped = true; ready = false;
    clearTimeout(timer); clearImmediate(immediate);
    clearInterval(heartbeat); clearInterval(botTimer); clearInterval(saveTimer);clearTimeout(botRefill);
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
        console.log(`MMOFPS server on http://localhost:${actualPort}  (seed ${seed}, population ${population ? `${population.status.minimum}-${targetPop} adaptive` : targetPop}, tick ${TICK_RATE} Hz)`);
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
