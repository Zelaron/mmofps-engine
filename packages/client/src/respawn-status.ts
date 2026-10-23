import type { CampaignBase, Faction, FrontierState, SpawnOption, Territory } from '@shared/frontier';

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
