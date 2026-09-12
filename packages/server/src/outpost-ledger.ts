import type { DatabaseSync } from 'node:sqlite';
import { OUTPOST_TYPES, OUTPOST_OWNER_LIMIT, OUTPOST_CELL_LIMIT, OUTPOST_CELL, outpostCell, validOutpostSite, type Outpost, type OutpostSite } from '@shared/outposts';
import type { PlanetId } from '@shared/universe';
import type { RegionBounds } from '@shared/regions';
import type { SavedPlayer } from './persistence.js';
import { isFaction } from '@shared/frontier';
import type { OutpostCellUpdate } from './outpost-replica.js';

// The client sees at most two neighboring 128 m cells in each direction.
// Three cells also cover modules whose walls extend across the region seam.
export const OUTPOST_REGION_HALO = OUTPOST_CELL * 3;

/** Uses the coordinator's transaction: a structure, its payment receipt and
 * the character checkpoint commit together. Cumulative spending reconciles
 * delayed checkpoints captured before the construction response arrived. */
export class OutpostLedger {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS salvage_spending (key TEXT PRIMARY KEY, total INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS salvage_earnings (key TEXT PRIMARY KEY, total INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS outposts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, request TEXT NOT NULL UNIQUE, key TEXT NOT NULL,
        planet TEXT NOT NULL, cell TEXT NOT NULL, site TEXT NOT NULL, removed INTEGER NOT NULL DEFAULT 0,
        x REAL NOT NULL, z REAL NOT NULL, revision INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE INDEX IF NOT EXISTS outpost_planet_cell ON outposts(planet,cell,removed);
      CREATE INDEX IF NOT EXISTS outpost_owner ON outposts(key,removed);
      CREATE TABLE IF NOT EXISTS outpost_clock (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL) STRICT;
      INSERT OR IGNORE INTO outpost_clock(id,revision) VALUES(1,0);
      CREATE TABLE IF NOT EXISTS outpost_cell_revisions (
        planet TEXT NOT NULL, cx INTEGER NOT NULL, cz INTEGER NOT NULL, revision INTEGER NOT NULL,
        PRIMARY KEY(planet,cx,cz)
      ) STRICT;`);
    const columns = db.prepare('PRAGMA table_info(outposts)').all() as { name: string }[];
    const migration = ['x', 'z', 'revision'].some(name => !columns.some(c => c.name === name));
    for (const name of ['x', 'z', 'revision']) if (!columns.some(c => c.name === name)) {
      db.exec(`ALTER TABLE outposts ADD COLUMN ${name} ${name === 'revision' ? 'INTEGER' : 'REAL'} NOT NULL DEFAULT 0`);
    }
    db.exec(`UPDATE outpost_clock SET revision=MAX(revision,
      (SELECT COALESCE(MAX(revision),0) FROM outposts),
      (SELECT COALESCE(MAX(revision),0) FROM outpost_cell_revisions)) WHERE id=1;`);
    // Coordinator startup wraps this entire migration in one transaction.
    // Tombstones retain their location/version so packing the final module
    // still invalidates a previously populated neighboring view.
    {
      // Node 22.11 has StatementSync.all(), but not the later iterate() API.
      // Keyset pages bound migration memory even with many packed modules.
      const first = db.prepare(`SELECT id,planet,site FROM outposts ${migration ? '' : 'WHERE revision=0'} ORDER BY id LIMIT 512`);
      const next = db.prepare(`SELECT id,planet,site FROM outposts WHERE id>? ${migration ? '' : 'AND revision=0'} ORDER BY id LIMIT 512`);
      const update = db.prepare('UPDATE outposts SET x=?,z=?,revision=?,cell=? WHERE id=?');
      let revision = 0;
      let batch = first.all() as { id: number; planet: PlanetId; site: string }[];
      while (batch.length) {
        for (const row of batch) {
          const site = JSON.parse(row.site) as Outpost;
          if (!validOutpostSite(site) || site.id !== row.id || !Number.isSafeInteger(site.id) || site.id < 1 ||
              !Number.isSafeInteger(site.owner) || site.owner < 1 || !isFaction(site.faction))
            throw new Error('Invalid persisted camp geometry');
          if (!revision) revision = this.nextRevision();
          update.run(site.x, site.z, revision, outpostCell(site.x, site.z), row.id);
          this.touch(row.planet, site.x, site.z, revision);
        }
        batch = next.all(batch[batch.length - 1].id) as typeof batch;
      }
    }
    db.exec('CREATE INDEX IF NOT EXISTS outpost_planet_position ON outposts(planet,removed,x,z)');
  }
  reconcile(key: string, state: SavedPlayer): SavedPlayer {
    const total = (this.db.prepare('SELECT total FROM salvage_spending WHERE key=?').get(key) as { total: number } | undefined)?.total ?? 0;
    const accounted = state.salvageSpent ?? 0;
    const earned = (this.db.prepare('SELECT total FROM salvage_earnings WHERE key=?').get(key) as { total: number } | undefined)?.total ?? 0;
    const credited = state.salvageEarned ?? 0;
    if (!Number.isSafeInteger(accounted) || accounted < 0 || accounted > total || !Number.isFinite(state.salvage) || state.salvage < 0 ||
        !Number.isSafeInteger(credited) || credited < 0 || credited > earned) throw new Error('Invalid salvage ledger watermark');
    const salvage = Math.max(0, state.salvage + (earned - credited) - (total - accounted));
    if (!Number.isFinite(salvage) || salvage > Number.MAX_SAFE_INTEGER) throw new Error('Invalid salvage balance');
    return { ...state, salvage, salvageSpent: total, salvageEarned: earned };
  }
  list(planet: PlanetId): Outpost[] {
    return (this.db.prepare('SELECT site FROM outposts WHERE planet=? AND removed=0 ORDER BY id').all(planet) as { site: string }[]).map(r => JSON.parse(r.site) as Outpost);
  }
  site(planet: PlanetId, id: number): Outpost | undefined {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid module');
    const row = this.db.prepare('SELECT site FROM outposts WHERE id=? AND planet=?').get(id, planet) as { site: string } | undefined;
    return row ? JSON.parse(row.site) as Outpost : undefined;
  }
  viewRevision(planet: PlanetId, bounds: RegionBounds): number {
    const h = OUTPOST_REGION_HALO;
    const row = this.db.prepare(`SELECT COALESCE(MAX(revision),0) revision FROM outpost_cell_revisions
      WHERE planet=? AND cx>=? AND cx<=? AND cz>=? AND cz<=?`).get(planet,
      Math.floor((bounds.minX - h) / OUTPOST_CELL), Math.floor((bounds.maxX + h) / OUTPOST_CELL),
      Math.floor((bounds.minZ - h) / OUTPOST_CELL), Math.floor((bounds.maxZ + h) / OUTPOST_CELL)) as { revision: number };
    return row.revision;
  }
  listRegion(planet: PlanetId, bounds: RegionBounds): Outpost[] {
    const h = OUTPOST_REGION_HALO;
    return (this.db.prepare(`SELECT site FROM outposts WHERE planet=? AND removed=0
      AND x>=? AND x<? AND z>=? AND z<? ORDER BY id`).all(planet,
      bounds.minX - h, bounds.maxX + h, bounds.minZ - h, bounds.maxZ + h) as { site: string }[])
      .map(row => JSON.parse(row.site) as Outpost);
  }
  cell(planet: PlanetId, x: number, z: number): OutpostCellUpdate {
    const key = outpostCell(x, z), cx = Math.floor(x / OUTPOST_CELL), cz = Math.floor(z / OUTPOST_CELL);
    const revision = (this.db.prepare('SELECT revision FROM outpost_cell_revisions WHERE planet=? AND cx=? AND cz=?')
      .get(planet, cx, cz) as { revision: number } | undefined)?.revision ?? 0;
    const sites = (this.db.prepare('SELECT site FROM outposts WHERE planet=? AND cell=? AND removed=0 ORDER BY id')
      .all(planet, key) as { site: string }[]).map(row => JSON.parse(row.site) as Outpost);
    return { key, revision, sites };
  }
  private nextRevision(): number {
    const row = this.db.prepare('UPDATE outpost_clock SET revision=revision+1 WHERE id=1 AND revision<? RETURNING revision')
      .get(Number.MAX_SAFE_INTEGER) as { revision: number } | undefined;
    if (!row) throw new Error('Construction revision space is exhausted');
    return row.revision;
  }
  private touch(planet: PlanetId, x: number, z: number, revision: number): void {
    this.db.prepare(`INSERT INTO outpost_cell_revisions(planet,cx,cz,revision) VALUES(?,?,?,?)
      ON CONFLICT(planet,cx,cz) DO UPDATE SET revision=MAX(revision,excluded.revision)`)
      .run(planet, Math.floor(x / OUTPOST_CELL), Math.floor(z / OUTPOST_CELL), revision);
  }
  build(key: string, owner: number, planet: PlanetId, request: string, site: OutpostSite, state: SavedPlayer): { site: Outpost; state: SavedPlayer; revision: number } {
    if (!/^[a-f0-9-]{16,80}$/.test(request) || !validOutpostSite(site) || !isFaction(state.faction)) throw new Error('Invalid construction record');
    const old = this.db.prepare('SELECT key,planet,site,removed,revision FROM outposts WHERE request=?').get(request) as { key: string; planet: string; site: string; removed: number; revision: number } | undefined;
    if (old) {
      const saved = JSON.parse(old.site) as Outpost;
      if (old.key !== key || old.planet !== planet || old.removed || ['type', 'x', 'y', 'z', 'facing'].some(k => saved[k as keyof OutpostSite] !== site[k as keyof OutpostSite])) throw new Error('Construction retry does not match');
      return { site: saved, state: this.reconcile(key, state), revision: old.revision };
    }
    const balance = this.reconcile(key, state), cost = OUTPOST_TYPES[site.type].cost;
    if (balance.salvage < cost) throw new Error('Not enough salvage. Extract xenolite or discover another city.');
    const count = (query: string, ...values: (string | number)[]) => (this.db.prepare(query).get(...values) as { n: number }).n;
    if (count('SELECT count(*) n FROM outposts WHERE key=? AND removed=0', key) >= OUTPOST_OWNER_LIMIT) throw new Error('Pack an old module before building another.');
    if (count('SELECT count(*) n FROM outposts WHERE planet=? AND cell=? AND removed=0', planet, outpostCell(site.x, site.z)) >= OUTPOST_CELL_LIMIT) throw new Error('This patch already has four modules. Build farther away.');
    if (count('SELECT count(*) n FROM outposts WHERE planet=? AND removed=0', planet) >= 8192) throw new Error('This world has reached its construction budget.');
    const total = (balance.salvageSpent ?? 0) + cost;
    this.db.prepare('INSERT INTO salvage_spending(key,total) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET total=excluded.total').run(key, total);
    const revision = this.nextRevision();
    const id = Number(this.db.prepare('INSERT INTO outposts(request,key,planet,cell,site,x,z,revision) VALUES(?,?,?,?,?,?,?,?)')
      .run(request, key, planet, outpostCell(site.x, site.z), '{}', site.x, site.z, revision).lastInsertRowid);
    if (id >= 0xffffffff) throw new Error('Construction identity space is exhausted');
    const built: Outpost = { ...site, id, owner, faction: state.faction as Outpost['faction'] };
    this.db.prepare('UPDATE outposts SET site=? WHERE id=?').run(JSON.stringify(built), id);
    this.touch(planet, site.x, site.z, revision);
    return { site: built, state: { ...balance, salvage: balance.salvage - cost, salvageSpent: total }, revision };
  }
  remove(key: string, planet: PlanetId, id: number): number {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid module');
    const row = this.db.prepare('SELECT key,planet,x,z,removed,revision FROM outposts WHERE id=?').get(id) as { key: string; planet: string; x: number; z: number; removed: number; revision: number } | undefined;
    if (!row || row.key !== key || row.planet !== planet) throw new Error('Only the owner can pack this module.');
    // Tombstones retain idempotency receipts. Packing deliberately gives no
    // salvage refund, avoiding a second credit transaction or offline farming.
    if (row.removed) return row.revision;
    const revision = this.nextRevision();
    this.db.prepare('UPDATE outposts SET removed=1,revision=? WHERE id=?').run(revision, id);
    this.touch(planet, row.x, row.z, revision);
    return revision;
  }
}
