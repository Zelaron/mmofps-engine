import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { TICK_RATE } from '@shared/constants';
import { namespaceRange, DYNAMIC_ENTITY_BASE } from '@shared/entity-id';
import { PLANETS, type PlanetId } from '@shared/universe';
import type { RegionBounds, RegionLayout } from '@shared/regions';
import { checkedHandoff, type RuntimeHandoff } from './runtime-handoff.js';
import { capturePlayer, type SavedPlayer } from './persistence.js';
import { OwnershipError, type NodeRecord, type Ownership } from './coordinator.js';
import { LEASE_MS } from './ownership-constants.js';

export interface AuthorityToken { id: string; epoch: number }
export interface HandoffMember { key: string; entityId: number; epoch: number; holder: string }
export interface RegionalHandoffRequest {
  id: string; source: AuthorityToken; destination: AuthorityToken; layoutVersion: number;
  members: HandoffMember[]; record: RuntimeHandoff;
}
export interface RegionalReceipt {
  id: string; planet: PlanetId; region: string; destination: AuthorityToken; layoutVersion: number;
  members: (HandoffMember & { leaseUntil: number })[];
  hulls: number[];
}
export interface RegionalOutcome {
  id: string; status: 'prepared' | 'committed' | 'aborted'; hash: string; expiresAt: number;
  receipt: RegionalReceipt | null;
}
interface StageRow {
  id: string; fingerprint: string; hash: string; planet: PlanetId; source_id: string; source_epoch: number;
  destination_id: string; destination_epoch: number; region: string; layout_version: number;
  expires_at: number; status: RegionalOutcome['status']; ready_tick: number | null;
  payload: string | null; members: string; result: string | null;
}
interface Access {
  now(): number; tick(planet: PlanetId): number;
  entityOrigin(id: number, source: NodeRecord): boolean;
  node(id: string): NodeRecord | null; locate(key: string): Ownership | null;
  layout(planet: PlanetId): RegionLayout; region(planet: PlanetId, position: { x: number; z: number }): RegionBounds;
  reconcile(key: string, state: SavedPlayer): SavedPlayer;
  snapshot(state: SavedPlayer, planet: PlanetId): string;
}
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function invalid(message: string): never { throw new OwnershipError('invalid', message); }

/** Runs inside the coordinator's transaction. A staged bundle reserves every
 * human and hull; commit changes all their owners in one durable write. */
export class RegionTransfers {
  constructor(private readonly db: DatabaseSync, private readonly access: Access) {
    db.exec(`CREATE TABLE IF NOT EXISTS region_handoffs (
      id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, hash TEXT NOT NULL, planet TEXT NOT NULL,
      source_id TEXT NOT NULL, source_epoch INTEGER NOT NULL, destination_id TEXT NOT NULL, destination_epoch INTEGER NOT NULL,
      region TEXT NOT NULL, layout_version INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('prepared','committed','aborted')), ready_tick INTEGER,
      payload TEXT, members TEXT NOT NULL, result TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS region_handoff_age ON region_handoffs(expires_at);
    CREATE INDEX IF NOT EXISTS region_preparation_age ON region_handoffs(expires_at) WHERE status='prepared';
    CREATE INDEX IF NOT EXISTS region_payload_age ON region_handoffs(expires_at) WHERE status<>'prepared' AND payload IS NOT NULL;
    CREATE TABLE IF NOT EXISTS region_reservations (
      key TEXT PRIMARY KEY, transfer_id TEXT NOT NULL, planet TEXT NOT NULL, region TEXT NOT NULL,
      destination_id TEXT NOT NULL, destination_epoch INTEGER NOT NULL, expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS region_reserved_capacity ON region_reservations(planet,region,expires_at);
    CREATE INDEX IF NOT EXISTS region_reservation_age ON region_reservations(expires_at);
    CREATE INDEX IF NOT EXISTS region_reservation_transfer ON region_reservations(transfer_id);
    CREATE TABLE IF NOT EXISTS region_hull_reservations (id INTEGER PRIMARY KEY, transfer_id TEXT NOT NULL, expires_at INTEGER NOT NULL) STRICT;
    CREATE INDEX IF NOT EXISTS region_hull_reservation_age ON region_hull_reservations(expires_at);
    CREATE INDEX IF NOT EXISTS region_hull_reservation_transfer ON region_hull_reservations(transfer_id);
    CREATE TABLE IF NOT EXISTS regional_hulls (id INTEGER PRIMARY KEY, planet TEXT NOT NULL, region TEXT NOT NULL,
      node_id TEXT NOT NULL, node_epoch INTEGER NOT NULL, transfer_id TEXT NOT NULL) STRICT;
    UPDATE region_handoffs SET status='aborted' WHERE status='prepared';
    DELETE FROM region_reservations; DELETE FROM region_hull_reservations;`);
    // Coordinator recovery deliberately invalidates uncommitted readiness.
    // Durable committed outcomes survive; uncertain preparation cannot resume.
  }
  locked(key: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM region_reservations WHERE key=? AND expires_at>?').get(key, this.access.now());
  }
  reserved(node: NodeRecord): number {
    return (this.db.prepare('SELECT count(*) n FROM region_reservations WHERE planet=? AND region=? AND destination_id=? AND destination_epoch=? AND expires_at>?')
      .get(node.planet, node.region, node.id, node.epoch, this.access.now()) as { n: number }).n;
  }
  invalidatePlanet(planet: PlanetId): void {
    this.db.prepare("UPDATE region_handoffs SET status='aborted' WHERE planet=? AND status='prepared'").run(planet);
    this.db.prepare('DELETE FROM region_hull_reservations WHERE transfer_id IN (SELECT id FROM region_handoffs WHERE planet=?)').run(planet);
    this.db.prepare('DELETE FROM region_reservations WHERE planet=?').run(planet);
    // All planetary authorities and character leases have already expired.
    // The current vehicle lifecycle cold-starts after layout maintenance.
    this.db.prepare('DELETE FROM regional_hulls WHERE planet=?').run(planet);
  }
  prepare(request: RegionalHandoffRequest): RegionalOutcome {
    if (!request || !/^[a-f0-9-]{16,80}$/.test(request.id) || !Array.isArray(request.members) ||
        request.members.length < 1 || request.members.length > 64) invalid('Invalid regional transfer');
    let record: RuntimeHandoff;
    try { record = checkedHandoff(request.record); } catch (error) { return invalid((error as Error).message); }
    const members = request.members.map(m => ({ key: m.key, entityId: m.entityId, epoch: m.epoch, holder: m.holder })).sort((a, b) => a.entityId - b.entityId);
    const fingerprint = hash({ source: { id: request.source?.id, epoch: request.source?.epoch },
      destination: { id: request.destination?.id, epoch: request.destination?.epoch }, layoutVersion: request.layoutVersion, members, record });
    const previous = this.row(request.id);
    if (previous) {
      if (previous.fingerprint !== fingerprint) invalid('Regional transfer retry does not match');
      return this.outcome(previous);
    }
    this.sweep();
    const source = this.authority(request.source), destination = this.authority(request.destination);
    if (source.planet !== destination.planet || source.region === destination.region ||
        PLANETS.find(p => p.id === source.planet)!.seed !== record.seed ||
        this.access.layout(source.planet).version !== request.layoutVersion) invalid('Regional transfer requires the same layout and a different region on this planet');
    if (record.players.some(p => p.isBot)) invalid('Bot controller handoff is not implemented');
    if (new Set(members.map(m => m.key)).size !== members.length || new Set(members.map(m => m.entityId)).size !== members.length ||
        members.length !== record.players.length) invalid('Regional transfer must include the complete crew');
    const now = this.access.now(), tick = this.access.tick(source.planet);
    if (record.tick < tick - 5 * TICK_RATE || record.tick > tick + TICK_RATE) invalid('Regional transfer clock is stale or ahead');
    const actors = new Map(record.players.map(p => [p.id, p])), hulls = new Map(record.vehicles.map(v => [v.id, v]));
    for (const member of members) {
      const actor = actors.get(member.entityId);
      if (!actor || !/^[a-f0-9]{64}$/.test(member.key)) invalid('Regional transfer member does not match its actor');
      this.memberOwner(member, source);
      if (this.locked(member.key)) throw new OwnershipError('busy', 'Character already has a staged crossing');
      const hull = actor.vehicleId >= 0 ? hulls.get(actor.vehicleId) : null;
      const position = hull ? { x: hull.x, z: hull.z } : { x: actor.state.px, z: actor.state.pz };
      if (this.access.region(source.planet, position).id !== destination.region) invalid('Crew has not entered the destination region');
      const saved = this.access.reconcile(member.key, capturePlayer(record, actor));
      actor.salvage = saved.salvage; actor.salvageSpent = saved.salvageSpent ?? 0;
      actor.salvageEarned = saved.salvageEarned ?? 0;
      this.db.prepare('UPDATE players SET state=? WHERE key=?').run(this.access.snapshot(saved, source.planet), member.key);
    }
    const occupied = (this.db.prepare('SELECT count(*) n FROM players WHERE planet=? AND region=? AND lease_until>? AND (holder IS NULL OR (node_id=? AND node_epoch=?))')
      .get(destination.planet, destination.region, now, destination.id, destination.epoch) as { n: number }).n;
    if (occupied + this.reserved(destination) + members.length > destination.capacity) throw new OwnershipError('full', 'Destination has no room for the complete crew');
    for (const hull of record.vehicles) {
      this.ownsHull(hull.id, source);
      if (this.db.prepare('SELECT 1 FROM region_hull_reservations WHERE id=? AND expires_at>?').get(hull.id, now)) throw new OwnershipError('busy', 'Hull already has a staged crossing');
    }
    const payload = JSON.stringify(record), digest = hash(record), expires = now + 5000;
    this.db.prepare(`INSERT INTO region_handoffs(id,fingerprint,hash,planet,source_id,source_epoch,destination_id,destination_epoch,
      region,layout_version,expires_at,status,ready_tick,payload,members,result) VALUES(?,?,?,?,?,?,?,?,?,?,?,'prepared',NULL,?,?,NULL)`)
      .run(request.id, fingerprint, digest, source.planet, source.id, source.epoch, destination.id, destination.epoch,
        destination.region, request.layoutVersion, expires, payload, JSON.stringify(members));
    for (const m of members) this.db.prepare('INSERT OR REPLACE INTO region_reservations VALUES(?,?,?,?,?,?,?)')
      .run(m.key, request.id, source.planet, destination.region, destination.id, destination.epoch, expires);
    for (const h of record.vehicles) this.db.prepare('INSERT OR REPLACE INTO region_hull_reservations VALUES(?,?,?)').run(h.id, request.id, expires);
    return this.outcome(this.row(request.id)!);
  }
  inspect(id: string, authority: AuthorityToken): RegionalOutcome {
    const row = this.requireRow(id); this.participant(row, authority); return this.outcome(row);
  }
  payload(id: string, destination: AuthorityToken): RuntimeHandoff {
    const row = this.requireRow(id); this.destination(row, destination); this.authority(destination);
    const outcome = this.outcome(row);
    if (outcome.status === 'aborted' || !row.payload) throw new OwnershipError('fenced', 'Regional transfer is no longer importable');
    if (outcome.status === 'committed') {
      const receipt = outcome.receipt!;
      for (const m of receipt.members) this.memberOwner(m, this.authority(destination));
    } else this.live(row);
    const record = JSON.parse(row.payload) as RuntimeHandoff;
    if (this.access.tick(row.planet) - record.tick > 5 * TICK_RATE) throw new OwnershipError('fenced', 'Regional simulation record has expired');
    return record;
  }
  ready(id: string, destination: AuthorityToken, digest: string, tick: number): RegionalOutcome {
    const row = this.requireRow(id); this.destination(row, destination);
    if (row.hash !== digest) invalid('Destination staged a different record');
    const outcome = this.outcome(row); if (outcome.status !== 'prepared') return outcome;
    this.live(row);
    const record = JSON.parse(row.payload!) as RuntimeHandoff;
    if (!Number.isSafeInteger(tick) || tick < record.tick || tick > record.tick + 5 * TICK_RATE ||
        Math.abs(tick - this.access.tick(row.planet)) > TICK_RATE) invalid('Destination has not caught up to the transfer');
    this.db.prepare('UPDATE region_handoffs SET ready_tick=? WHERE id=?').run(tick, id);
    return outcome;
  }
  commit(id: string, source: AuthorityToken, digest: string): RegionalOutcome {
    const row = this.requireRow(id);
    if (row.source_id !== source.id || row.source_epoch !== source.epoch || row.hash !== digest) invalid('Regional commit does not match its source');
    const outcome = this.outcome(row); if (outcome.status !== 'prepared') return outcome;
    const { destination, members } = this.live(row);
    if (row.ready_tick === null) throw new OwnershipError('busy', 'Destination has not staged this crew');
    const record = JSON.parse(row.payload!) as RuntimeHandoff;
    if (this.access.tick(row.planet) - record.tick > 5 * TICK_RATE) throw new OwnershipError('fenced', 'Regional transfer record expired');
    for (const hull of record.vehicles) this.ownsHull(hull.id, this.authority(source));
    const leaseUntil = this.access.now() + LEASE_MS;
    const receipt: RegionalReceipt = { id, planet: row.planet, region: row.region, destination: { id: destination.id, epoch: destination.epoch },
      layoutVersion: row.layout_version, hulls: record.vehicles.map(v => v.id), members: members.map(m => ({ ...m,
        epoch: m.epoch + 1, holder: `${destination.id}:handoff:${hash([id, m.entityId]).slice(0, 32)}`, leaseUntil })) };
    for (const member of receipt.members) this.db.prepare('UPDATE players SET region=?,node_id=?,node_epoch=?,epoch=?,holder=?,lease_until=? WHERE key=?')
      .run(row.region, destination.id, destination.epoch, member.epoch, member.holder, leaseUntil, member.key);
    for (const id of receipt.hulls) this.db.prepare(`INSERT INTO regional_hulls VALUES(?,?,?,?,?,?) ON CONFLICT(id)
      DO UPDATE SET region=excluded.region,node_id=excluded.node_id,node_epoch=excluded.node_epoch,transfer_id=excluded.transfer_id`)
      .run(id, row.planet, row.region, destination.id, destination.epoch, receipt.id);
    this.db.prepare("UPDATE region_handoffs SET status='committed',result=? WHERE id=?").run(JSON.stringify(receipt), id);
    this.unlock(id); return this.outcome(this.row(id)!);
  }
  abort(id: string, authority: AuthorityToken): RegionalOutcome {
    const row = this.requireRow(id); this.participant(row, authority);
    if (row.status === 'prepared') { this.db.prepare("UPDATE region_handoffs SET status='aborted' WHERE id=?").run(id); this.unlock(id); row.status = 'aborted'; }
    return this.outcome(row);
  }
  hullOwner(id: number): { planet: PlanetId; region: string; node_id: string; node_epoch: number; transfer_id: string } | null {
    return this.db.prepare('SELECT planet,region,node_id,node_epoch,transfer_id FROM regional_hulls WHERE id=?').get(id) as ReturnType<RegionTransfers['hullOwner']> ?? null;
  }
  private live(row: StageRow): { destination: NodeRecord; members: HandoffMember[] } {
    if (row.status !== 'prepared' || row.expires_at <= this.access.now() || this.access.layout(row.planet).version !== row.layout_version) throw new OwnershipError('fenced', 'Regional preparation expired');
    const source = this.authority({ id: row.source_id, epoch: row.source_epoch });
    const destination = this.authority({ id: row.destination_id, epoch: row.destination_epoch });
    const members = JSON.parse(row.members) as HandoffMember[];
    for (const m of members) this.memberOwner(m, source);
    return { destination, members };
  }
  private memberOwner(m: HandoffMember, node: NodeRecord): Ownership {
    const owner = this.access.locate(m.key);
    if (!owner || owner.entityId !== m.entityId || owner.epoch !== m.epoch || owner.holder !== m.holder ||
        owner.leaseUntil <= this.access.now() || owner.nodeId !== node.id || owner.nodeEpoch !== node.epoch ||
        owner.planet !== node.planet || owner.region !== node.region) throw new OwnershipError('fenced', 'A crew member no longer belongs to this authority');
    return owner;
  }
  private ownsHull(id: number, source: NodeRecord): void {
    const previous = this.hullOwner(id);
    if (previous) {
      if (previous.node_id !== source.id || previous.node_epoch !== source.epoch || previous.planet !== source.planet) throw new OwnershipError('fenced', 'Hull belongs to a different authority');
      return;
    }
    if (id >= DYNAMIC_ENTITY_BASE) {
      if (!this.access.entityOrigin(id, source)) invalid('Unowned hull was not issued to this source process');
      return;
    }
    const namespace = this.db.prepare('SELECT id FROM entity_namespaces WHERE planet=? AND region=?').get(source.planet, source.region) as { id: number } | undefined;
    if (!namespace) invalid('Source hull namespace is absent');
    const range = namespaceRange(namespace.id - 1);
    if (id < range.first || id > range.last) invalid('Unowned hull did not originate in the source region');
  }
  private authority(token: AuthorityToken): NodeRecord {
    if (!token || typeof token.id !== 'string' || !Number.isSafeInteger(token.epoch)) invalid('Invalid authority token');
    const node = this.access.node(token.id);
    if (!node || node.epoch !== token.epoch) throw new OwnershipError('fenced', 'Regional authority expired or changed');
    return node;
  }
  private participant(row: StageRow, token: AuthorityToken): void {
    if (!token || !(row.source_id === token.id && row.source_epoch === token.epoch || row.destination_id === token.id && row.destination_epoch === token.epoch)) invalid('Regional transfer participant does not match');
  }
  private destination(row: StageRow, token: AuthorityToken): void {
    if (!token || row.destination_id !== token.id || row.destination_epoch !== token.epoch) invalid('Regional destination does not match');
  }
  private row(id: string): StageRow | undefined { return this.db.prepare('SELECT * FROM region_handoffs WHERE id=?').get(id) as unknown as StageRow | undefined; }
  private requireRow(id: string): StageRow { return this.row(id) ?? invalid('Unknown regional transfer'); }
  private outcome(row: StageRow): RegionalOutcome {
    if (row.status === 'prepared' && row.expires_at <= this.access.now()) {
      this.db.prepare("UPDATE region_handoffs SET status='aborted' WHERE id=?").run(row.id); this.unlock(row.id); row.status = 'aborted';
    }
    return { id: row.id, status: row.status, hash: row.hash, expiresAt: row.expires_at, receipt: row.result ? JSON.parse(row.result) as RegionalReceipt : null };
  }
  private unlock(id: string): void {
    this.db.prepare('DELETE FROM region_reservations WHERE transfer_id=?').run(id);
    this.db.prepare('DELETE FROM region_hull_reservations WHERE transfer_id=?').run(id);
  }
  private sweep(): void {
    const now = this.access.now();
    this.db.prepare("UPDATE region_handoffs SET status='aborted' WHERE status='prepared' AND expires_at<=?").run(now);
    this.db.prepare('DELETE FROM region_reservations WHERE expires_at<=?').run(now);
    this.db.prepare('DELETE FROM region_hull_reservations WHERE expires_at<=?').run(now);
    // Runtime data has a five-second acceptance window. Keep small outcome
    // records for retries, but do not retain megabyte bundles indefinitely.
    this.db.prepare("UPDATE region_handoffs SET payload=NULL WHERE status<>'prepared' AND payload IS NOT NULL AND expires_at<?").run(now - 60_000);
    this.db.prepare("DELETE FROM region_handoffs WHERE id IN (SELECT id FROM region_handoffs WHERE status<>'prepared' AND expires_at<? ORDER BY expires_at LIMIT 128)").run(now - 86_400_000);
  }
}
