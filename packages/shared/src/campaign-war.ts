import type { Faction } from './frontier.js';
import type { PlanetId } from './universe.js';

export type CampaignPopulation = [number, number, number, number];
export interface CampaignBaseReport {
  id: string; name: string; owner: Faction; x: number; z: number;
  held: CampaignPopulation; attackers: Faction[];
}
/** Reports contain strategic aggregates, never individual remote positions. */
export interface CampaignReport {
  planet: PlanetId; tick: number; ownership: CampaignPopulation; botPopulation: CampaignPopulation;
  bases: CampaignBaseReport[]; region?: string; receivedAt?: number;
}
export interface CampaignWarAlert {
  id: string; planet: PlanetId; baseId: string; baseName: string;
  attacker: Faction; defender: Faction; message: string; receivedAt?: number;
}
export interface CampaignTransfer<Payload = unknown> {
  id: string; source: PlanetId; destination: PlanetId; targetBaseId: string;
  faction: Faction; state: 'committed'; payload: Payload;
}
export interface CampaignExchange<Payload = unknown> {
  reports: CampaignReport[]; alerts: CampaignWarAlert[]; arrivals: CampaignTransfer<Payload>[];
}
export const CAMPAIGN_REPORT_TTL_MS = 20_000;
export const CAMPAIGN_MAX_TRANSFER_SQUAD = 6;
