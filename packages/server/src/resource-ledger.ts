import type { DatabaseSync } from 'node:sqlite';
import { RESOURCE_RENEW_SECONDS, RESOURCE_YIELD, resourceCandidate } from '@shared/resources';
import { TICK_RATE } from '@shared/constants';
import { planetById, type PlanetId } from '@shared/universe';
import type { SavedPlayer } from './persistence.js';

export interface ResourceReceipt { id: string; readyAt: number; earned: number; spent: number }
/** Called inside the coordinator transaction, alongside the character save. */
export class ResourceLedger {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS resource_depletion (
      planet TEXT NOT NULL, site TEXT NOT NULL, ready_at INTEGER NOT NULL, PRIMARY KEY(planet,site)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS resource_receipts (
      request TEXT PRIMARY KEY, key TEXT NOT NULL, planet TEXT NOT NULL, site TEXT NOT NULL,
      previous INTEGER NOT NULL, ready_at INTEGER NOT NULL, earned INTEGER NOT NULL, created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS resource_receipt_age ON resource_receipts(created_at);`);
  }
  view(planet: PlanetId, ids: string[]): { id: string; readyAt: number }[] {
    if (!Array.isArray(ids) || ids.length > 1024 || new Set(ids).size !== ids.length) throw new Error('Invalid resource view');
    const query = this.db.prepare('SELECT ready_at FROM resource_depletion WHERE planet=? AND site=?');
    return ids.map(id => {
      resourceCandidate(planetById(planet)!.seed, id);
      return { id, readyAt: (query.get(planet, id) as { ready_at: number } | undefined)?.ready_at ?? 0 };
    });
  }
  harvest(key: string, planet: PlanetId, request: string, id: string, expected: number, state: SavedPlayer, tick: number, now: number): { state: SavedPlayer; receipt: ResourceReceipt } {
    if (!/^[a-f0-9-]{16,80}$/.test(request) || !Number.isSafeInteger(expected) || expected < 0) throw new Error('Invalid extraction request');
    const old = this.db.prepare('SELECT * FROM resource_receipts WHERE request=?').get(request) as
      { key: string; planet: string; site: string; previous: number; ready_at: number; earned: number } | undefined;
    if (old) {
      if (old.key !== key || old.planet !== planet || old.site !== id || old.previous !== expected) throw new Error('Extraction retry does not match');
      return { state, receipt: { id, readyAt: old.ready_at, earned: state.salvageEarned ?? 0, spent: state.salvageSpent ?? 0 } };
    }
    const ready = this.view(planet, [id])[0].readyAt;
    if (ready !== expected || ready > tick) throw new Error('This seam is regrowing. Try another deposit.');
    if (state.salvage + RESOURCE_YIELD > 1_000_000) throw new Error('Salvage storage is full. Build a field camp.');
    const earned = (state.salvageEarned ?? 0) + RESOURCE_YIELD, readyAt = Math.ceil(tick) + RESOURCE_RENEW_SECONDS * TICK_RATE;
    if (!Number.isSafeInteger(earned) || !Number.isSafeInteger(readyAt)) throw new Error('Extraction ledger capacity reached');
    this.db.prepare('INSERT INTO salvage_earnings(key,total) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET total=excluded.total').run(key, earned);
    this.db.prepare('INSERT INTO resource_depletion(planet,site,ready_at) VALUES(?,?,?) ON CONFLICT(planet,site) DO UPDATE SET ready_at=excluded.ready_at').run(planet, id, readyAt);
    this.db.prepare('INSERT INTO resource_receipts(request,key,planet,site,previous,ready_at,earned,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(request, key, planet, id, expected, readyAt, earned, now);
    // Even after a receipt expires, its old ready_at compare-and-swap cannot
    // harvest a later growth cycle. The cumulative credit watermark survives.
    this.db.prepare('DELETE FROM resource_receipts WHERE created_at<?').run(now - 86400_000);
    return { state: { ...state, salvage: state.salvage + RESOURCE_YIELD, salvageEarned: earned },
      receipt: { id, readyAt, earned, spent: state.salvageSpent ?? 0 } };
  }
}
