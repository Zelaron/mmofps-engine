import type { CampaignBase, CampaignOrder, Faction, FrontierState, SpawnOption, Territory } from '@shared/frontier';

export interface RespawnStatus {
  remaining: number;
  selected: SpawnOption | null;
  detail: string;
}

/** Count down between strategic snapshots; availability always comes from the server. */
export function respawnStatus(state: NonNullable<FrontierState['respawn']>, elapsedSeconds = 0): RespawnStatus {
  const remaining = Math.max(0, state.remaining - Math.max(0, elapsedSeconds));
  const { selected, detail } = reinforcementStatus(state, false);
  return { remaining, selected, detail };
}

/** A blocked preference is remembered but never advertised as a safe spawn. */
export function reinforcementStatus(state: { selected: string | null; options: SpawnOption[] }, alive: boolean): Omit<RespawnStatus, 'remaining'> {
  const preferred = state.options.find(option => option.id === state.selected), selected = preferred?.available !== false ? preferred ?? null : null;
  const available = state.options.some(option => option.available !== false);
  const detail = preferred?.available === false
    ? `${preferred.name} is unavailable: ${preferred.reason ?? 'The rally area is not safe.'} A safe fallback will be used. Your preference is remembered.`
    : selected ? alive ? `Next respawn: ${selected.name}. This choice does not move you now.`
      : `Deploying near ${selected.name}. Choose another point to change your next spawn.`
      : available ? alive ? 'Choose a reinforcement point for your next death. Automatic uses an available safe faction spawn.'
        : 'An available faction spawn will be chosen automatically. Select a point to use it for future respawns.'
        : alive ? 'No safe reinforcement point is available yet. Your next respawn will use a safe fallback.'
          : 'Finding a safe deployment position. You will respawn automatically.';
  return { selected, detail };
}

export function localCampaignBase(bases: readonly CampaignBase[], x: number, z: number, territories: readonly Territory[] = []): CampaignBase | undefined {
  const control = [...territories].sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z))[0];
  const controllingBase = control && Math.hypot(control.x - x, control.z - z) < 900
    ? bases.find(base => base.id === control.baseId || base.controlIds.includes(control.id)) : undefined;
  if (controllingBase) return controllingBase;
  return [...bases].sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z))[0];
}

/** Keep the local base visible even if it is not yet captured or is unsafe. */
export function orderedReinforcements(options: readonly SpawnOption[], bases: readonly CampaignBase[], x: number, z: number, territories: readonly Territory[] = []): SpawnOption[] {
  const local = localCampaignBase(bases, x, z, territories);
  return [...options].sort((a, b) => Number((b.baseId ?? b.id) === local?.id) - Number((a.baseId ?? a.id) === local?.id)
    || Number(b.available !== false) - Number(a.available !== false)
    || Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z) || a.id.localeCompare(b.id));
}

/** Where DEPLOY NOW goes: the soldier's own choice, else the staging of their
 * current order (the HUD's "G → DEPLOY NOW" hint means "go to the fight"),
 * else the first available point. Never an airborne launch by default. */
export function deployNowTarget(options: readonly SpawnOption[], selected: string | null | undefined,
  order: CampaignOrder | undefined, from?: { x: number; z: number }): string | undefined {
  const usable = options.filter(o => o.available !== false && o.kind !== 'air');
  if (selected && options.some(o => o.id === selected && o.available !== false)) return selected;
  if (!order) return usable[0]?.id;
  const staging = usable.find(o => o.controlId === order.targetId) ?? usable.find(o => (o.baseId ?? o.id) === order.baseId);
  if (staging) return staging.id;
  // No point at the order itself (its staging is unsafe for now): the usable
  // point nearest to it, as an automatic respawn would choose, and only when
  // that actually brings the soldier closer to the fight.
  const toOrder = (p: { x: number; z: number }) => Math.hypot(p.x - order.x, p.z - order.z);
  const nearest = [...usable].sort((a, b) => toOrder(a) - toOrder(b))[0];
  if (!nearest || (from && toOrder(nearest) > toOrder(from) - DEPLOY_MIN_GAIN_M)) return undefined;
  return nearest.id;
}
/** A fallback deployment must bring the soldier at least this much closer. */
export const DEPLOY_MIN_GAIN_M = 250;

export function baseControlStatus(base: CampaignBase, territories: readonly Territory[], faction: Faction, reinforcement?: SpawnOption): {
  held: number; total: number; required: number; kind: 'secured' | 'threatened' | 'partial' | 'enemy'; detail: string;
} {
  const controls = territories.filter(site => base.controlIds.includes(site.id));
  const held = faction ? controls.filter(site => site.owner === faction).length : 0;
  const required = base.requiredPoints;
  const kind = base.owner === faction && faction ? reinforcement?.available === false ? 'threatened' : 'secured' : held ? 'partial' : 'enemy';
  const rule = `${required} of ${controls.length} controls unlock reinforcements`;
  const detail = kind === 'threatened' ? `${held}/${controls.length} controls · Base secured, rally unavailable. ${reinforcement?.reason ?? 'Clear the rally area before reinforcements return.'}`
    : kind === 'secured' ? `${held}/${controls.length} controls · Base secured · Reinforcements available. G: choose your next respawn.`
      : held >= required ? `${held}/${controls.length} controls · Securing base ownership. ${rule}.`
        : `${held}/${controls.length} controls · Capture ${Math.max(0, required - held)} more. ${rule}.`;
  return { held, total: controls.length, required, kind, detail };
}
