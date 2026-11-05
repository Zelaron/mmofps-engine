import { EntityLedger, type EntityReservation } from './entity-ledger.js';
import { PlanetClocks } from './planet-clock.js';
import { OutpostLedger } from './outpost-ledger.js';
import { ResourceLedger, type ResourceReceipt } from './resource-ledger.js';
import { RESOURCE_REACH, resourceCandidate } from '@shared/resources';
import type { OutpostSite, Outpost } from '@shared/outposts';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { PLANETS, planetById, type PlanetId, type UniverseStatus } from '@shared/universe';
import type { SavedPlayer } from './persistence.js';
import { MAX_CHARACTER_ID, MAX_ENTITY_NAMESPACES } from '@shared/entity-id';
import { RegionGrid, type RegionLayout, type RegionBounds } from '@shared/regions';
import { RegionTransfers, type RegionalHandoffRequest, type AuthorityToken } from './region-transfers.js';
import { sameOutpostScope, type OutpostCursor, type RegionalOutposts, type OutpostCellUpdate } from './outpost-replica.js';
import { CampaignLedger, type CampaignDeparture, type CampaignExchangeRequest } from './campaign-ledger.js';

import { LEASE_MS, NODE_TIMEOUT_MS } from './ownership-constants.js';
export { LEASE_MS, NODE_TIMEOUT_MS } from './ownership-constants.js';
export type PlanetOwnership = NonNullable<UniverseStatus['planets'][number]['ownership']>;
export interface NodeRegistration {
  id: string; planet: PlanetId; region?: string; url: string; capacity: number; humans: number; tick: number; epoch?: number;
  /** Fractions and denominator include only control points owned by this region's simulation. */
  ownership?: PlanetOwnership;
  ownershipPoints?: number;
}
export interface NodeRecord extends NodeRegistration { region: string; epoch: number; leaseUntil: number }
export interface AuthorityGrant { epoch: number; ttl: number; clockTick: number }
export interface Ownership {
  key: string; entityId: number; planet: PlanetId; region: string; epoch: number; holder: string | null;
  leaseUntil: number; state: SavedPlayer | null; nodeId: string | null; nodeEpoch: number;
}
export interface LeaseGrant { entityId: number; epoch: number; ttl: number; planet: PlanetId; state: SavedPlayer | null }
export interface Checkpoint { key: string; epoch: number; holder: string; state: SavedPlayer }
export class OwnershipError extends Error {
  constructor(readonly code: 'busy' | 'moved' | 'fenced' | 'unavailable' | 'full' | 'invalid', message: string, readonly planet?: PlanetId) { super(message); }
}

/** One transactional writer for character ownership. Simulation never runs
 * here. Geography, inventory and epoch change together during handoff. */
export class Coordinator {
  private readonly db: DatabaseSync;
  private readonly camps: OutpostLedger;
  private readonly resources: ResourceLedger;
  private readonly nodes = new Map<string, NodeRecord>();
  private readonly authorities = new Map<string, NodeRecord>();
  private readonly grids = new Map<PlanetId, RegionGrid>();
  private regional!: RegionTransfers;
  private entities!: EntityLedger;
  private campaign!: CampaignLedger;
  private readonly now: () => number;
  private readonly clocks: PlanetClocks;
  /** Planets that make up this universe. Defaults to every implemented world
   * so embedded/test coordinators keep their behavior; the cluster narrows it. */
  private enabled: readonly PlanetId[] = PLANETS.map(p => p.id);
  constructor(file: string, wall: () => number = Date.now,
    monotonic: () => number = wall === Date.now ? () => performance.now() : wall) {
    const began = monotonic(), wallAtStart = wall();
    // Host time corrections cannot shorten a live worker's authority lease.
    this.now = () => Math.floor(wallAtStart + Math.max(0, monotonic() - began));
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    try {
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS players (
          key TEXT PRIMARY KEY, planet TEXT NOT NULL, epoch INTEGER NOT NULL,
          holder TEXT, lease_until INTEGER NOT NULL, state TEXT
        ) STRICT;
        CREATE INDEX IF NOT EXISTS player_planet_lease ON players(planet, lease_until);
        CREATE TABLE IF NOT EXISTS transfers (
          id TEXT PRIMARY KEY, key TEXT NOT NULL, source_epoch INTEGER NOT NULL,
          holder TEXT NOT NULL, destination TEXT NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS transfer_age ON transfers(created_at);`);
      this.camps = this.transaction(() => new OutpostLedger(this.db));
      this.resources = this.transaction(() => new ResourceLedger(this.db));
      this.clocks = new PlanetClocks(this.db, wall, monotonic);
      this.transaction(() => {
        const columns = this.db.prepare('PRAGMA table_info(players)').all() as { name: string }[];
        if (!columns.some(c => c.name === 'node_id')) this.db.exec('ALTER TABLE players ADD COLUMN node_id TEXT');
        if (!columns.some(c => c.name === 'node_epoch')) this.db.exec('ALTER TABLE players ADD COLUMN node_epoch INTEGER');
        if (!columns.some(c => c.name === 'region')) this.db.exec("ALTER TABLE players ADD COLUMN region TEXT NOT NULL DEFAULT 'world'");
        if (!columns.some(c => c.name === 'entity_id')) this.db.exec('ALTER TABLE players ADD COLUMN entity_id INTEGER');
        this.db.exec(`UPDATE players SET entity_id=rowid WHERE entity_id IS NULL;
          CREATE UNIQUE INDEX IF NOT EXISTS player_entity_id ON players(entity_id);
          CREATE TABLE IF NOT EXISTS entity_namespaces (id INTEGER PRIMARY KEY, planet TEXT NOT NULL, region TEXT NOT NULL, UNIQUE(planet,region)) STRICT;
          CREATE TABLE IF NOT EXISTS sequences (name TEXT PRIMARY KEY, next INTEGER NOT NULL) STRICT;
          INSERT OR IGNORE INTO sequences(name,next) SELECT 'character',COALESCE(MAX(entity_id),0)+1 FROM players;
          UPDATE sequences SET next=MAX(next,(SELECT COALESCE(MAX(entity_id),0)+1 FROM players)) WHERE name='character';`);
        this.db.exec(`CREATE TABLE IF NOT EXISTS world_authorities (
          planet TEXT PRIMARY KEY, id TEXT NOT NULL, epoch INTEGER NOT NULL, lease_until INTEGER NOT NULL,
          url TEXT NOT NULL, capacity INTEGER NOT NULL, humans INTEGER NOT NULL, tick INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS world_incarnations (id TEXT PRIMARY KEY, planet TEXT NOT NULL) STRICT;`);
        const authorityColumns = this.db.prepare('PRAGMA table_info(world_authorities)').all() as { name: string }[];
        if (!authorityColumns.some(c => c.name === 'region')) this.db.exec(`
          ALTER TABLE world_authorities RENAME TO old_world_authorities;
          CREATE TABLE world_authorities (
            planet TEXT NOT NULL, region TEXT NOT NULL, id TEXT NOT NULL, epoch INTEGER NOT NULL, lease_until INTEGER NOT NULL,
            url TEXT NOT NULL, capacity INTEGER NOT NULL, humans INTEGER NOT NULL, tick INTEGER NOT NULL,
            PRIMARY KEY(planet,region)
          ) STRICT;
          INSERT INTO world_authorities SELECT planet,'world',id,epoch,lease_until,url,capacity,humans,tick FROM old_world_authorities;
          DROP TABLE old_world_authorities;`);
        const incarnationColumns = this.db.prepare('PRAGMA table_info(world_incarnations)').all() as { name: string }[];
        if (!incarnationColumns.some(c => c.name === 'region')) this.db.exec("ALTER TABLE world_incarnations ADD COLUMN region TEXT NOT NULL DEFAULT 'world'");
        this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS world_authority_process ON world_authorities(id);
          CREATE TABLE IF NOT EXISTS region_layouts (planet TEXT PRIMARY KEY, layout TEXT NOT NULL) STRICT;
          CREATE INDEX IF NOT EXISTS player_region_lease ON players(planet,region,lease_until);`);
        for (const planet of PLANETS) this.grids.set(planet.id, new RegionGrid());
        for (const row of this.db.prepare('SELECT planet,layout FROM region_layouts').all() as { planet: PlanetId; layout: string }[]) {
          this.grids.set(row.planet, new RegionGrid(JSON.parse(row.layout)));
        }
        // A restarted coordinator cannot know how much monotonic lease time
        // surviving workers have left. Fence replacements for one full TTL.
        this.db.prepare('UPDATE world_authorities SET lease_until=? WHERE lease_until>0').run(this.now() + NODE_TIMEOUT_MS);
        this.db.prepare('UPDATE players SET lease_until=MIN(lease_until,?) WHERE holder IS NOT NULL').run(this.now() + LEASE_MS);
        for (const row of this.db.prepare('SELECT * FROM world_authorities').all() as Record<string, unknown>[]) {
          const record: NodeRecord = { id: String(row.id), planet: row.planet as PlanetId, region: String(row.region), epoch: Number(row.epoch),
            leaseUntil: Number(row.lease_until), url: String(row.url), capacity: Number(row.capacity), humans: Number(row.humans), tick: Number(row.tick) };
          this.nodes.set(record.id, record); this.authorities.set(`${record.planet}/${record.region}`, record);
        }
        const invalid = this.db.prepare('SELECT count(*) n FROM players WHERE entity_id<1 OR entity_id>?').get(MAX_CHARACTER_ID) as { n: number };
        if (invalid.n) throw new Error('Character database contains invalid entity IDs');
      });
      this.entities = this.transaction(() => new EntityLedger(this.db, id => this.node(id)));
      this.campaign = this.transaction(() => new CampaignLedger(this.db, { now: this.now, node: id => this.node(id),
        route: (planet, region) => this.route(planet, region), entityOrigin: (id, source) => this.entities.originated(id, source) }));
      this.regional = this.transaction(() => new RegionTransfers(this.db, {
        now: this.now, tick: planet => this.clocks.sample(planet), node: id => this.node(id), locate: key => this.locate(key),
        layout: planet => this.layout(planet), region: (planet, position) => this.region(planet, position),
        entityOrigin: (id, source) => this.entities.originated(id, source),
        reconcile: (key, state) => this.camps.reconcile(key, state), snapshot: (state, planet) => this.snapshotJson(state, planet),
      }));
    } catch (error) { this.db.close(); throw error; }
  }
  close(): void { this.db.close(); }
  /** Restrict the universe to these worlds. The first is the entry world. */
  enablePlanets(ids: readonly PlanetId[]): void {
    const valid = [...new Set(ids)].filter(id => planetById(id));
    if (!valid.length) throw new Error('At least one planet must be enabled');
    this.enabled = valid;
  }
  get enabledPlanets(): readonly PlanetId[] { return this.enabled; }
  get entryPlanet(): PlanetId { return this.enabled[0]; }
  planetEnabled(planet: PlanetId): boolean { return this.enabled.includes(planet); }
  /** A character saved on a world that is no longer part of the universe is
   * brought to the entry world's arrival terminal, keeping its inventory,
   * allegiance and progress. Live sessions are left alone; they are fenced by
   * their own leases. Returns true when the saved location changed. */
  relocateStranded(key: string): boolean {
    this.validateKey(key);
    return this.transaction(() => {
      const old = this.locate(key), now = this.now();
      if (!old || this.planetEnabled(old.planet)) return false;
      if (old.holder && old.leaseUntil > now) return false;
      if (this.regional.locked(key)) return false;
      const entry = planetById(this.entryPlanet)!;
      const region = this.region(entry.id).id;
      const state: SavedPlayer | null = old.state ? { ...this.camps.reconcile(key, old.state), seed: entry.seed, arrival: true, savedAt: now } : null;
      this.db.prepare('UPDATE players SET planet=?,region=?,node_id=NULL,node_epoch=NULL,epoch=?,holder=NULL,lease_until=0,state=? WHERE key=?')
        .run(entry.id, region, old.epoch + 1, state ? this.snapshotJson(state, entry.id) : null, key);
      return true;
    });
  }
  campaignExchange(request: CampaignExchangeRequest) { return this.transaction(() => this.campaign.exchange(request)); }
  departCampaign(request: CampaignDeparture) { return this.transaction(() => this.campaign.depart(request)); }
  cancelCampaign(request: CampaignDeparture) { return this.transaction(() => this.campaign.cancel(request)); }
  inspectCampaign(id: string, authority: AuthorityToken) { return this.transaction(() => this.campaign.inspect(id, authority)); }
  reserveEntities(request: EntityReservation) {
    if (!request || !planetById(request.planet) || typeof request.region !== 'string' || !this.grids.get(request.planet)!.get(request.region)) {
      throw new OwnershipError('invalid', 'Invalid entity reservation region');
    }
    return this.transaction(() => this.entities.reserve(request));
  }
  prepareRegional(request: RegionalHandoffRequest) { return this.transaction(() => this.regional.prepare(request)); }
  inspectRegional(id: string, authority: AuthorityToken) { return this.transaction(() => this.regional.inspect(id, authority)); }
  regionalPayload(id: string, destination: AuthorityToken) { return this.transaction(() => this.regional.payload(id, destination)); }
  readyRegional(id: string, destination: AuthorityToken, hash: string, tick: number) { return this.transaction(() => this.regional.ready(id, destination, hash, tick)); }
  commitRegional(id: string, source: AuthorityToken, hash: string) { return this.transaction(() => this.regional.commit(id, source, hash)); }
  abortRegional(id: string, authority: AuthorityToken) { return this.transaction(() => this.regional.abort(id, authority)); }
  regionalHullOwner(id: number) { return this.regional.hullOwner(id); }
  layout(planet: PlanetId): RegionLayout {
    const grid = this.grids.get(planet);
    if (!grid) throw new OwnershipError('invalid', 'Invalid region world');
    return grid.layout;
  }
  /** Explicit, durable maintenance operation. Workers cannot claim arbitrary
   * overlapping bounds or change geography while another authority is live. */
  configureRegions(planet: PlanetId, layout: RegionLayout): RegionLayout {
    const previous = this.layout(planet);
    let grid: RegionGrid;
    try { grid = new RegionGrid(layout); } catch (error) { throw new OwnershipError('invalid', (error as Error).message); }
    const json = JSON.stringify(grid.layout);
    if (json === JSON.stringify(previous)) return previous;
    if (grid.layout.version <= previous.version) throw new OwnershipError('invalid', 'Region layout version must advance');
    this.transaction(() => {
      const now = this.now();
      if ([...this.nodes.values()].some(n => n.planet === planet && n.leaseUntil > now) ||
          (this.db.prepare('SELECT count(*) n FROM players WHERE planet=? AND lease_until>?').get(planet, now) as { n: number }).n) {
        throw new OwnershipError('busy', 'Region layout changes require all world and character leases to expire');
      }
      this.db.prepare('INSERT INTO region_layouts(planet,layout) VALUES(?,?) ON CONFLICT(planet) DO UPDATE SET layout=excluded.layout').run(planet, json);
      this.db.prepare('DELETE FROM world_authorities WHERE planet=?').run(planet);
      this.regional.invalidatePlanet(planet);
      const update = this.db.prepare('UPDATE players SET region=?,epoch=epoch+1,holder=NULL,lease_until=0,node_id=NULL,node_epoch=NULL WHERE key=?');
      for (const row of this.db.prepare('SELECT key,state FROM players WHERE planet=?').all(planet) as { key: string; state: string | null }[]) {
        const state = row.state ? JSON.parse(row.state) as SavedPlayer : null;
        update.run(this.savedRegion(grid, state), row.key);
      }
    });
    this.grids.set(planet, grid);
    for (const [id, node] of this.nodes) if (node.planet === planet) { this.nodes.delete(id); this.authorities.delete(`${planet}/${node.region}`); }
    return grid.layout;
  }
  region(planet: PlanetId, position?: { x: number; z: number }): RegionBounds {
    this.layout(planet); const grid = this.grids.get(planet)!;
    try { return grid.at((position ?? grid.layout.entry).x, (position ?? grid.layout.entry).z); }
    catch { throw new OwnershipError('invalid', 'Invalid region position'); }
  }
  neighbors(planet: PlanetId, region: string, reach = 0): { bounds: RegionBounds; node: NodeRecord | null }[] {
    this.layout(planet);
    try { return this.grids.get(planet)!.neighbors(region, reach).map(bounds => ({ bounds, node: this.route(planet, bounds.id) })); }
    catch { throw new OwnershipError('invalid', 'Invalid region neighbors'); }
  }
  private savedRegion(grid: RegionGrid, state: SavedPlayer | null): string {
    const p = state && !state.arrival && Number.isFinite(state.x) && Number.isFinite(state.z) ? state : grid.layout.entry;
    return grid.at(p.x, p.z).id;
  }
  namespace(planet: PlanetId, region = 'world'): number {
    if (!planetById(planet) || !/^[a-zA-Z0-9:_-]{1,80}$/.test(region)) throw new OwnershipError('invalid', 'Invalid region namespace');
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT id FROM entity_namespaces WHERE planet=? AND region=?').get(planet, region) as { id: number } | undefined;
      if (existing) return existing.id - 1;
      const next = this.db.prepare('SELECT COALESCE(MAX(id),0)+1 id FROM entity_namespaces').get() as { id: number };
      if (next.id > MAX_ENTITY_NAMESPACES) throw new OwnershipError('full', 'Entity namespaces are exhausted');
      this.db.prepare('INSERT INTO entity_namespaces(id,planet,region) VALUES(?,?,?)').run(next.id, planet, region);
      return next.id - 1;
    });
  }
  register(node: NodeRegistration): AuthorityGrant {
    if (!planetById(node.planet) || !/^[a-zA-Z0-9:_-]{1,120}$/.test(node.id) ||
      !Number.isSafeInteger(node.capacity) || node.capacity < 1 || node.capacity > 4096 ||
      !Number.isSafeInteger(node.humans) || node.humans < 0 || node.humans > node.capacity ||
      !Number.isSafeInteger(node.tick) || node.tick < 0 ||
      node.epoch !== undefined && (!Number.isSafeInteger(node.epoch) || node.epoch < 1)) throw new OwnershipError('invalid', 'Invalid world registration');
    let ownership: PlanetOwnership | undefined;
    if (node.ownership !== undefined) {
      if (!Array.isArray(node.ownership) || node.ownership.length !== 4 ||
          node.ownership.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) ||
          Math.abs(node.ownership.reduce((sum, value) => sum + value, 0) - 1) > .000001 ||
          node.ownershipPoints !== undefined && (!Number.isSafeInteger(node.ownershipPoints) || node.ownershipPoints < 0 || node.ownershipPoints > 100000))
        throw new OwnershipError('invalid', 'Invalid territory ownership summary');
      const total = node.ownership.reduce((sum, value) => sum + value, 0);
      ownership = node.ownership.map(value => value / total) as PlanetOwnership;
    } else if (node.ownershipPoints !== undefined) throw new OwnershipError('invalid', 'Territory count requires an ownership summary');
    let url: URL;
    try { url = new URL(node.url); } catch { throw new OwnershipError('invalid', 'Invalid world endpoint'); }
    if (!['ws:', 'wss:'].includes(url.protocol)) throw new OwnershipError('invalid', 'Invalid world endpoint');
    const region = node.region ?? 'world';
    if (!this.grids.get(node.planet)!.get(region)) throw new OwnershipError('invalid', 'Region is not in the configured layout');
    this.entities.checkRegistration(node.id, node.planet, region);
    const { record, clockTick } = this.transaction(() => {
      const now = this.now();
      const previous = this.authorities.get(`${node.planet}/${region}`);
      if (node.epoch !== undefined && (!previous || previous.id !== node.id || previous.epoch !== node.epoch || previous.leaseUntil <= now)) {
        throw new OwnershipError('fenced', 'World authority expired or changed');
      }
      if (previous && previous.id !== node.id && previous.leaseUntil > now) throw new OwnershipError('busy', 'This region already has an authority');
      const known = this.db.prepare('SELECT planet FROM world_incarnations WHERE id=?').get(node.id);
      if (known && previous?.id !== node.id) throw new OwnershipError('fenced', 'World process ID was already retired');
      const epoch = previous?.id === node.id && previous.leaseUntil > now ? previous.epoch : (previous?.epoch ?? 0) + 1;
      const record: NodeRecord = { ...node, ownership, region, epoch, leaseUntil: now + NODE_TIMEOUT_MS };
      // A delayed retry can renew a live process without rolling a newer
      // territorial report back to an older simulation tick.
      if (previous?.id === node.id && previous.epoch === epoch && node.tick < previous.tick) {
        record.tick = previous.tick; record.ownership = previous.ownership; record.ownershipPoints = previous.ownershipPoints;
      }
      this.db.prepare(`INSERT INTO world_authorities(planet,region,id,epoch,lease_until,url,capacity,humans,tick) VALUES(?,?,?,?,?,?,?,?,?)
        ON CONFLICT(planet,region) DO UPDATE SET id=excluded.id,epoch=excluded.epoch,lease_until=excluded.lease_until,
        url=excluded.url,capacity=excluded.capacity,humans=excluded.humans,tick=excluded.tick`)
        .run(node.planet, region, node.id, epoch, record.leaseUntil, node.url, node.capacity, node.humans, record.tick);
      this.db.prepare('INSERT OR IGNORE INTO world_incarnations(id,planet,region) VALUES(?,?,?)').run(node.id, node.planet, region);
      return { record, clockTick: this.clocks.reserve(node.planet) };
    });
    const previous = this.authorities.get(`${node.planet}/${region}`); if (previous) this.nodes.delete(previous.id);
    this.nodes.set(record.id, record);
    this.authorities.set(`${node.planet}/${region}`, record);
    return { epoch: record.epoch, ttl: NODE_TIMEOUT_MS, clockTick };
  }
  unregister(id: string, epoch: number): boolean {
    const node = this.nodes.get(id);
    if (!node || node.epoch !== epoch) return false;
    this.db.prepare('UPDATE world_authorities SET lease_until=0 WHERE id=? AND epoch=?').run(id, epoch);
    node.leaseUntil = 0;
    return true;
  }
  node(id: string): NodeRecord | null {
    const node = this.nodes.get(id);
    return node && node.leaseUntil > this.now() ? { ...node, ...(node.ownership ? { ownership: [...node.ownership] as PlanetOwnership } : {}) } : null;
  }
  route(planet: PlanetId, region: string = this.region(planet).id): NodeRecord | null {
    const node = this.authorities.get(`${planet}/${region}`);
    return node && node.leaseUntil > this.now() ? { ...node, ...(node.ownership ? { ownership: [...node.ownership] as PlanetOwnership } : {}) } : null;
  }
  routeCharacter(key: string): NodeRecord | null {
    let owner = this.locate(key);
    if (owner && !this.planetEnabled(owner.planet) && this.relocateStranded(key)) owner = this.locate(key);
    const planet = owner?.planet ?? this.entryPlanet;
    return this.route(planet, this.savedRegion(this.grids.get(planet)!, owner?.state ?? null));
  }
  status(): UniverseStatus {
    return { system: 'Helios', stars: ['Helios A', 'Helios B'], planets: PLANETS.filter(p => this.planetEnabled(p.id)).map(p => {
      const node = this.route(p.id);
      // One current authority per configured region. Retired process records
      // cannot double-count a replacement's population or control points.
      const live = [...this.authorities.values()].filter(n => n.planet === p.id && n.leaseUntil > this.now());
      const reported = live.filter(n => n.ownership !== undefined), layout = this.grids.get(p.id)!.layout;
      const complete = reported.length === (layout.xCuts.length + 1) * (layout.zCuts.length + 1);
      const points = reported.reduce((sum, n) => sum + (n.ownershipPoints ?? 1), 0);
      let ownership: PlanetOwnership | undefined;
      if (complete && points > 0) {
        ownership = [0, 0, 0, 0];
        for (const report of reported) for (let faction = 0; faction < 4; faction++)
          ownership[faction] += report.ownership![faction] * (report.ownershipPoints ?? 1) / points;
      }
      const campaign = this.campaign.summary(p.id);
      return { id: p.id, available: !!node, players: live.reduce((n, v) => n + v.humans, 0),
        capacity: live.reduce((n, v) => n + v.capacity, 0), ...(ownership ? { ownership } : {}), ...(campaign ? { campaign } : {}) };
    }) };
  }
  private ownsWorld(owner: Ownership): boolean {
    const node = owner.nodeId ? this.node(owner.nodeId) : null;
    return !!node && node.planet === owner.planet && node.region === owner.region && node.epoch === owner.nodeEpoch;
  }
  locate(key: string): Ownership | null {
    this.validateKey(key);
    const row = this.db.prepare('SELECT * FROM players WHERE key=?').get(key) as Record<string, unknown> | undefined;
    return row ? { key, entityId: Number(row.entity_id), planet: row.planet as PlanetId, region: String(row.region), epoch: Number(row.epoch), holder: row.holder as string | null,
      nodeId: row.node_id as string | null, nodeEpoch: Number(row.node_epoch), leaseUntil: Number(row.lease_until), state: row.state ? JSON.parse(String(row.state)) as SavedPlayer : null } : null;
  }
  claim(key: string, planet: PlanetId, holder: string, nodeId: string, imported: SavedPlayer | null = null): LeaseGrant {
    this.validateKey(key); this.validateHolder(holder);
    const node = this.node(nodeId);
    if (!node || node.planet !== planet) throw new OwnershipError('unavailable', 'World is not available');
    if (!holder.startsWith(`${nodeId}:`)) throw new OwnershipError('invalid', 'Lease holder does not match world');
    return this.transaction(() => {
      const now = this.now(), old = this.locate(key);
      if (this.regional.locked(key)) throw new OwnershipError('busy', 'Character has a staged region crossing');
      if (old && old.planet !== planet) throw new OwnershipError('moved', 'Character is on another world', old.planet);
      if (old?.holder === holder && old.leaseUntil > now && this.ownsWorld(old)) return { entityId: old.entityId, epoch: old.epoch, ttl: old.leaseUntil - now, planet, state: old.state };
      if (old?.holder && old.leaseUntil > now && this.ownsWorld(old)) throw new OwnershipError('busy', 'Previous session is closing', planet);
      const state = old?.state ?? imported, region = this.savedRegion(this.grids.get(planet)!, state);
      if (node.region !== region) throw new OwnershipError('moved', 'Character belongs to another region', planet);
      const occupied = this.db.prepare('SELECT count(*) n FROM players WHERE planet=? AND region=? AND lease_until>? AND key<>? AND (holder IS NULL OR (node_id=? AND node_epoch=?))').get(planet, region, now, key, node.id, node.epoch) as { n: number };
      if (occupied.n + this.regional.reserved(node) >= node.capacity) throw new OwnershipError('full', 'World is full');
      const epoch = (old?.epoch ?? 0) + 1;
      const entityId = old?.entityId ?? Number((this.db.prepare("UPDATE sequences SET next=next+1 WHERE name='character' RETURNING next-1 id").get() as { id: number }).id);
      if (entityId > MAX_CHARACTER_ID) throw new OwnershipError('full', 'Character ID space is exhausted');
      const json = state ? this.snapshotJson(state, planet) : null;
      this.db.prepare(`INSERT INTO players(key,planet,region,epoch,holder,lease_until,state,entity_id,node_id,node_epoch) VALUES(?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(key) DO UPDATE SET region=excluded.region,epoch=excluded.epoch,holder=excluded.holder,lease_until=excluded.lease_until,state=excluded.state,node_id=excluded.node_id,node_epoch=excluded.node_epoch`).run(key, planet, region, epoch, holder, now + LEASE_MS, json, entityId, node.id, node.epoch);
      return { entityId, epoch, ttl: LEASE_MS, planet, state };
    });
  }
  checkpoint(rows: Checkpoint[]): { accepted: string[]; ttl: number } {
    if (rows.length > 512) throw new OwnershipError('invalid', 'Checkpoint batch too large');
    return this.transaction(() => {
      const now = this.now(), accepted: string[] = [];
      const update = this.db.prepare('UPDATE players SET state=?,lease_until=? WHERE key=? AND epoch=? AND holder=? AND lease_until>? AND planet=?');
      for (const row of rows) {
        this.validateKey(row.key); this.validateHolder(row.holder);
        const owner = this.locate(row.key);
        if (!owner || !this.ownsWorld(owner) || this.regional.locked(row.key)) continue;
        const result = update.run(this.snapshotJson(this.camps.reconcile(row.key, row.state)), now + LEASE_MS, row.key, row.epoch, row.holder, now, PLANETS.find(p => p.seed === row.state.seed)!.id);
        if (Number(result.changes)) accepted.push(row.key);
      }
      return { accepted, ttl: LEASE_MS };
    });
  }
  release(row: Checkpoint): boolean {
    this.validateKey(row.key); this.validateHolder(row.holder);
    const owner = this.locate(row.key);
    if (!owner || !this.ownsWorld(owner) || this.regional.locked(row.key)) return false;
    const result = this.db.prepare('UPDATE players SET state=?,holder=NULL,lease_until=0 WHERE key=? AND epoch=? AND holder=? AND lease_until>? AND planet=?')
      .run(this.snapshotJson(this.camps.reconcile(row.key, row.state)), row.key, row.epoch, row.holder, this.now(), PLANETS.find(p => p.seed === row.state.seed)!.id);
    return Number(result.changes) > 0;
  }
  /** An admitted socket can disappear before its first character snapshot. */
  vacate(key: string, epoch: number, holder: string): boolean {
    this.validateKey(key); this.validateHolder(holder);
    if (this.regional.locked(key)) return false;
    return Number(this.db.prepare('UPDATE players SET holder=NULL,lease_until=0 WHERE key=? AND epoch=? AND holder=?')
      .run(key, epoch, holder).changes) > 0;
  }
  transfer(row: Checkpoint, destination: PlanetId, id: string): { planet: PlanetId; epoch: number } {
    this.validateKey(row.key); this.validateHolder(row.holder);
    if (!/^[a-f0-9-]{16,80}$/.test(id) || !planetById(destination)) throw new OwnershipError('invalid', 'Invalid transfer');
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT * FROM transfers WHERE id=?').get(id) as Record<string, unknown> | undefined;
      if (previous) {
        if (previous.key !== row.key || previous.source_epoch !== row.epoch || previous.holder !== row.holder || previous.destination !== destination) throw new OwnershipError('invalid', 'Transfer request does not match');
        return JSON.parse(String(previous.result)) as { planet: PlanetId; epoch: number };
      }
      const old = this.locate(row.key), now = this.now();
      if (this.regional.locked(row.key)) throw new OwnershipError('busy', 'Character has a staged region crossing');
      if (!old || old.epoch !== row.epoch || old.holder !== row.holder || old.leaseUntil <= now) throw new OwnershipError('fenced', 'Session no longer owns this character');
      this.snapshotJson(row.state, old.planet);
      if (old.planet === destination) throw new OwnershipError('invalid', 'Already on this world');
      if (!this.planetEnabled(destination)) throw new OwnershipError('unavailable', 'Destination is not part of this universe');
      const node = this.route(destination);
      if (!node) throw new OwnershipError('unavailable', 'Destination is temporarily unavailable');
      if (!this.ownsWorld(old)) throw new OwnershipError('fenced', 'World authority changed');
      // Reservations include committed arrivals that have not connected yet.
      const occupied = this.db.prepare('SELECT count(*) n FROM players WHERE planet=? AND region=? AND lease_until>? AND (holder IS NULL OR (node_id=? AND node_epoch=?))').get(destination, node.region, now, node.id, node.epoch) as { n: number };
      if (occupied.n + this.regional.reserved(node) >= node.capacity) throw new OwnershipError('full', 'Destination is full');
      const state: SavedPlayer = { ...this.camps.reconcile(row.key, row.state), seed: planetById(destination)!.seed, arrival: true, savedAt: now };
      const result = { planet: destination, epoch: old.epoch + 1 };
      this.db.prepare('UPDATE players SET planet=?,region=?,node_id=?,node_epoch=?,epoch=?,holder=NULL,lease_until=?,state=? WHERE key=?')
        .run(destination, node.region, node.id, node.epoch, result.epoch, now + 30_000, this.snapshotJson(state), row.key);
      this.db.prepare('INSERT INTO transfers(id,key,source_epoch,holder,destination,result,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(id, row.key, row.epoch, row.holder, destination, JSON.stringify(result), now);
      return result;
    });
  }
  outposts(planet: PlanetId): Outpost[] {
    if (!planetById(planet)) throw new OwnershipError('invalid', 'Invalid world');
    return this.camps.list(planet);
  }
  regionalOutposts(authority: AuthorityToken, since?: OutpostCursor): RegionalOutposts {
    const node = authority && this.node(authority.id);
    if (!node || node.epoch !== authority.epoch) throw new OwnershipError('fenced', 'World authority changed');
    if (since && (!since.authority || !Number.isSafeInteger(since.authority.epoch) || since.authority.epoch < 1 ||
        typeof since.authority.id !== 'string' || typeof since.region !== 'string' || !planetById(since.planet) ||
        !Number.isSafeInteger(since.layoutVersion) || since.layoutVersion < 1 || !Number.isSafeInteger(since.revision) || since.revision < 0))
      throw new OwnershipError('invalid', 'Invalid camp view cursor');
    return this.transaction(() => {
      const grid = this.grids.get(node.planet)!, bounds = grid.get(node.region)!;
      const revision = this.camps.viewRevision(node.planet, bounds);
      const cursor: OutpostCursor = { authority: { id: node.id, epoch: node.epoch }, planet: node.planet,
        region: node.region, layoutVersion: grid.layout.version, revision };
      const unchanged = since && sameOutpostScope(since, cursor) && since.revision === revision;
      return { cursor, bounds, sites: unchanged ? null : this.camps.listRegion(node.planet, bounds) };
    });
  }
  construct(row: Checkpoint, request: string, site?: OutpostSite, remove?: number): { site: Outpost | null; spent: number; revision: number; cell: OutpostCellUpdate } {
    this.validateKey(row.key); this.validateHolder(row.holder);
    return this.transaction(() => {
      const owner = this.locate(row.key);
      if (this.regional.locked(row.key)) throw new OwnershipError('busy', 'Character has a staged region crossing');
      if (!owner || owner.epoch !== row.epoch || owner.holder !== row.holder || owner.leaseUntil <= this.now()) throw new OwnershipError('fenced', 'Character ownership changed');
      if (!this.ownsWorld(owner)) throw new OwnershipError('fenced', 'World authority changed');
      this.snapshotJson(row.state, owner.planet);
      try {
        const location = site ?? this.camps.site(owner.planet, remove!);
        if (location && this.region(owner.planet, location).id !== owner.region)
          throw new Error('Construction is temporarily unavailable at that location.');
        let result: { site: Outpost | null; state: SavedPlayer; revision: number };
        if (site) result = this.camps.build(row.key, owner.entityId, owner.planet, request, site, row.state);
        else {
          const revision = this.camps.remove(row.key, owner.planet, remove!);
          result = { site: null, state: this.camps.reconcile(row.key, row.state), revision };
        }
        this.db.prepare('UPDATE players SET state=? WHERE key=?').run(this.snapshotJson(result.state, owner.planet), row.key);
        return { site: result.site, spent: result.state.salvageSpent ?? 0, revision: result.revision,
          cell: this.camps.cell(owner.planet, location!.x, location!.z) };
      } catch (error) { throw new OwnershipError('invalid', (error as Error).message); }
    });
  }
  resourceView(authority: AuthorityToken, ids: string[]): { id: string; readyAt: number }[] {
    const node = authority && this.node(authority.id);
    if (!node || node.epoch !== authority.epoch) throw new OwnershipError('fenced', 'World authority changed');
    try {
      if (!Array.isArray(ids) || ids.length > 1024) throw new Error('Invalid resource view');
      const bounds = this.grids.get(node.planet)!.get(node.region)!;
      for (const id of ids) {
        const site = resourceCandidate(planetById(node.planet)!.seed, id);
        if (site.x < bounds.minX - 256 || site.x >= bounds.maxX + 256 || site.z < bounds.minZ - 256 || site.z >= bounds.maxZ + 256)
          throw new Error('Resource view is outside this region');
      }
      return this.resources.view(node.planet, ids);
    }
    catch (error) { throw new OwnershipError('invalid', (error as Error).message); }
  }
  harvest(row: Checkpoint, request: string, id: string, expected: number): ResourceReceipt {
    this.validateKey(row.key); this.validateHolder(row.holder);
    return this.transaction(() => {
      const owner = this.locate(row.key);
      if (this.regional.locked(row.key)) throw new OwnershipError('busy', 'Character has a staged region crossing');
      if (!owner || owner.epoch !== row.epoch || owner.holder !== row.holder || owner.leaseUntil <= this.now() || !this.ownsWorld(owner))
        throw new OwnershipError('fenced', 'Extraction ownership changed');
      this.snapshotJson(row.state, owner.planet);
      try {
        const location = resourceCandidate(planetById(owner.planet)!.seed, id);
        if (this.region(owner.planet, location).id !== owner.region) throw new Error('Extraction is temporarily unavailable across this boundary.');
        if (!row.state.alive || row.state.health <= 0 || !Number.isFinite(row.state.x + row.state.z) ||
            Math.hypot(row.state.x - location.x, row.state.z - location.z) > RESOURCE_REACH)
          throw new Error('Reach the deposit on foot before extracting.');
        const result = this.resources.harvest(row.key, owner.planet, request, id, expected,
          this.camps.reconcile(row.key, row.state), this.clocks.sample(owner.planet), this.now());
        this.db.prepare('UPDATE players SET state=? WHERE key=?').run(this.snapshotJson(result.state, owner.planet), row.key);
        return result.receipt;
      } catch (error) { throw new OwnershipError('invalid', (error as Error).message); }
    });
  }
  private validateKey(key: string): void { if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) throw new OwnershipError('invalid', 'Invalid identity'); }
  private validateHolder(holder: string): void { if (typeof holder !== 'string' || !/^[a-zA-Z0-9:_-]{1,180}$/.test(holder)) throw new OwnershipError('invalid', 'Invalid lease holder'); }
  private snapshotJson(state: SavedPlayer, planet?: PlanetId): string {
    const json = JSON.stringify(state);
    if (!state || state.version !== 1 || !PLANETS.some(p => p.seed === state.seed) || json.length > 16_384 || planet && planetById(planet)!.seed !== state.seed) throw new OwnershipError('invalid', 'Invalid character record');
    return json;
  }
  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
