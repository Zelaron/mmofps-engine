import { allocateEntityId, LOCAL_ENTITY_RANGE, type EntityIdRange, type EntityAllocator } from '@shared/entity-id';
import { World, VEHICLE, vehicleDefinition, mulberry32, hash2i, rayCapsule, CREATURE_DEFS, MAX_CREATURES,
  MAX_VISIBLE_CREATURES, ecologyForWorld, ecologyCandidates, chooseEcologyEntry,
  type PlanetEcology, type CreatureState } from '@shared/index';

export interface WildlifePlayer {
  id: number; x: number; y: number; z: number; alive: boolean; vehicle: number; isBot?: boolean;
  vehicleId?: number; vehicleVariant?: number;
}
export interface Creature extends CreatureState {
  health: number; homeX: number; homeY: number; homeZ: number;
  attackAt: number; turnAt: number; deadUntil: number; thinkAt: number;
  windupUntil: number; targetId: number;
  aggressorId: number; aggressorUntil: number; rangedAt: number; detourUntil: number;
  damageContributors: Map<number, { damage: number; lastHitTick: number }>;
}
type Point = { x: number; y: number; z: number };
type ProtectedArea = { x: number; z: number; radius: number };
interface SpawnGroup { key: string; species: number; anchor: Point; remaining: number; member: number; cave: boolean }
export const WILDLIFE_AI_BUDGET = 18;
export const WILDLIFE_LOCAL_CAP = 16;
/** Due impacts fit inside the ordinary AI budget even in crowded encounters. */
export const WILDLIFE_RANGED_CAP = 8;
const CELL = 128;
export interface WildlifeOptions {
  ecology?: PlanetEcology;
  protectedAreas?: () => readonly ProtectedArea[];
}

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
  private readonly retiredAggressors = new WeakMap<Creature, Set<number>>();
  private updateProtectedAreas: readonly ProtectedArea[] | undefined;
  readonly ecology: PlanetEcology;
  constructor(readonly world: World,
    private readonly attack: (player: number, amount: number) => void,
    private readonly loot: (creature: Creature, attacker: number) => void,
    private readonly idRange: EntityIdRange = LOCAL_ENTITY_RANGE, private readonly entityAllocator?: EntityAllocator,
    private readonly options: WildlifeOptions = {}) { this.ecology = options.ecology ?? ecologyForWorld(world.seed); }

  private protectedAt(x: number, z: number, margin = 0): boolean {
    return !!(this.updateProtectedAreas ?? this.options.protectedAreas?.())?.some(area =>
      Math.hypot(x - area.x, z - area.z) < area.radius + margin);
  }

  /** Vehicle movement uses a sphere above its feet origin. Bite that hull's
   * nearest surface, rather than chasing an inaccessible pilot at its centre.
   * A landed aircraft is reachable; one above melee height is not. The same
   * rule lets shore fauna strike a nearby boat without walking into water. */
  private contact(c: Creature, p: WildlifePlayer): Point | null {
    const def = CREATURE_DEFS[c.species], strikeY = c.y + Math.min(1, def.height * .6);
    if (!p.vehicle) return Math.abs(p.y - c.y) < (def.boss ? 9 : 3)
      ? { x: p.x, y: p.y + Math.min(1, def.height * .6), z: p.z } : null;
    const hull = vehicleDefinition(p.vehicle, p.vehicleVariant);
    if (!hull) return null;
    const dx = c.x - p.x, dy = strikeY - (p.y + hull.radius), dz = c.z - p.z;
    const length = Math.hypot(dx, dy, dz), scale = Math.min(1, hull.radius / Math.max(.001, length));
    const point = { x: p.x + dx * scale, y: p.y + hull.radius + dy * scale, z: p.z + dz * scale };
    return Math.abs(point.y - strikeY) <= (def.reach ?? 1.7) ? point : null;
  }

  private clearAttack(c: Creature, point: Point): boolean {
    const y = c.y + Math.min(1, CREATURE_DEFS[c.species].height * .6);
    const dx = point.x - c.x, dy = point.y - y, dz = point.z - c.z, length = Math.hypot(dx, dy, dz);
    return length < .1 || !this.world.trace(c.x, y, c.z, dx / length, dy / length, dz / length,
      Math.max(0, length - .15), false).hit;
  }

  private aimedPoint(p: WildlifePlayer): Point {
    const hull = p.vehicle ? vehicleDefinition(p.vehicle, p.vehicleVariant) : undefined;
    return { x: p.x, y: p.y + (hull?.radius ?? 1), z: p.z };
  }

  /** Damage memories can retain an encounter beyond the normal observer range,
   * but never across a death, departure, protected spawn or unlimited pursuit. */
  private aggressor(c: Creature, tick: number, players: ReadonlyMap<number, WildlifePlayer>): WildlifePlayer | undefined {
    const pursuit = CREATURE_DEFS[c.species].pursuit;
    if (!pursuit) return undefined;
    const valid = (id: number) => {
      if (id < 0 || this.retiredAggressors.get(c)?.has(id)) return undefined;
      const p = players.get(id);
      if (p && !this.protectedAt(p.x, p.z) && Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z) <= pursuit.range &&
          Math.hypot(p.x - c.homeX, p.z - c.homeZ) <= pursuit.range) return p;
      let retired = this.retiredAggressors.get(c);
      if (!retired) this.retiredAggressors.set(c, retired = new Set());
      retired.add(id); return undefined;
    };
    let target = tick < c.aggressorUntil ? valid(c.aggressorId) : undefined;
    if (target) return target;
    c.aggressorId = -1; c.aggressorUntil = 0;
    // If the latest attacker died, another recent living contributor remains a
    // valid provocation. The ledger is bounded and also drives shared rewards.
    let latest = -Infinity;
    for (const [id, hit] of c.damageContributors) {
      if (tick >= hit.lastHitTick + pursuit.seconds * 60 || hit.lastHitTick <= latest) continue;
      const candidate = valid(id);
      if (candidate) { target = candidate; latest = hit.lastHitTick; }
    }
    if (target) { c.aggressorId = target.id; c.aggressorUntil = latest + pursuit.seconds * 60; }
    return target;
  }

  private clearRay(from: Point, to: Point): boolean {
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z, length = Math.hypot(dx, dy, dz);
    return length < .1 || !this.world.trace(from.x, from.y, from.z, dx / length, dy / length, dz / length,
      Math.max(0, length - .15), false).hit;
  }

  /** One committed blast, at most eight cover checks, and one hit per vehicle. */
  private resolveRanged(c: Creature, actors: readonly WildlifePlayer[]): void {
    const shot = c.rangedAttack!, ranged = CREATURE_DEFS[c.species].ranged!;
    if (this.protectedAt(shot.x, shot.z) || !this.clearRay(
      { x: shot.originX, y: shot.originY, z: shot.originZ }, shot)) return;
    let checks = 0;
    for (const p of actors) {
      if (this.protectedAt(p.x, p.z)) continue;
      const center = this.aimedPoint(p), hull = p.vehicle ? vehicleDefinition(p.vehicle, p.vehicleVariant) : undefined;
      const dx = center.x - shot.x, dy = center.y - shot.y, dz = center.z - shot.z, distance = Math.hypot(dx, dy, dz);
      if (distance > shot.radius + (hull?.radius ?? 0)) continue;
      if (++checks > 8) break;
      // Cover is tested to the near hull surface, not an enclosed pilot.
      const scale = hull ? Math.max(0, 1 - hull.radius / Math.max(.001, distance)) : 1;
      const point = { x: shot.x + dx * scale, y: shot.y + dy * scale, z: shot.z + dz * scale };
      if (this.clearRay(shot, point)) this.attack(p.id, ranged.damage);
    }
  }

  update(tick: number, players: readonly WildlifePlayer[], caves: readonly Point[] = []): void {
    if (tick % 6 !== 0) return;
    const previous = this.updateProtectedAreas;
    this.updateProtectedAreas = this.options.protectedAreas?.() ?? [];
    try { this.updateActive(tick, players, caves); }
    finally { this.updateProtectedAreas = previous; }
  }

  private updateActive(tick: number, players: readonly WildlifePlayer[], caves: readonly Point[]): void {
    const active = players.filter(p => p.alive && Number.isFinite(p.x + p.y + p.z));
    const activeById = new Map(active.map(p => [p.id, p]));
    const observers = active.filter(p => !p.isBot);
    const hulls = new Set<string>();
    const actors = active.filter(p => {
      if (!p.vehicle) return true;
      const key = p.vehicleId !== undefined && p.vehicleId >= 0 ? String(p.vehicleId)
        : `${p.vehicle}:${p.x}:${p.y}:${p.z}`;
      if (hulls.has(key)) return false;
      hulls.add(key); return true;
    });
    const living: Creature[] = [];
    for (const [id, c] of this.creatures) {
      if (c.deadUntil > 0) { if (tick >= c.deadUntil) this.creatures.delete(id); continue; }
      if (!observers.some(p => Math.hypot(p.x - c.x, p.z - c.z, (p.y - c.y) * 2) < 300) &&
          !this.aggressor(c, tick, activeById)) {
        c.rangedAttack = undefined; this.creatures.delete(id); continue;
      }
      living.push(c);
    }
    const count = Math.min(living.length, WILDLIFE_AI_BUDGET);
    let committedAttacks = living.reduce((sum, c) => sum + (c.rangedAttack ? 1 : 0), 0);
    // An advertised impact is a deadline, not a suggestion for the next round-
    // robin slot. Reserve ordinary work slots for due blasts, then advance the
    // normal cursor for everyone else. No creature receives two steps here.
    const scheduled = living.filter(c => c.rangedAttack && c.rangedAttack.impactTick <= tick).slice(0, count);
    const scheduledIds = new Set(scheduled.map(c => c.id));
    let scanned = 0;
    while (scheduled.length < count) {
      const c = living[(this.thinkCursor + scanned++) % living.length];
      if (!scheduledIds.has(c.id)) { scheduled.push(c); scheduledIds.add(c.id); }
    }
    if (living.length) this.thinkCursor = (this.thinkCursor + scanned) % living.length;
    for (const c of scheduled) {
      const def = CREATURE_DEFS[c.species];
      // Recheck existing animals too: restored populations and a changing
      // supporting surface must not leave land fauna walking on a lake bed.
      if (this.world.liquidAt(c.x, c.y + .08, c.z)) {
        if (c.rangedAttack) committedAttacks--;
        this.creatures.delete(c.id); continue;
      }
      const provoker = this.aggressor(c, tick, activeById);
      let target: WildlifePlayer | undefined, contact: Point | undefined, distance = Infinity;
      for (const p of provoker ? [provoker] : actors) if (!this.protectedAt(p.x, p.z)) {
        const point = def.boss ? this.aimedPoint(p) : this.contact(c, p);
        if (!point) continue;
        const d = Math.hypot(point.x - c.x, point.z - c.z,
          point.y - c.y - Math.min(1, def.height * .6));
        if (d < distance) { target = p; contact = point; distance = d; }
      }
      const dt = c.thinkAt ? Math.min(.6, (tick - c.thinkAt) / 60) : .1;
      c.thinkAt = tick;
      let speed = 0;
      const notice = c.health < def.health ? Math.max(def.notice, 45) : def.boss ? def.notice * .65 : def.notice;
      const returning = Math.hypot(c.x - c.homeX, c.z - c.homeZ) > (provoker ? def.pursuit!.range : def.leash) ||
        !!def.damage && this.protectedAt(c.x, c.z, def.radius + 5);
      if (returning) {
        c.windupUntil = 0;
        if (c.rangedAttack) { c.rangedAttack = undefined; committedAttacks--; }
      }
      if (c.rangedAttack) {
        c.alert = true;
        if (tick >= c.rangedAttack.impactTick) {
          this.resolveRanged(c, actors); c.rangedAttack = undefined; committedAttacks--;
        } else if (tick < c.rangedAttack.fireTick) {
          c.speed = 0;
          if (!activeById.has(c.targetId)) { c.rangedAttack = undefined; committedAttacks--; }
          continue;
        }
        // After release the boss can pursue again. Its projectile keeps the
        // original launch position and aim point rather than following either.
      }
      if (c.windupUntil) {
        c.speed = 0; c.alert = true;
        if (tick >= c.windupUntil) {
          c.windupUntil = 0;
          // A committed slam stays in place; stepping out of the ring or behind
          // solid cover during the warning avoids it. Damage never goes through walls.
          let checks = 0;
          for (const p of actors) {
            const point = this.contact(c, p);
            if ((!def.boss && p.id !== c.targetId) || !point || this.protectedAt(p.x, p.z) ||
                Math.hypot(point.x - c.x, point.z - c.z,
                  point.y - c.y - Math.min(1, def.height * .6)) > (def.reach ?? 1.7)) continue;
            if (++checks > 8) break;
            if (this.clearAttack(c, point)) this.attack(p.id, def.damage);
          }
          c.attackAt = tick + (def.cooldown ?? 1.25) * 60;
        }
        continue;
      }
      if (!returning && target && contact && (provoker || distance < notice)) {
        const dx = target.x - c.x, dz = target.z - c.z;
        const meleePoint = def.boss ? this.contact(c, target) : contact;
        const meleeDistance = meleePoint ? Math.hypot(meleePoint.x - c.x, meleePoint.z - c.z,
          meleePoint.y - c.y - Math.min(1, def.height * .6)) : Infinity;
        const canCast = def.ranged && !c.rangedAttack && committedAttacks < WILDLIFE_RANGED_CAP && tick >= c.rangedAt && tick >= c.attackAt &&
          distance >= def.ranged.minRange && distance <= def.ranged.range;
        // Long pursuits do not repeat kilometer-long visibility queries every
        // AI step. Only a ready shot or close strike needs a damage sightline.
        const clear = def.boss ? (meleeDistance < (def.reach ?? 1.7)
          ? this.clearAttack(c, meleePoint!) : !provoker ? this.clearAttack(c, contact) : false)
          : this.clearAttack(c, contact);
        c.alert = !!provoker || clear;
        if (clear || def.boss && !!provoker) {
          if (tick >= c.detourUntil) c.yaw = Math.atan2(-dx, -dz) + (def.damage ? 0 : Math.PI);
          speed = provoker ? def.pursuit!.speed : def.speed;
          if (def.damage && meleeDistance < (def.reach ?? 1.7) && clear) {
            speed = 0;
            if (tick >= c.attackAt) {
              if (def.windup) { c.windupUntil = tick + def.windup * 60; c.targetId = target.id; }
              else { this.attack(target.id, def.damage); c.attackAt = tick + (def.cooldown ?? 1.25) * 60; }
            }
          } else if (canCast) {
            const origin = { x: c.x, y: c.y + def.height * .65, z: c.z };
            // A failed shot waits before probing the long sightline again;
            // cover blocks the attack, while navigation keeps approaching it.
            c.rangedAt = tick + 60;
            if (this.clearRay(origin, contact)) {
              const ranged = def.ranged!, fireTick = Math.ceil((tick + ranged.windup * 60) / 6) * 6;
              c.rangedAttack = { ...contact, originX: origin.x, originY: origin.y, originZ: origin.z,
                radius: ranged.radius, fireTick, impactTick: fireTick +
                  Math.ceil(Math.max(.5, Math.hypot(contact.x - origin.x, contact.y - origin.y, contact.z - origin.z) / ranged.speed) * 10) * 6 };
              committedAttacks++;
              c.targetId = target.id; c.rangedAt = c.rangedAttack.impactTick + ranged.cooldown * 60;
              speed = 0;
            }
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
      if (returning) {
        c.yaw = Math.atan2(c.x - c.homeX, c.z - c.homeZ); speed = 2; c.alert = false;
      }
      c.speed = 0;
      if (speed > 0) {
        const dx = -Math.sin(c.yaw), dz = -Math.cos(c.yaw), step = speed * dt;
        if (this.world.trace(c.x, c.y + def.height * 0.65, c.z, dx, 0, dz, step + def.radius, false).hit) {
          c.yaw += 1.1; if (def.boss) c.detourUntil = tick + 45; continue;
        }
        const x = c.x + dx * step, z = c.z + dz * step;
        if (def.damage && this.protectedAt(x, z, def.radius + 3)) {
          c.yaw += 1.1; if (def.boss) c.detourUntil = tick + 45; continue;
        }
        const floor = this.world.trace(x, c.y + 0.8, z, 0, -1, 0, 1.7);
        if (!floor.hit || floor.ny < 0.55 || Math.abs(floor.y - c.y) > 0.7 ||
            this.world.liquidAt(x, floor.y + .08, z) ||
            this.world.sdf(x, floor.y + def.height * 0.65, z) < def.radius * 0.65) {
          c.yaw += 1.1; if (def.boss) c.detourUntil = tick + 45; continue;
        }
        c.x = x; c.z = z; c.y = floor.y + 0.03; c.speed = speed;
      }
    }
    // Aircraft and hyperspeed observers do not seed cold terrain queries.
    const ground = observers.filter(p => {
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
    const col = this.world.column(x, z);
    // Shore monsters are still terrestrial: the candidate and its full body
    // must have a dry floor. Larger oceans do not turn every sea cell into a nest.
    const nearShore = !underground && col.h < 35 && [0, 1, 2, 3].some(i => {
      const shoreX = x + Math.cos(i * Math.PI / 2) * 72, shoreZ = z + Math.sin(i * Math.PI / 2) * 72;
      return this.world.liquidAt(shoreX, this.world.column(shoreX, shoreZ).h + .08, shoreZ)?.kind === 'water';
    });
    const entries = ecologyCandidates(this.ecology, underground ? 'cave' : 'surface', col, nearShore);
    const entry = chooseEcologyEntry(entries, rng());
    if (!entry) { this.remember(key, tick + 600); return; }
    const species = entry.species, def = CREATURE_DEFS[species];
    if (def.boss && (distance < 85 || col.city || this.protectedAt(x, z, def.leash + 30) ||
        living.some(c => CREATURE_DEFS[c.species].boss && Math.hypot(c.x - x, c.z - z) < 700)) ||
        def.damage && this.protectedAt(x, z, 20)) { this.remember(key, tick + 600); return; }
    const group: SpawnGroup = { key, species, anchor: { x, y, z }, member: 0,
      remaining: entry.group[0] + Math.floor(rng() * (entry.group[1] - entry.group[0] + 1)), cave: underground };
    this.pending = group;
    this.remember(key, tick + (def.boss ? 15 * 60 : 45) * 60);
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
    const clearBody = !def.boss || [0, 1, 2, 3].every(i => {
      const bx = x + Math.cos(i * Math.PI / 2) * def.radius, bz = z + Math.sin(i * Math.PI / 2) * def.radius;
      return !this.world.liquidAt(bx, floor.y + .08, bz) &&
        Math.abs(this.world.groundY(bx, bz) - floor.y) < 1.8 && this.world.sdf(bx, floor.y + 2, bz) > .5;
    });
    if (visible && clearBody && floor.hit && floor.ny >= .62 && Math.abs(floor.y - group.anchor.y) < (group.cave ? 2.8 : 2.2) &&
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
        this.world.liquidAt(p.x, p.y + .08, p.z) || def.damage && this.protectedAt(p.x, p.z, def.boss ? def.leash + 30 : 20)) return null;
    const allocation = this.entityAllocator ? { id: this.entityAllocator.allocate(this.creatures), next: this.nextId }
      : allocateEntityId(this.nextId, this.creatures, this.idRange);
    const { id, next } = allocation; this.nextId = next;
    const c: Creature = { ...p, id, species, yaw: ((id % 65536) * 2.4) % (Math.PI * 2), speed: 0, alert: false,
      health: def.health, homeX: p.x, homeY: p.y, homeZ: p.z, attackAt: 0, turnAt: 0, deadUntil: 0, thinkAt: 0,
      windupUntil: 0, targetId: -1, aggressorId: -1, aggressorUntil: 0, rangedAt: 0, detourUntil: 0,
      damageContributors: new Map() };
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
    const def = CREATURE_DEFS[c.species];
    if (def.boss && Number.isSafeInteger(attacker) && attacker >= 0) {
      const previous = c.damageContributors.get(attacker);
      c.damageContributors.delete(attacker);
      c.damageContributors.set(attacker, { damage: (previous?.damage ?? 0) + Math.min(c.health, amount), lastHitTick: tick });
      this.retiredAggressors.get(c)?.delete(attacker);
      while (c.damageContributors.size > 64) {
        const oldest = c.damageContributors.keys().next().value!;
        c.damageContributors.delete(oldest); this.retiredAggressors.get(c)?.delete(oldest);
      }
      c.aggressorId = attacker; c.aggressorUntil = tick + (def.pursuit?.seconds ?? 45) * 60;
    }
    c.health -= amount; c.alert = true;
    if (c.health > 0) return false;
    c.health = 0; c.deadUntil = tick + (def.boss ? 20 : 5) * 60; c.speed = 0; c.alert = false; c.windupUntil = 0;
    c.rangedAttack = undefined; c.aggressorId = -1; c.aggressorUntil = 0;
    const chance = CREATURE_DEFS[c.species].cave ? 0.85 : 0.55;
    if (CREATURE_DEFS[c.species].boss || mulberry32(hash2i(this.world.seed, c.id, 0x1007))() < chance) this.loot(c, attacker);
    return true;
  }

  snapshot(x: number, y: number, z: number): CreatureState[] {
    const priority = (c: Creature, distance: number) => c.rangedAttack &&
      Math.hypot(c.rangedAttack.x - x, c.rangedAttack.y - y, c.rangedAttack.z - z) < c.rangedAttack.radius + 64
      ? -2000 + distance : distance - (CREATURE_DEFS[c.species].boss ? 180 : 0);
    return [...this.creatures.values()].map(c => ({ c, d: Math.hypot(c.x - x, c.z - z, (c.y - y) * 2) }))
      .filter(({ c, d }) => d < 300 || CREATURE_DEFS[c.species].boss && (c.alert || c.rangedAttack) &&
        Math.hypot(c.x - x, c.y - y, c.z - z) <= (CREATURE_DEFS[c.species].pursuit?.range ?? 300))
      .sort((a, b) => priority(a.c, a.d) - priority(b.c, b.d)).slice(0, MAX_VISIBLE_CREATURES)
      .map(({ c }) => ({ id: c.id, species: c.species, x: c.x, y: c.y, z: c.z,
        yaw: c.yaw, speed: c.speed, alert: c.alert, dead: c.deadUntil > 0,
        health: Math.max(0, c.health / CREATURE_DEFS[c.species].health), windingUp: c.windupUntil > 0,
        ...(c.rangedAttack ? { rangedAttack: { ...c.rangedAttack } } : {}) }));
  }

  /** Existing encounters only; map intel must never generate or probe terrain. */
  threatReports(x: number, z: number): { id: number; species: number; x: number; y: number; z: number;
    health: number; engaged: boolean }[] {
    return [...this.creatures.values()].filter(c => !c.deadUntil && CREATURE_DEFS[c.species].boss)
      .sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z)).slice(0, 8)
      .map(c => ({ id: c.id, species: c.species, x: c.x, y: c.y, z: c.z,
        health: Math.max(0, c.health / CREATURE_DEFS[c.species].health), engaged: c.alert }));
  }
}
