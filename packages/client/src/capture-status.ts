import { CAPTURE_HEIGHT, FACTIONS, type Faction, type Territory } from '@shared/frontier';

export interface CaptureObserver { x: number; y: number; z: number; alive: boolean; onFoot: boolean }
export interface CaptureStatus {
  phase: string; detail: string; progress: number; active: boolean;
  kind: 'approach' | 'blocked' | 'contested' | 'capturing' | 'secured';
}

/** Display authoritative influence and timing, using the player's feet position. */
export function captureStatus(site: Territory, faction: Faction, p: CaptureObserver): CaptureStatus {
  const distance = Math.hypot(site.x - p.x, site.z - p.z);
  const sign = faction === 1 ? -1 : 1;
  const modern = site.captureFaction !== undefined && site.captureProgress !== undefined;
  const strength = Math.max(0, Math.min(1, site.captureProgress ?? 0));
  const influence = modern ? (site.captureFaction === faction ? strength : -strength) : site.influence * sign;
  const stage = influence < 0 ? 'NEUTRALIZING' : 'CAPTURING';
  const progress = Math.max(0, Math.min(100, (influence < 0 ? 1 + influence : influence) * 100));
  const active = distance <= site.radius;
  const result = (kind: CaptureStatus['kind'], phase: string, detail: string, value = progress): CaptureStatus => ({ kind, phase, detail, progress: value, active });
  if (!active) {
    const bearing = Math.round(Math.atan2(site.x - p.x, p.z - site.z) / (Math.PI / 4));
    const direction = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][(bearing + 8) % 8];
    return result('approach', 'ENTER THE CAPTURE ZONE', `${Math.ceil(distance - site.radius)} m ${direction} to the ring. Stay inside on foot.`);
  }
  if (!p.alive) return result('blocked', 'CAPTURE PAUSED', 'Respawn to help capture this zone.');
  if (!faction) return result('blocked', 'AWAITING FACTION', 'A faction is assigned when you join the world.', 0);
  if (!p.onFoot) return result('blocked', 'DISEMBARK TO CAPTURE', 'Leave your vehicle or pod, then hold the ring on foot.');
  if (Math.abs(p.y - site.y) > CAPTURE_HEIGHT) return result('blocked', 'RETURN TO THE FLAG LEVEL', 'Reach the ground beside the flag. Roofs and caves do not count.');
  if (site.contested) return result('contested', 'CONTESTED — CAPTURE PAUSED', 'Clear enemy troops from the ring to resume capture.');
  if (site.owner === faction && influence >= 1 - 1e-6) return result('secured', 'CONTROL POINT SECURED', `This point is held by ${FACTIONS[faction].name}. Check the base reinforcement status below.`, 100);
  const rate = modern ? (site.pressureFaction === faction ? 1 : -1) * Math.abs(site.progressRate ?? 0) : (site.captureRate ?? 0) * sign;
  if (rate < -1e-6) return result('blocked', 'ENEMY CAPTURING', 'Stop enemy troops in the ring.');
  const remaining = influence < 0 ? -influence : 1 - influence;
  const time = rate > 1e-6 ? ` About ${Math.ceil(remaining / rate)}s remaining.` : '';
  return result('capturing', site.owner === faction ? 'RESTORING CONTROL' : stage,
    `${influence < 0 ? 'Remove enemy control, then claim the zone.' : 'Stay inside the ring to secure the zone.'}${time}`);
}
