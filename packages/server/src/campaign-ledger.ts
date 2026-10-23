import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { CAMPAIGN_MAX_TRANSFER_SQUAD, CAMPAIGN_REPORT_TTL_MS, type CampaignExchange, type CampaignReport,
  type CampaignTransfer, type CampaignWarAlert, type CampaignPopulation } from '@shared/campaign-war';
import { isFaction, type Faction } from '@shared/frontier';
import { planetById, type PlanetId } from '@shared/universe';
import { isEntityId } from '@shared/entity-id';
import { checkedHandoff, type RuntimeHandoff } from './runtime-handoff.js';
import { OwnershipError, type NodeRecord } from './coordinator.js';
import type { AuthorityToken } from './region-transfers.js';

export interface CampaignExchangeRequest {
  authority: AuthorityToken; report: CampaignReport; alerts?: CampaignWarAlert[]; acknowledged?: string[]; retired?: number[];
}
export interface CampaignDeparture {
  authority: AuthorityToken; id: string; destination: PlanetId; targetBaseId: string; faction: Faction; payload: RuntimeHandoff;
}
export interface CampaignCancellation { id: string; state: 'cancelled' | 'committed' }
interface Access {
  now(): number; node(id: string): NodeRecord | null; route(planet: PlanetId, region?: string): NodeRecord | null;
  entityOrigin(id: number, node: NodeRecord): boolean;
}
interface TransferRow {
  id: string; fingerprint: string; source: PlanetId; source_id: string; source_epoch: number;
  destination: PlanetId; destination_region: string; target_base_id: string; faction: Faction;
  payload: string; created_at: number; compacted: number;
}
interface BotOwner { id: number; planet: PlanetId; region: string; transfer_id: string; acknowledged_id: string | null; acknowledged_epoch: number | null; retired: number }
interface ReportRow { node_id: string; epoch: number; planet: PlanetId; region: string; received_at: number; report: string }
const fingerprint = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,120}$/.test(value);
function invalid(message: string): never { throw new OwnershipError('invalid', message); }

/** Coordinator transactions give expeditions one durable owner. A worker
 * freezes/removes a squad before submit, then inspects an ambiguous outcome.
 * Replayed arrivals are filtered by each bot's latest transfer, so moving on
 * to a third planet cannot resurrect an old copy after a worker restarts. */
export class CampaignLedger {
  constructor(private readonly db: DatabaseSync, private readonly access: Access) {
    db.exec(`CREATE TABLE IF NOT EXISTS campaign_reports (
      planet TEXT NOT NULL, region TEXT NOT NULL, node_id TEXT NOT NULL, epoch INTEGER NOT NULL,
      received_at INTEGER NOT NULL, report TEXT NOT NULL, PRIMARY KEY(planet,region)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS campaign_alerts (
      id TEXT PRIMARY KEY, planet TEXT NOT NULL, fingerprint TEXT NOT NULL, received_at INTEGER NOT NULL, alert TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS campaign_alert_age ON campaign_alerts(received_at);
    CREATE TABLE IF NOT EXISTS campaign_transfers (
      id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, source TEXT NOT NULL, source_id TEXT NOT NULL, source_epoch INTEGER NOT NULL,
      destination TEXT NOT NULL, destination_region TEXT NOT NULL, target_base_id TEXT NOT NULL,
      faction INTEGER NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, compacted INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE INDEX IF NOT EXISTS campaign_transfer_destination ON campaign_transfers(destination,destination_region);
    CREATE TABLE IF NOT EXISTS campaign_cancellations (
      id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, source_id TEXT NOT NULL, source_epoch INTEGER NOT NULL, created_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS campaign_bot_owners (
      id INTEGER PRIMARY KEY, planet TEXT NOT NULL, region TEXT NOT NULL, transfer_id TEXT NOT NULL,
      acknowledged_id TEXT, acknowledged_epoch INTEGER, retired INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE INDEX IF NOT EXISTS campaign_bot_transfer ON campaign_bot_owners(transfer_id);
    CREATE INDEX IF NOT EXISTS campaign_bot_destination ON campaign_bot_owners(planet,region);`);
    const transferColumns = db.prepare('PRAGMA table_info(campaign_transfers)').all() as { name: string }[];
    if (!transferColumns.some(c => c.name === 'compacted')) db.exec('ALTER TABLE campaign_transfers ADD COLUMN compacted INTEGER NOT NULL DEFAULT 0');
    const ownerColumns = db.prepare('PRAGMA table_info(campaign_bot_owners)').all() as { name: string }[];
    if (!ownerColumns.some(c => c.name === 'retired')) db.exec('ALTER TABLE campaign_bot_owners ADD COLUMN retired INTEGER NOT NULL DEFAULT 0');
    db.exec('CREATE INDEX IF NOT EXISTS campaign_transfer_compaction ON campaign_transfers(compacted,created_at)');
  }

  exchange(request: CampaignExchangeRequest): CampaignExchange<RuntimeHandoff> {
    const node = this.authority(request?.authority);
    const report = this.validateReport(request.report, node);
    if (!Array.isArray(request.alerts ?? []) || (request.alerts?.length ?? 0) > 16 ||
      !Array.isArray(request.acknowledged ?? []) || (request.acknowledged?.length ?? 0) > 32 ||
      !Array.isArray(request.retired ?? []) || (request.retired?.length ?? 0) > 256) invalid('Campaign exchange is too large');
    const now = this.access.now();
    const previous = this.db.prepare('SELECT * FROM campaign_reports WHERE planet=? AND region=?').get(node.planet, node.region) as unknown as ReportRow | undefined;
    if (!previous || previous.node_id !== node.id || previous.epoch !== node.epoch || JSON.parse(previous.report).tick <= report.tick) {
      this.db.prepare(`INSERT INTO campaign_reports VALUES(?,?,?,?,?,?) ON CONFLICT(planet,region)
        DO UPDATE SET node_id=excluded.node_id,epoch=excluded.epoch,received_at=excluded.received_at,report=excluded.report`)
        .run(node.planet, node.region, node.id, node.epoch, now, JSON.stringify(report));
    }
    for (const alert of request.alerts ?? []) this.publishAlert(alert, node, now);
    for (const id of request.acknowledged ?? []) {
      if (!validId(id)) invalid('Invalid campaign arrival acknowledgement');
      const transfer = this.row(id);
      if (!transfer || transfer.destination !== node.planet || transfer.destination_region !== node.region)
        invalid('Campaign arrival acknowledgement belongs to another destination');
      this.db.prepare('UPDATE campaign_bot_owners SET acknowledged_id=?,acknowledged_epoch=? WHERE transfer_id=? AND planet=? AND region=?')
        .run(node.id, node.epoch, id, node.planet, node.region);
    }
    for (const id of request.retired ?? []) {
      if (!isEntityId(id)) invalid('Invalid retired campaign soldier');
      const owner = this.owner(id);
      if (!owner || owner.retired) continue;
      if (owner.planet !== node.planet || owner.region !== node.region || owner.acknowledged_id !== node.id || owner.acknowledged_epoch !== node.epoch)
        throw new OwnershipError('fenced', 'Retired campaign soldier belongs to another authority');
      // Death is not retirement: only a permanent roster eviction sends this
      // tombstone. Its identity can never be replayed from an old expedition.
      this.db.prepare('UPDATE campaign_bot_owners SET retired=1 WHERE id=?').run(id);
    }
    this.db.prepare('DELETE FROM campaign_alerts WHERE received_at<?').run(now - 120_000);
    this.compact(now);
    const alerts = this.db.prepare('SELECT alert,received_at FROM campaign_alerts WHERE planet<>? ORDER BY received_at DESC LIMIT 24')
      .all(node.planet) as { alert: string; received_at: number }[];
    return { reports: this.reports(), alerts: alerts.map(row => ({ ...JSON.parse(row.alert), receivedAt: row.received_at })),
      arrivals: this.arrivals(node) };
  }

  depart(request: CampaignDeparture): CampaignTransfer<RuntimeHandoff> {
    const { payload, digest } = this.departure(request);
    const cancelled = this.cancellation(request.id);
    if (cancelled) {
      if (cancelled.fingerprint !== digest) invalid('Campaign departure retry does not match');
      throw new OwnershipError('invalid', 'Campaign departure was durably cancelled');
    }
    const previous = this.row(request.id);
    if (previous) {
      if (previous.fingerprint !== digest) invalid('Campaign departure retry does not match');
      // An immutable committed response remains inspectable after a source
      // lease expires; returning it does not authorize a second mutation.
      return this.ticket(previous);
    }
    const source = this.authority(request.authority);
    if (source.planet === request.destination || payload.seed !== planetById(source.planet)!.seed)
      invalid('Campaign departure requires a different planet and the source world state');
    const reports = this.reports().filter(r => r.planet === request.destination);
    const target = reports.find(r => r.bases.some(b => b.id === request.targetBaseId));
    const destination = this.access.route(request.destination, target?.region);
    if (!destination) throw new OwnershipError('unavailable', 'Campaign destination is unavailable');
    if (!target) throw new OwnershipError('unavailable', 'Campaign destination has no fresh strategic report');
    const pending = (this.db.prepare(`SELECT count(*) n FROM campaign_bot_owners WHERE planet=? AND region=? AND retired=0
      AND (acknowledged_id IS NULL OR acknowledged_id<>? OR acknowledged_epoch<>?)`)
      .get(destination.planet, destination.region, destination.id, destination.epoch) as { n: number }).n;
    if (pending + payload.players.length > 24) throw new OwnershipError('full', 'Campaign destination has enough reinforcements in transit');
    for (const player of payload.players) {
      const owner = this.owner(player.id);
      if (owner ? owner.retired || owner.planet !== source.planet || owner.region !== source.region || owner.acknowledged_id !== source.id || owner.acknowledged_epoch !== source.epoch
        : !this.access.entityOrigin(player.id, source)) throw new OwnershipError('fenced', 'Campaign soldier belongs to another world authority');
    }
    this.db.prepare(`INSERT INTO campaign_transfers(id,fingerprint,source,source_id,source_epoch,destination,destination_region,target_base_id,faction,payload,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(request.id, digest, source.planet, source.id, source.epoch, destination.planet, destination.region,
        request.targetBaseId, request.faction, JSON.stringify(payload), this.access.now());
    const put = this.db.prepare(`INSERT INTO campaign_bot_owners(id,planet,region,transfer_id,acknowledged_id,acknowledged_epoch,retired)
      VALUES(?,?,?,?,NULL,NULL,0) ON CONFLICT(id)
      DO UPDATE SET planet=excluded.planet,region=excluded.region,transfer_id=excluded.transfer_id,acknowledged_id=NULL,acknowledged_epoch=NULL,retired=0`);
    for (const player of payload.players) put.run(player.id, destination.planet, destination.region, request.id);
    return this.ticket(this.row(request.id)!);
  }

  /** A missing inspection result cannot prove a delayed departure will not
   * arrive later. This transaction resolves that race: either commit already
   * won, or an immutable tombstone prevents every later submit of this ID. */
  cancel(request: CampaignDeparture): CampaignCancellation {
    const { payload, digest } = this.departure(request), previous = this.row(request.id);
    if (previous) {
      if (previous.fingerprint !== digest) invalid('Campaign cancellation does not match its departure');
      return { id: request.id, state: 'committed' };
    }
    const cancelled = this.cancellation(request.id);
    if (cancelled) {
      if (cancelled.fingerprint !== digest) invalid('Campaign cancellation retry does not match');
      return { id: request.id, state: 'cancelled' };
    }
    const source = this.authority(request.authority);
    if (source.planet === request.destination || payload.seed !== planetById(source.planet)!.seed)
      invalid('Campaign cancellation requires the original source world');
    for (const player of payload.players) {
      const owner = this.owner(player.id);
      if (owner ? owner.retired || owner.planet !== source.planet || owner.region !== source.region || owner.acknowledged_id !== source.id || owner.acknowledged_epoch !== source.epoch
        : !this.access.entityOrigin(player.id, source)) throw new OwnershipError('fenced', 'Campaign soldier belongs to another world authority');
    }
    this.db.prepare('INSERT INTO campaign_cancellations VALUES(?,?,?,?,?)')
      .run(request.id, digest, source.id, source.epoch, this.access.now());
    return { id: request.id, state: 'cancelled' };
  }

  inspect(id: string, authority: AuthorityToken): CampaignTransfer<RuntimeHandoff> | null {
    if (!validId(id)) invalid('Invalid campaign transfer ID');
    const row = this.row(id);
    if (!row) { this.authority(authority); return null; }
    if (row.source_id !== authority?.id || row.source_epoch !== authority?.epoch) {
      const node = this.authority(authority);
      if (node.planet !== row.destination || node.region !== row.destination_region)
        throw new OwnershipError('fenced', 'Campaign transfer is owned by different authorities');
    }
    return this.ticket(row);
  }

  reports(): CampaignReport[] {
    const rows = this.db.prepare('SELECT * FROM campaign_reports WHERE received_at>?')
      .all(this.access.now() - CAMPAIGN_REPORT_TTL_MS) as unknown as ReportRow[];
    return rows.filter(row => {
      const node = this.access.node(row.node_id);
      return node?.epoch === row.epoch && node.planet === row.planet && node.region === row.region;
    }).map(row => ({ ...JSON.parse(row.report), region: row.region, receivedAt: row.received_at }));
  }

  summary(planet: PlanetId): { botPopulation: CampaignPopulation; threatenedBases: number; inboundSquads: number } | undefined {
    const reports = this.reports().filter(r => r.planet === planet);
    if (!reports.length) return undefined;
    const botPopulation: CampaignPopulation = [0, 0, 0, 0];
    for (const report of reports) for (let faction = 0; faction < 4; faction++) botPopulation[faction] += report.botPopulation[faction];
    const threatenedBases = new Set(reports.flatMap(r => r.bases.filter(b => b.attackers.length).map(b => b.id))).size;
    const inbound = new Set<string>();
    for (const report of reports) {
      const node = this.access.route(planet, report.region); if (!node) continue;
      for (const row of this.pendingRows(node)) inbound.add(row.id);
    }
    return { botPopulation, threatenedBases, inboundSquads: inbound.size };
  }

  private pendingRows(node: NodeRecord): TransferRow[] {
    return this.db.prepare(`SELECT DISTINCT t.* FROM campaign_transfers t JOIN campaign_bot_owners b ON b.transfer_id=t.id
      WHERE b.planet=? AND b.region=? AND b.retired=0 AND (b.acknowledged_id IS NULL OR b.acknowledged_id<>? OR b.acknowledged_epoch<>?)
      ORDER BY t.created_at LIMIT 8`).all(node.planet, node.region, node.id, node.epoch) as unknown as TransferRow[];
  }

  private arrivals(node: NodeRecord): CampaignTransfer<RuntimeHandoff>[] {
    return this.pendingRows(node).map(row => {
      const ticket = this.ticket(row);
      ticket.payload.players = ticket.payload.players.filter(p => {
        const owner = this.owner(p.id);
        return owner?.transfer_id === row.id && !owner.retired && owner.planet === node.planet && owner.region === node.region;
      });
      ticket.payload.history = [];
      return ticket;
    }).filter(ticket => ticket.payload.players.length > 0);
  }

  private validateReport(value: CampaignReport, node: NodeRecord): CampaignReport {
    const counts = (array: number[], fractions = false): boolean => Array.isArray(array) && array.length === 4 &&
      array.every(n => Number.isFinite(n) && n >= 0 && (fractions ? n <= 1 : Number.isSafeInteger(n) && n <= 100000));
    if (!value || value.planet !== node.planet || !Number.isSafeInteger(value.tick) || value.tick < 0 ||
      !counts(value.ownership, true) || Math.abs(value.ownership.reduce((a, b) => a + b, 0) - 1) > .000001 ||
      !counts(value.botPopulation) || !Array.isArray(value.bases) || value.bases.length > 128) invalid('Invalid campaign report');
    const ids = new Set<string>();
    for (const base of value.bases) {
      if (!base || !validId(base.id) || ids.has(base.id) || typeof base.name !== 'string' || base.name.length > 120 ||
        !isFaction(base.owner) || !Number.isFinite(base.x) || !Number.isFinite(base.z) ||
        !counts(base.held) || !Array.isArray(base.attackers) || base.attackers.length > 3 ||
        base.attackers.some(f => !isFaction(f) || !f)) invalid('Invalid campaign base report');
      ids.add(base.id);
    }
    return JSON.parse(JSON.stringify({ planet: value.planet, tick: value.tick, ownership: value.ownership,
      botPopulation: value.botPopulation, bases: value.bases, region: node.region }));
  }

  private publishAlert(alert: CampaignWarAlert, node: NodeRecord, now: number): void {
    if (!alert || !validId(alert.id) || alert.id.length < 16 || alert.planet !== node.planet || !validId(alert.baseId) ||
      typeof alert.baseName !== 'string' || alert.baseName.length > 120 || typeof alert.message !== 'string' || alert.message.length > 400 ||
      !isFaction(alert.attacker) || !alert.attacker || !isFaction(alert.defender)) invalid('Invalid campaign alert');
    const clean = { id: alert.id, planet: alert.planet, baseId: alert.baseId, baseName: alert.baseName,
      attacker: alert.attacker, defender: alert.defender, message: alert.message };
    const digest = fingerprint(clean), old = this.db.prepare('SELECT fingerprint FROM campaign_alerts WHERE id=?').get(alert.id) as { fingerprint: string } | undefined;
    if (old) { if (old.fingerprint !== digest) invalid('Campaign alert retry does not match'); return; }
    this.db.prepare('INSERT INTO campaign_alerts VALUES(?,?,?,?,?)').run(alert.id, node.planet, digest, now, JSON.stringify(clean));
    this.db.exec('DELETE FROM campaign_alerts WHERE id NOT IN (SELECT id FROM campaign_alerts ORDER BY received_at DESC LIMIT 256)');
  }

  private authority(token: AuthorityToken): NodeRecord {
    const node = token && validId(token.id) ? this.access.node(token.id) : null;
    if (!node || node.epoch !== token.epoch) throw new OwnershipError('fenced', 'Campaign operation requires current world authority');
    return node;
  }
  private departure(request: CampaignDeparture): { payload: RuntimeHandoff; digest: string } {
    if (!request || !validId(request.id) || request.id.length < 16 || !validId(request.targetBaseId) ||
      !planetById(request.destination) || !isFaction(request.faction) || !request.faction) invalid('Invalid campaign departure');
    let payload: RuntimeHandoff;
    try { payload = checkedHandoff(request.payload); } catch { return invalid('Invalid campaign squad state'); }
    if (payload.players.length > CAMPAIGN_MAX_TRANSFER_SQUAD || payload.vehicles.length || payload.projectiles.length ||
      payload.players.some(p => !p.isBot || p.faction !== request.faction || !p.state.alive || p.vehicleId >= 0 || p.state.vehicle || p.state.airlift))
      invalid('Campaign departures require up to six living foot soldiers of one faction');
    return { payload, digest: fingerprint({ authority: request.authority, destination: request.destination,
      targetBaseId: request.targetBaseId, faction: request.faction, payload }) };
  }
  private cancellation(id: string): { fingerprint: string } | undefined {
    return this.db.prepare('SELECT fingerprint FROM campaign_cancellations WHERE id=?').get(id) as { fingerprint: string } | undefined;
  }
  private compact(now: number): void {
    // Keep small immutable receipts for arbitrarily late lost-response
    // retries, but reclaim large handoffs once nobody can arrive from them.
    const rows = this.db.prepare(`SELECT id FROM campaign_transfers t WHERE compacted=0 AND created_at<?
      AND NOT EXISTS(SELECT 1 FROM campaign_bot_owners b WHERE b.transfer_id=t.id AND b.retired=0) LIMIT 32`)
      .all(now - 86400_000) as { id: string }[];
    for (const row of rows) this.db.prepare("UPDATE campaign_transfers SET payload='',compacted=1 WHERE id=?").run(row.id);
  }
  private row(id: string): TransferRow | undefined { return this.db.prepare('SELECT * FROM campaign_transfers WHERE id=?').get(id) as unknown as TransferRow | undefined; }
  private owner(id: number): BotOwner | undefined { return this.db.prepare('SELECT * FROM campaign_bot_owners WHERE id=?').get(id) as unknown as BotOwner | undefined; }
  private ticket(row: TransferRow): CampaignTransfer<RuntimeHandoff> {
    return { id: row.id, source: row.source, destination: row.destination, targetBaseId: row.target_base_id,
      faction: row.faction, state: 'committed', payload: row.compacted
        ? { version: 1, seed: planetById(row.source)!.seed, tick: 0, players: [], vehicles: [], projectiles: [], history: [] }
        : JSON.parse(row.payload) };
  }
}
