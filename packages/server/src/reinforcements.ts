import { TICK_RATE } from '@shared/constants';
import { BOT_CAPTURE_WEIGHT, inCaptureRange, type CampaignBase, type SpawnOption, type Territory } from '@shared/frontier';
import { capsuleClearance } from '@shared/physics';
import type { World } from '@shared/worldgen';
import type { ServerPlayer } from './game.js';

type Point = { x: number; y: number; z: number };
export const REINFORCEMENT_ZONE_GAP = 80;
export const REINFORCEMENT_ENEMY_DISTANCE = 180;
export const REINFORCEMENT_QUIET_SECONDS = 12;
/** Assault reinforcements arrive about this far from their target control:
 * close enough to rejoin the fight within ~40 seconds on foot. */
export const STAGING_DISTANCE = 300;
/** Capture weight in a ring that locks a base's own reinforcement approaches. */
export const ASSAULT_LOCK_WEIGHT = 1;

/** Ownership unlocks reinforcements; a quiet approach determines where they
 * can arrive. No safety fallback may put a defender back inside the fight. */
export class ReinforcementPlanner {
  private readonly approaches = new Map<string, Point[]>();
  private readonly pressureUntil = new Map<string, number>();
  private readonly contacts = new Map<string, { x: number; z: number; tick: number }>();
  constructor(private readonly world: World, private readonly controls: readonly Territory[]) {}

  observeControl(site: Territory, factions: readonly number[], tick: number): void {
    if (site.owner && factions.some(f => f !== site.owner))
      this.pressureUntil.set(`${site.owner}:${site.id}`, tick + REINFORCEMENT_QUIET_SECONDS * TICK_RATE);
  }

  recordCombat(x: number, z: number, tick: number): void {
    const id = `${Math.floor(x / 64)},${Math.floor(z / 64)}`;
    this.contacts.delete(id); this.contacts.set(id, { x, z, tick });
    if (this.contacts.size > 128) this.contacts.delete(this.contacts.keys().next().value!);
  }

  outsideControls(point: Point): boolean {
    return this.controls.every(site => Math.hypot(site.x - point.x, site.z - point.z) >= site.radius + REINFORCEMENT_ZONE_GAP);
  }

  supported(point: Point): boolean {
    if (this.world.liquidAt(point.x, point.y, point.z) || capsuleClearance(this.world, point.x, point.y, point.z) < -.02) return false;
    // A center ray alone accepts bridge lips: the standing capsule then
    // slides off on its first movement step. Keep a supported footprint.
    for (let k = 0; k < 8; k++) if (this.world.sdf(point.x + Math.cos(k * Math.PI / 4) * .8,
      point.y - .2, point.z + Math.sin(k * Math.PI / 4) * .8) > 0) return false;
    return this.world.sdf(point.x, point.y - .2, point.z) <= 0;
  }

  safe(player: ServerPlayer, point: Point, actors: readonly ServerPlayer[], tick: number): boolean {
    if (!this.outsideControls(point)) return false;
    if (actors.some(p => p.id !== player.id && p.state.alive && !p.state.airlift && p.faction && p.faction !== player.faction &&
      Math.abs(p.state.py - point.y) < 60 && Math.hypot(p.state.px - point.x, p.state.pz - point.z) < REINFORCEMENT_ENEMY_DISTANCE)) return false;
    for (const [key, contact] of this.contacts) {
      if (tick - contact.tick >= REINFORCEMENT_QUIET_SECONDS * TICK_RATE) { this.contacts.delete(key); continue; }
      if (Math.hypot(contact.x - point.x, contact.z - point.z) < 140) return false;
    }
    return true;
  }

  /** Natural ground no steeper than about 15 degrees around a point. */
  private level(point: Point): boolean {
    for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2]])
      if (Math.abs(this.world.groundY(point.x + dx, point.z + dz) + .08 - point.y) > .55) return false;
    return true;
  }

  private ground(x: number, z: number, city?: { y: number; x: number; z: number; radius: number }): Point | null {
    const onStreet = city && Math.max(Math.abs(x - city.x), Math.abs(z - city.z)) < city.radius;
    const y = onStreet ? city.y + .08 : this.world.groundY(x, z) + .08;
    if (!onStreet && Math.abs(y - this.world.column(x, z).h) > 2) return null;
    const point = { x, y, z };
    if (!this.outsideControls(point) || !this.supported(point)) return null;
    return point;
  }

  private candidates(base: CampaignBase, site: Territory): Point[] {
    const key = `${site.id}:${site.x}:${site.y}:${site.z}:${base.x}:${base.z}`;
    const cached = this.approaches.get(key); if (cached) return cached;
    const city = base.kind === 'city' ? this.world.collectCities().find(c => base.id === `base-city-${c.id}`) : undefined;
    const points: Point[] = [];
    const add = (x: number, z: number) => {
      const point = this.ground(x, z, city);
      if (point && !points.some(p => Math.hypot(p.x - x, p.z - z) < 24)) points.push(point);
    };
    add(base.x, base.z);
    for (const radius of [site.radius + 110, site.radius + 180, site.radius + 250]) {
      for (let k = 0; k < 12; k++) add(site.x + Math.cos(k * Math.PI / 6) * radius, site.z + Math.sin(k * Math.PI / 6) * radius);
    }
    // Streets beside a capital control may connect through bent bridges;
    // command and local candidates share the same authored pedestrian level.
    points.sort((a, b) => Math.hypot(a.x - base.x, a.z - base.z) - Math.hypot(b.x - base.x, b.z - base.z));
    this.approaches.set(key, points);
    return points;
  }

  /** Set by the frontier: a besieged base whose rally is closed (supply cut). */
  supplyCut?: (base: CampaignBase) => boolean;

  baseOption(base: CampaignBase, player: ServerPlayer, actors: readonly ServerPlayer[], tick: number): SpawnOption {
    const controls = this.controls.filter(site => base.controlIds.includes(site.id));
    const held = controls.filter(site => site.owner === player.faction);
    const fallback: SpawnOption = { id: base.id, baseId: base.id, name: base.name, kind: 'base',
      x: base.x, y: base.y, z: base.z, available: false };
    if (base.owner !== player.faction) return { ...fallback,
      reason: `${held.length}/${controls.length} controls held. Capture ${Math.max(1, base.requiredPoints - held.length)} more; ${base.requiredPoints} of ${controls.length} unlock reinforcements.` };
    // A base whose control is actively being taken cannot pour defenders out
    // beside the fight; they deploy at a defense staging point instead, at the
    // same distance as the attackers, so the larger force decides the zone.
    // A lone infiltrator does not lock the base: it takes real capture
    // strength (a human, or four bots) actually taking the zone.
    const assaulted = held.some(site => {
      if (!site.pressureFaction || site.pressureFaction === player.faction || !(site.progressRate ?? 0)) return false;
      let weight = 0;
      for (const actor of actors) if (actor.faction === site.pressureFaction && actor.state.alive && !actor.state.vehicle &&
        inCaptureRange(site, actor.state.px, actor.state.py, actor.state.pz, !actor.isBot)) weight += actor.isBot ? BOT_CAPTURE_WEIGHT : 1;
      return weight >= ASSAULT_LOCK_WEIGHT;
    });
    if (assaulted) return { ...fallback, reason: 'Under assault: reinforcements deploy at the defense staging point.' };
    if (this.supplyCut?.(base)) return { ...fallback, reason: 'Supply cut: a control has been held by the enemy too long. Retake it to reopen this rally.' };
    for (const site of held) {
      const enemies = actors.some(p => p.state.alive && p.faction && p.faction !== player.faction && !p.state.airlift &&
        Math.abs(p.state.py - site.y) < 60 && Math.hypot(p.state.px - site.x, p.state.pz - site.z) < site.radius + 30);
      if (enemies || site.contested) this.pressureUntil.set(`${player.faction}:${site.id}`, tick + REINFORCEMENT_QUIET_SECONDS * TICK_RATE);
      if (enemies || site.contested || tick < (this.pressureUntil.get(`${player.faction}:${site.id}`) ?? -1)) continue;
      const point = this.candidates(base, site).find(p => this.safe(player, p, actors, tick));
      if (point) return { ...fallback, ...point, controlId: site.id, available: true,
        reason: `Safe approach to ${site.name}. Reinforcements arrive outside the capture zones.` };
    }
    return { ...fallback, reason: `Under attack. Reinforcements return after an approach is clear for ${REINFORCEMENT_QUIET_SECONDS} seconds; another safe base will be used meanwhile.` };
  }

  /** A supported assembly point a short run from an attacked control, on the
   * side facing the attackers' territory (unit direction ux,uz from the
   * control). It stays outside every capture ring. Null when the terrain
   * around the control offers no such ground (deep water, the abyss...). */
  stagingPoint(site: Territory, ux: number, uz: number): Point | null {
    return this.stagingPoints(site, ux, uz, 1)[0] ?? null;
  }

  /** Up to `count` well separated staging points (see stagingPoint), so a
   * single enemy patrol near one of them does not stall a whole assault. */
  stagingPoints(site: Territory, ux: number, uz: number, count = 3, around = STAGING_DISTANCE): Point[] {
    const city = this.world.collectCities().find(c => Math.max(Math.abs(site.x - c.x), Math.abs(site.z - c.z)) < c.radius);
    const base = Math.atan2(uz, ux), points: Point[] = [];
    for (const distance of [around, around - 50, around + 70, around + 150, around + 240]) {
      for (const turn of [0, .22, -.22, .45, -.45, .75, -.75, 1.1, -1.1]) {
        const x = site.x + Math.cos(base + turn) * distance, z = site.z + Math.sin(base + turn) * distance;
        const inCity = city && Math.max(Math.abs(x - city.x), Math.abs(z - city.z)) < city.radius ? city : undefined;
        const point = this.ground(x, z, inCity);
        if (!point || points.some(p => Math.hypot(p.x - point.x, p.z - point.z) < 150)) continue;
        // Reinforcements arrive on level ground, not a slope they slide down.
        if (!inCity && !this.level(point)) continue;
        points.push(point);
        if (points.length >= count) return points;
      }
    }
    return points;
  }

  reserveOption(reserve: SpawnOption, player: ServerPlayer, actors: readonly ServerPlayer[], tick: number): SpawnOption | undefined {
    const key = `reserve:${reserve.id}`;
    let points = this.approaches.get(key);
    if (!points) {
      points = [];
      for (const radius of [0, 192, 384, 640, 960]) for (let k = 0; k < (radius ? 12 : 1); k++) {
        const point = this.ground(reserve.x + Math.cos(k * Math.PI / 6) * radius, reserve.z + Math.sin(k * Math.PI / 6) * radius);
        if (point) points.push(point);
      }
      this.approaches.set(key, points);
    }
    const point = points.find(p => this.safe(player, p, actors, tick));
    return point ? { ...reserve, ...point, available: true, reason: 'Coastal reinforcements while local bases are unavailable.' } : undefined;
  }
}
