import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, open } from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isFaction } from '@shared/frontier';
import { capsuleClearance } from '@shared/physics';
import { WORLD, PLAYER, TICK_RATE } from '@shared/constants';
import { WEAPONS } from '@shared/weapons';
import type { Game, ServerPlayer } from './game.js';

export interface SavedPlayer {
  version: 1; seed: number; savedAt: number; faction: number; salvage: number; discoveries: string[];
  arrival?: boolean;
  salvageSpent?: number;
  salvageEarned?: number;
  x: number; y: number; z: number; health: number; alive: boolean;
  frags: number; deaths: number; factionWait: number; combatWait: number;
  ammo: { magazine: number; reserve: number }[];
}
export function capturePlayer(game: Pick<Game, 'seed' | 'tick'>,
  p: Omit<ServerPlayer, 'sink' | 'discoveries' | 'fullPickupContacts'> & { discoveries: Iterable<string> }): SavedPlayer {
  return { version: 1, seed: game.seed, savedAt: Date.now(), faction: p.faction, salvage: p.salvage, salvageSpent: p.salvageSpent, salvageEarned: p.salvageEarned,
    discoveries: [...p.discoveries], x: p.state.px, y: p.state.py, z: p.state.pz,
    health: p.health, alive: p.state.alive, frags: p.frags, deaths: p.deaths,
    factionWait: Math.max(0, p.factionChangeAt - game.tick) / TICK_RATE,
    combatWait: Math.max(0, p.regenBlockUntil - game.tick) / TICK_RATE,
    ammo: p.ammo.map(a => ({ ...a })) };
}
export function restorePlayer(game: Game, p: ServerPlayer, value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const data = value as SavedPlayer;
  if (data.version !== 1 || data.seed !== game.seed || !isFaction(data.faction)) return;
  p.faction = data.faction;
  const bounded = (n: unknown, max: number, fallback = 0): number => typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(max, n)) : fallback;
  p.salvage = bounded(data.salvage, 1_000_000, 30);
  p.salvageSpent = Math.floor(bounded(data.salvageSpent, Number.MAX_SAFE_INTEGER));
  p.salvageEarned = Math.floor(bounded(data.salvageEarned, Number.MAX_SAFE_INTEGER));
  p.discoveries = new Set(Array.isArray(data.discoveries) ? data.discoveries.filter(d => typeof d === 'string' && /^(?:\d{1,10}:)?city-[0-3]$/.test(d)).map(d => d.includes(':') ? d : `${data.seed}:${d}`) : []);
  p.frags = bounded(data.frags, 32767); p.deaths = bounded(data.deaths, 32767);
  const elapsed = Math.max(0, (Date.now() - bounded(data.savedAt, Date.now(), Date.now())) / 1000);
  p.factionChangeAt = game.tick + Math.max(0, bounded(data.factionWait, 30) - elapsed) * TICK_RATE;
  p.regenBlockUntil = game.tick + Math.max(0, bounded(data.combatWait, PLAYER.REGEN_DELAY) - elapsed) * TICK_RATE;
  p.health = bounded(data.health, PLAYER.MAX_HEALTH, PLAYER.MAX_HEALTH);
  p.state.alive = data.alive === true && p.health > 0;
  if (!p.state.alive) { p.health = 0; p.respawnAtTick = game.tick + 3 * TICK_RATE; }
  if (data.arrival) {
    const port = game.world.collectTransportPlan().pods[0];
    if (port) { p.state.px = port.x; p.state.py = port.y + .12; p.state.pz = port.z; }
  } else if ([data.x, data.y, data.z].every(Number.isFinite) && Math.abs(data.x) < WORLD.BORDER - 5 && Math.abs(data.z) < WORLD.BORDER - 5 && data.y > WORLD.KILL_Y + 5 && data.y < 1000 && capsuleClearance(game.world, data.x, data.y, data.z) > -.1) {
    p.state.px = data.x; p.state.py = data.y; p.state.pz = data.z;
  }
  if (Array.isArray(data.ammo)) for (const def of WEAPONS) {
    const a = data.ammo[def.id];
    if (a) p.ammo[def.id] = { magazine: Math.floor(bounded(a.magazine, def.magazineSize)), reserve: Math.floor(bounded(a.reserve, def.reserveSize)) };
  }
}

/** Per-record files bound the active memory set; writes serialize per filename.
 * A database/ownership service is required for cross-machine player handoff. */
export class WorldStore {
  private readonly writes = new Map<string, Promise<void>>();
  constructor(readonly root: string) {}
  private async load(file: string): Promise<unknown> {
    await this.writes.get(file);
    try { return JSON.parse(await readFile(path.join(this.root, file), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  private put(file: string, value: unknown): Promise<void> {
    const json = JSON.stringify(value);
    const previous = this.writes.get(file) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      const target = path.join(this.root, file), temp = `${target}.tmp`;
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(temp, json);
      const fd = await open(temp, 'r+');
      try { await fd.sync(); } finally { await fd.close(); }
      await rename(temp, target);
    });
    this.writes.set(file, pending);
    void pending.finally(() => { if (this.writes.get(file) === pending) this.writes.delete(file); }).catch(() => {});
    return pending;
  }
  loadWorld(): Promise<unknown> { return this.load('world.json'); }
  saveWorld(value: unknown): Promise<void> { return this.put('world.json', value); }
  loadPlayer(key: string): Promise<unknown> { return this.load(this.playerFile(key)); }
  savePlayer(key: string, value: SavedPlayer): Promise<void> { return this.put(this.playerFile(key), value); }
  private playerFile(key: string): string {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid player key');
    return `players/${key.slice(0, 2)}/${key}.json`;
  }
  async flush(): Promise<void> { await Promise.all([...this.writes.values()]); }
}

export function sessionKey(req: IncomingMessage): string | null {
  const token = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('mmofps-session='))?.slice(15);
  return token && /^[a-f0-9]{64}$/.test(token) ? createHash('sha256').update(token).digest('hex') : null;
}
export function ensureSession(req: IncomingMessage, res: ServerResponse, extra: object = {}): void {
  if (!sessionKey(req)) {
    const secure = 'encrypted' in req.socket && req.socket.encrypted;
    res.setHeader('Set-Cookie', `mmofps-session=${randomBytes(32).toString('hex')}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure ? '; Secure' : ''}`);
  }
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ ready: true, ...extra }));
}
