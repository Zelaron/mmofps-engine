import { allocateEntityId, LOCAL_ENTITY_RANGE, type EntityIdRange, type EntityAllocator } from '@shared/entity-id';
import { World, VEHICLE, mulberry32, hash2i, rayCapsule, CREATURE_DEFS, MAX_CREATURES,
  MAX_VISIBLE_CREATURES, type CreatureState } from '@shared/index';

export interface WildlifePlayer { id: number; x: number; y: number; z: number; alive: boolean; vehicle: number }
export interface Creature extends CreatureState {
  health: number; homeX: number; homeY: number; homeZ: number;
  attackAt: number; turnAt: number; deadUntil: number; thinkAt: number;
}
type Point = { x: number; y: number; z: number };
interface SpawnGroup { key: string; species: number; anchor: Point; remaining: number; member: number; cave: boolean }
export const WILDLIFE_AI_BUDGET = 18;
export const WILDLIFE_LOCAL_CAP = 12;
const CELL = 128;

/** Small groups appear along explored ground, including cave rooms between
 * landmarks. One terrain spawn candidate and at most18 AI steps per10Hz tick
 * keep fast travel and large multiplayer interest sets bounded. */
export class Wildlife {
  readonly creatures = new Map<number, Creature>();
  private nextId = 1;
  private cursor = 0;
  private thinkCursor = 0;
  private pending: SpawnGroup | null = null;
  private readonly previousPlayers = new Map<number, Point & { tick: number }>();
  private readonly visited = new Map<string, number>();
  constructor(readonly world: World,
    private readonly attack: (player: number, amount: number) => void,
    private readonly loot: (creature: Creature, attacker: number) => void,
    private readonly idRange: EntityIdRange = LOCAL_ENTITY_RANGE, private readonly entityAllocator?: EntityAllocator) {}

  update(tick: number, players: readonly WildlifePlayer[], caves: readonly Point[] = []): void {
    if (tick % 6 !== 0) return;
    const active = players.filter(p => p.alive && Number.isFinite(p.x + p.y + p.z));
    const living: Creature[] = [];
    for (const [id, c] of this.creatures) {
      if (c.deadUntil > 0) { if (tick >= c.deadUntil) this.creatures.delete(id); continue; }
      if (!active.some(p => Math.hypot(p.x - c.x, p.z - c.z, (p.y - c.y) * 2) < 300)) {
        this.creatures.delete(id); continue;
      }
      living.push(c);
    }
    const count = Math.min(living.length, WILDLIFE_AI_BUDGET);
    for (let i = 0; i < count; i++) {
      const c = living[(this.thinkCursor + i) % living.length];
      const def = CREATURE_DEFS[c.species];
      // Recheck existing animals too: restored populations and a changing
      // supporting surface must not leave land fauna walking on a lake bed.
      if (this.world.liquidAt(c.x, c.y + .08, c.z)) {
        this.creatures.delete(c.id); continue;
      }
      let target: WildlifePlayer | undefined, distance = Infinity;
      for (const p of active) if (!p.vehicle && Math.abs(p.y - c.y) < 3) {
        const d = Math.hypot(p.x - c.x, p.z - c.z);
        if (d < distance) { target = p; distance = d; }
      }
      const dt = c.thinkAt ? Math.min(.6, (tick - c.thinkAt) / 60) : .1;
      c.thinkAt = tick;
      let speed = 0;
      const notice = c.health < def.health ? Math.max(def.notice, 45) : def.notice;
      if (target && distance < notice) {
        const dx = target.x - c.x, dz = target.z - c.z;
        const dy = target.y - c.y, length = Math.hypot(dx, dy, dz);
        const clear = length < 0.1 || !this.world.trace(c.x, c.y + 0.6, c.z,
          dx / length, dy / length, dz / length, Math.max(0, length - 0.5)).hit;
        c.alert = clear;
        if (clear) {
          c.yaw = Math.atan2(-dx, -dz) + (def.damage ? 0 : Math.PI);
          speed = def.speed;
          if (def.damage && distance < 1.7) {
            speed = 0;
            if (tick >= c.attackAt) { this.attack(target.id, def.damage); c.attackAt = tick + 75; }
          }
        }
      } else {
        c.alert = false;
        if (tick >= c.turnAt) {
          const rng = mulberry32(hash2i(c.id, Math.floor(tick / 120), this.world.seed));
          c.yaw += (rng() - 0.5) * 2.8; c.turnAt = tick + 90 + Math.floor(rng() * 140);
        }
        speed = (tick % 240 + (c.id % 240) * 37) % 240 < 140 ? (c.species === 3 ? 1.35 : c.species === 5 ? .45 : .85) : 0;
      }
      if (Math.hypot(c.x - c.homeX, c.z - c.homeZ) > def.leash) {
        c.yaw = Math.atan2(c.x - c.homeX, c.z - c.homeZ); speed = 2; c.alert = false;
      }
      c.speed = 0;
      if (speed > 0) {
        const dx = -Math.sin(c.yaw), dz = -Math.cos(c.yaw), step = speed * dt;
        if (this.world.trace(c.x, c.y + def.height * 0.65, c.z, dx, 0, dz, step + def.radius).hit) {
          c.yaw += 1.1; continue;
        }
        const x = c.x + dx * step, z = c.z + dz * step;
        const floor = this.world.trace(x, c.y + 0.8, z, 0, -1, 0, 1.7);
        if (!floor.hit || floor.ny < 0.55 || Math.abs(floor.y - c.y) > 0.7 ||
            this.world.liquidAt(x, floor.y + .08, z) ||
            this.world.sdf(x, floor.y + def.height * 0.65, z) < def.radius * 0.65) { c.yaw += 1.1; continue; }
        c.x = x; c.z = z; c.y = floor.y + 0.03; c.speed = speed;
      }
    }
    if (living.length) this.thinkCursor = (this.thinkCursor + count) % living.length;
    // Aircraft and hyperspeed observers do not seed cold terrain queries.
    const ground = active.filter(p => {
      const previous = this.previousPlayers.get(p.id);
      this.previousPlayers.set(p.id, { x: p.x, y: p.y, z: p.z, tick });
      return p.vehicle !== VEHICLE.JET && previous !== undefined &&
        Math.hypot(p.x - previous.x, p.y - previous.y, p.z - previous.z) <= Math.max(.1, (tick - previous.tick) / 60) * 32;
    });
    for (const id of this.previousPlayers.keys()) if (!active.some(p => p.id === id)) this.previousPlayers.delete(id);
    if (!ground.length || this.creatures.size >= MAX_CREATURES) { this.pending = null; return; }
    if (this.pending) {
      const group = this.pending;
      const observer = ground.find(p => Math.abs(p.y - group.anchor.y) < (group.cave ? 12 : 65) &&
        Math.hypot(group.anchor.x - p.x, group.anchor.z - p.z) < 210);
      if (!observer) this.pending = null;
      else {
        const nearby = living.filter(c => Math.abs(c.y - observer.y) < 10 && Math.hypot(c.x - observer.x, c.z - observer.z) < 180).length;
        if (nearby < WILDLIFE_LOCAL_CAP) this.spawnMember(group, tick, ground);
        else this.pending = null;
        return;
      }
    }
    const player = ground[this.cursor++ % ground.length];
    let local = 0;
    for (const c of living) if (Math.abs(c.y - player.y) < 10 && Math.hypot(c.x - player.x, c.z - player.z) < 180) local++;
    if (local >= WILDLIFE_LOCAL_CAP) return;
    const underground = this.world.roofedAbove(player.x, player.y + 1.2, player.z);
    const offset = Math.floor((this.cursor - 1) / ground.length) % 9, cx = Math.floor(player.x / CELL) + offset % 3 - 1;
    const cz = Math.floor(player.z / CELL) + Math.floor(offset / 3) - 1;
    const layer = underground ? Math.round(player.y / 10) : 0;
    const caveX = Math.floor(player.x / 64), caveZ = Math.floor(player.z / 64);
    const key = underground ? `c:${caveX},${caveZ},${layer}:${offset}` : `s:${cx},${cz},0`;
    if ((this.visited.get(key) ?? 0) > tick) return;
    const rng = mulberry32(hash2i(this.world.seed ^ 0xfa011a ^ layer, cx, cz));
    let x = cx * CELL + 25 + rng() * 78, z = cz * CELL + 25 + rng() * 78;
    let y = player.y;
    if (underground) {
      const angle = offset * 2.4 + rng() * .5, radius = 14 + (offset % 3) * 12;
      x = Math.floor(player.x / 16) * 16 + 8 + Math.cos(angle) * radius;
      z = Math.floor(player.z / 16) * 16 + 8 + Math.sin(angle) * radius;
      // Alternate between supported discovery floors and local cave-floor
      // probes, so a chamber without a POI can still contain small wildlife.
      const candidate = this.cursor % 2 ? caves.find(p => Math.abs(p.y - player.y) < 5 &&
        Math.hypot(p.x - player.x, p.z - player.z) > 24 && Math.hypot(p.x - x, p.z - z) < 80) : undefined;
      if (candidate) { x = candidate.x; y = candidate.y; z = candidate.z; }
    } else {
      y = this.world.groundY(x, z);
      const col = this.world.column(x, z);
      if (Math.abs(y - col.h) > 2 || col.lavaY > -999) { this.remember(key, tick + 600); return; }
    }
    const distance = Math.hypot(x - player.x, z - player.z);
    if (distance < (underground ? 10 : 24) || distance > 175) return;
    if (living.some(c => Math.abs(c.y - y) < 6 && Math.hypot(c.homeX - x, c.homeZ - z) < (underground ? 16 : 28))) {
      this.remember(key, tick + 600); return;
    }
    const roll = rng(), species = underground ? (distance < 22 ? 5 : (offset + hash2i(this.world.seed, caveX, caveZ)) % 2 ? 2 : 5)
      : roll < .34 ? 0 : roll < .63 ? 3 : roll < .83 ? 4 : 1;
    const group: SpawnGroup = { key, species, anchor: { x, y, z }, member: 0,
      remaining: CREATURE_DEFS[species].damage ? 2 : 2 + (rng() < .5 ? 1 : 0), cave: underground };
    this.pending = group;
    this.remember(key, tick + 45 * 60);
    this.spawnMember(group, tick, ground);
  }

  /** At most one capsule/floor candidate per update, including companions. */
  private spawnMember(group: SpawnGroup, tick: number, players: readonly WildlifePlayer[]): void {
    const i = group.member++, a = i * 2.4 + hash2i(this.world.seed, Math.round(group.anchor.x), Math.round(group.anchor.z)) * .0001;
    const x = group.anchor.x + (i ? Math.cos(a) * (4 + i) : 0), z = group.anchor.z + (i ? Math.sin(a) * (4 + i) : 0);
    const def = CREATURE_DEFS[group.species];
    const floor = this.world.trace(x, group.anchor.y + (group.cave ? 3 : 2), z, 0, -1, 0, group.cave ? 6 : 5);
    let visible = !group.cave;
    if (floor.hit && group.cave) for (const p of players) {
      const dx = x - p.x, dy = floor.y + def.height * .6 - (p.y + 1.2), dz = z - p.z, length = Math.hypot(dx, dy, dz);
      if (Math.abs(p.y - floor.y) < 5 && length < 120) {
        visible = !this.world.trace(p.x, p.y + 1.2, p.z, dx / length, dy / length, dz / length, Math.max(0, length - .5)).hit;
        break;
      }
    }
    if (visible && floor.hit && floor.ny >= .62 && Math.abs(floor.y - group.anchor.y) < (group.cave ? 2.8 : 2.2) &&
        players.every(p => Math.hypot(p.x - x, p.z - z) > (def.cave && !def.damage ? 10 : 18) || Math.abs(p.y - floor.y) > 6) &&
        this.world.sdf(x, floor.y + def.height * .65, z) > def.radius * .75 &&
        this.world.sdf(x, floor.y + def.height, z) > .1 &&
        (!group.cave || this.world.roofedAbove(x, floor.y + 1, z))) {
      const creature = this.spawn(group.species, { x, y: floor.y + .03, z });
      if (creature) { creature.homeX = group.anchor.x; creature.homeY = floor.y; creature.homeZ = group.anchor.z; }
    }
    if (--group.remaining <= 0) this.pending = null;
    // Rejected cells get another small opportunity soon rather than leaving
    // a ninety-second empty hole after one blocked candidate.
    if (i === 0 && (!floor.hit || floor.ny < .62)) this.remember(group.key, tick + 600);
  }

  spawn(species: number, p: Point): Creature | null {
    const def = CREATURE_DEFS[species];
    if (!def || !Number.isFinite(p.x + p.y + p.z) || this.creatures.size >= MAX_CREATURES ||
        this.world.liquidAt(p.x, p.y + .08, p.z)) return null;
    const allocation = this.entityAllocator ? { id: this.entityAllocator.allocate(this.creatures), next: this.nextId }
      : allocateEntityId(this.nextId, this.creatures, this.idRange);
    const { id, next } = allocation; this.nextId = next;
    const c: Creature = { ...p, id, species, yaw: ((id % 65536) * 2.4) % (Math.PI * 2), speed: 0, alert: false,
      health: def.health, homeX: p.x, homeY: p.y, homeZ: p.z, attackAt: 0, turnAt: 0, deadUntil: 0, thinkAt: 0 };
    this.creatures.set(id, c); return c;
  }

  hitRay(x: number, y: number, z: number, dx: number, dy: number, dz: number, max: number, expand = 0): { c: Creature; t: number } | null {
    let found: { c: Creature; t: number } | null = null;
    for (const c of this.creatures.values()) {
      if (c.deadUntil) continue;
      const def = CREATURE_DEFS[c.species], radius = Math.min(def.radius, def.height / 2);
      const t = rayCapsule(x, y, z, dx, dy, dz, max, c.x,
        c.y + radius, c.y + def.height - radius, c.z, radius + expand);
      if (t >= 0 && (!found || t < found.t)) found = { c, t };
    }
    return found;
  }

  private remember(key: string, tick: number): void {
    this.visited.set(key, tick);
    while (this.visited.size > 512) this.visited.delete(this.visited.keys().next().value!);
  }

  damage(c: Creature, amount: number, attacker: number, tick: number): boolean {
    if (c.deadUntil || !Number.isFinite(amount) || amount <= 0) return false;
    c.health -= amount; c.alert = true;
    if (c.health > 0) return false;
    c.deadUntil = tick + 5 * 60; c.speed = 0; c.alert = false;
    const chance = CREATURE_DEFS[c.species].cave ? 0.85 : 0.55;
    if (mulberry32(hash2i(this.world.seed, c.id, 0x1007))() < chance) this.loot(c, attacker);
    return true;
  }

  snapshot(x: number, y: number, z: number): CreatureState[] {
    return [...this.creatures.values()].map(c => ({ c, d: Math.hypot(c.x - x, c.z - z, (c.y - y) * 2) }))
      .filter(v => v.d < 300).sort((a, b) => a.d - b.d).slice(0, MAX_VISIBLE_CREATURES)
      .map(({ c }) => ({ id: c.id, species: c.species, x: c.x, y: c.y, z: c.z,
        yaw: c.yaw, speed: c.speed, alert: c.alert, dead: c.deadUntil > 0 }));
  }
}
