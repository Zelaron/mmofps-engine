import { CREATURE_DEFS, TICK_RATE, type CreatureState } from '@shared/index';

export function incomingBossAttack(creatures: readonly CreatureState[], point: { x: number; y: number; z: number },
  tick: number, hullRadius = 0): CreatureState | undefined {
  let nearest: CreatureState | undefined;
  for (const creature of creatures) {
    const attack = creature.rangedAttack;
    if (creature.dead || !attack || tick >= attack.impactTick || !CREATURE_DEFS[creature.species]?.boss ||
        Math.hypot(point.x - attack.x, point.y - attack.y, point.z - attack.z) > attack.radius + Math.max(0, hullRadius) + 2) continue;
    if (!nearest || attack.impactTick < nearest.rangedAttack!.impactTick) nearest = creature;
  }
  return nearest;
}

/** A distant caster's nameplate is too small to communicate immediate danger. */
export class BossWarning {
  private readonly panel = document.createElement('div');
  private readonly title = document.createElement('strong');
  private readonly detail = document.createElement('span');
  private sounded = '';
  constructor(private readonly sound: (species: number) => void) {
    this.panel.id = 'boss-warning'; this.panel.hidden = true; this.panel.setAttribute('role', 'alert');
    this.detail.setAttribute('aria-live', 'off');
    this.panel.append(this.title, this.detail); document.body.appendChild(this.panel);
  }
  update(creatures: readonly CreatureState[], point: { x: number; y: number; z: number }, tick: number, visible: boolean, hullRadius = 0): void {
    const threat = visible ? incomingBossAttack(creatures, point, tick, hullRadius) : undefined;
    this.panel.hidden = !threat;
    if (!threat) return;
    const attack = threat.rangedAttack!, eta = Math.max(0, (attack.impactTick - tick) / TICK_RATE);
    const title = `${CREATURE_DEFS[threat.species].name.toUpperCase()} · INCOMING`;
    const detail = `IMPACT IN ${eta.toFixed(1)}s — MOVE OUT OF THE MARKED AREA`;
    if (this.title.textContent !== title) this.title.textContent = title;
    if (this.detail.textContent !== detail) this.detail.textContent = detail;
    this.panel.classList.toggle('urgent', eta < 1.5);
    const key = `${threat.id}:${attack.fireTick}`;
    if (key !== this.sounded) { this.sounded = key; this.sound(threat.species); }
  }
}
