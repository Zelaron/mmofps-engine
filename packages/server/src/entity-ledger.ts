import type { DatabaseSync } from 'node:sqlite';
import { entityBlockOf, MAX_ENTITY_BLOCK } from '@shared/entity-id';
import type { PlanetId } from '@shared/universe';
import { OwnershipError, type NodeRecord } from './coordinator.js';

export interface EntityReservation {
  request: string; node: string; planet: PlanetId; region: string; count: number; epoch?: number;
}
export interface EntityGrant extends EntityReservation { firstBlock: number }
interface Binding { planet: PlanetId; region: string; bootstrap_request: string }
interface Issuance {
  request: string; node: string; planet: PlanetId; region: string; epoch: number;
  first_block: number; count: number;
}

/** Called inside the coordinator transaction. Reservations are never reclaimed:
 * an entity may outlive its original worker in another region. The ledger stores
 * one row per batch, rather than writing once per shot, creature or pickup. */
export class EntityLedger {
  constructor(private readonly db: DatabaseSync, private readonly node: (id: string) => NodeRecord | null) {
    db.exec(`CREATE TABLE IF NOT EXISTS entity_processes (
      id TEXT PRIMARY KEY, planet TEXT NOT NULL, region TEXT NOT NULL, bootstrap_request TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS entity_blocks (
      request TEXT PRIMARY KEY, node TEXT NOT NULL, planet TEXT NOT NULL, region TEXT NOT NULL,
      epoch INTEGER NOT NULL, first_block INTEGER NOT NULL UNIQUE, count INTEGER NOT NULL
    ) STRICT;
    INSERT OR IGNORE INTO sequences(name,next) VALUES('entity_block',0);
    UPDATE sequences SET next=MAX(next,COALESCE((SELECT MAX(first_block+count) FROM entity_blocks),0)) WHERE name='entity_block';`);
  }
  checkRegistration(id: string, planet: PlanetId, region: string): void {
    const binding = this.binding(id);
    if (binding && (binding.planet !== planet || binding.region !== region)) {
      throw new OwnershipError('fenced', 'Entity allocation belongs to a different world region');
    }
  }
  reserve(r: EntityReservation): EntityGrant {
    if (!r || typeof r.request !== 'string' || !/^[a-zA-Z0-9:_-]{16,120}$/.test(r.request) ||
        typeof r.node !== 'string' || !/^[a-zA-Z0-9:_-]{1,120}$/.test(r.node) ||
        !Number.isSafeInteger(r.count) || r.count < 1 || r.count > 32 ||
        r.epoch !== undefined && (!Number.isSafeInteger(r.epoch) || r.epoch < 1)) {
      throw new OwnershipError('invalid', 'Invalid entity reservation');
    }
    this.checkRegistration(r.node, r.planet, r.region);
    const binding = this.binding(r.node);
    if (r.epoch === undefined) {
      // Only the same unregistered startup can recover a lost bootstrap reply.
      // A cold restart must have a fresh process ID and obtain fresh blocks.
      if (this.db.prepare('SELECT 1 FROM world_incarnations WHERE id=?').get(r.node) ||
          binding && binding.bootstrap_request !== r.request) {
        throw new OwnershipError('fenced', 'World process ID has already bootstrapped; start with a fresh ID');
      }
    } else {
      const owner = this.node(r.node);
      if (!binding || !owner || owner.epoch !== r.epoch || owner.planet !== r.planet || owner.region !== r.region) {
        throw new OwnershipError('fenced', 'Entity reservation requires current world authority');
      }
    }
    // Authority is checked before serving even a cached reply.
    const old = this.db.prepare('SELECT * FROM entity_blocks WHERE request=?').get(r.request) as unknown as Issuance | undefined;
    if (old) {
      if (old.node !== r.node || old.planet !== r.planet || old.region !== r.region || old.count !== r.count || old.epoch !== (r.epoch ?? 0)) {
        throw new OwnershipError('invalid', 'Entity reservation request was reused with different parameters');
      }
      return this.grant(old);
    }
    const row = this.db.prepare("SELECT next FROM sequences WHERE name='entity_block'").get() as { next: number };
    if (!Number.isSafeInteger(row.next) || row.next < 0 || row.next > MAX_ENTITY_BLOCK - r.count + 1) {
      throw new OwnershipError('full', 'Entity ID space is exhausted');
    }
    if (!binding) this.db.prepare('INSERT INTO entity_processes VALUES(?,?,?,?)').run(r.node, r.planet, r.region, r.request);
    this.db.prepare('INSERT INTO entity_blocks VALUES(?,?,?,?,?,?,?)').run(r.request, r.node, r.planet, r.region, r.epoch ?? 0, row.next, r.count);
    this.db.prepare("UPDATE sequences SET next=? WHERE name='entity_block'").run(row.next + r.count);
    return { ...r, firstBlock: row.next };
  }
  originated(id: number, source: Pick<NodeRecord, 'id' | 'planet' | 'region'>): boolean {
    const block = entityBlockOf(id);
    if (block === null) return false;
    // Unique first_block index gives a logarithmic predecessor lookup.
    const row = this.db.prepare('SELECT node,planet,region,first_block,count FROM entity_blocks WHERE first_block<=? ORDER BY first_block DESC LIMIT 1')
      .get(block) as unknown as Issuance | undefined;
    return !!row && block < row.first_block + row.count && row.node === source.id && row.planet === source.planet && row.region === source.region;
  }
  private binding(id: string): Binding | undefined {
    return this.db.prepare('SELECT planet,region,bootstrap_request FROM entity_processes WHERE id=?').get(id) as unknown as Binding | undefined;
  }
  private grant(r: Issuance): EntityGrant {
    return { request: r.request, node: r.node, planet: r.planet, region: r.region, count: r.count,
      firstBlock: r.first_block, ...(r.epoch ? { epoch: r.epoch } : {}) };
  }
}
