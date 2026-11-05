import { CAPTURE_HEIGHT, FACTIONS, captureHeightGap, type Faction, type Territory } from '@shared/frontier';

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
  // The server's height rule for a human (inCaptureRange): name the gap.
  const gap = captureHeightGap(site, p.y, true);
  if (gap && site.ground) return result('blocked', gap > 0 ? 'TOO HIGH TO CAPTURE' : 'TOO LOW TO CAPTURE',
    `You are ${Math.max(1, Math.round(Math.abs(gap)))} m ${gap > 0 ? 'above' : 'below'} the ground in this ring. Stand on the ground inside it: roofs and caves do not count.`);
  const rise = p.y - site.y;
  if (gap) return result('blocked', 'RETURN TO THE FLAG LEVEL',
    `You are ${Math.round(Math.abs(rise))} m ${rise > 0 ? 'above' : 'below'} the flag. Get within ${CAPTURE_HEIGHT} m of its height: move toward it. Roofs and caves do not count.`);
  if (site.contested) {
    // The faction with a clear majority in the ring keeps making progress.
    const pushing = Math.abs(site.progressRate ?? 0) > 1e-6 && site.pressureFaction ? site.pressureFaction : 0;
    if (pushing === faction) {
      const remaining = influence < 0 ? -influence : 1 - influence, rate = Math.abs(site.progressRate ?? 0);
      return result('capturing', 'CONTESTED — YOU OUTNUMBER THEM', `Keep your majority in the ring.${rate > 1e-6 ? ` About ${Math.ceil(remaining / rate)}s remaining.` : ''}`);
    }
    if (pushing) return result('blocked', 'CONTESTED — OUTNUMBERED', 'The enemy has more soldiers in the ring. Kill them or bring allies.');
    if (site.owner === faction && influence >= 1 - 1e-6) return result('contested', 'CONTESTED — HOLDING', 'Attackers are in the ring but cannot out-number you. Drive them out.', 100);
    return result('contested', 'CONTESTED — STALEMATE', 'Neither side has a clear majority. Clear enemy troops or out-number them to resume capture.');
  }
  if (site.owner === faction && influence >= 1 - 1e-6) return result('secured', 'CONTROL POINT SECURED', `This point is held by ${FACTIONS[faction].name}. Check the base reinforcement status below.`, 100);
  const rate = modern ? (site.pressureFaction === faction ? 1 : -1) * Math.abs(site.progressRate ?? 0) : (site.captureRate ?? 0) * sign;
  if (rate < -1e-6) return result('blocked', 'ENEMY CAPTURING', 'Stop enemy troops in the ring.');
  const remaining = influence < 0 ? -influence : 1 - influence;
  const time = rate > 1e-6 ? ` About ${Math.ceil(remaining / rate)}s remaining.` : '';
  return result('capturing', site.owner === faction ? 'RESTORING CONTROL' : stage,
    `${influence < 0 ? 'Remove enemy control, then claim the zone.' : 'Stay inside the ring to secure the zone.'}${time}`);
}
