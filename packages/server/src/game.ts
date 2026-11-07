import { allocateEntityId, isEntityId, namespaceRange, LOCAL_ENTITY_RANGE, type EntityIdRange, type EntityAllocator } from '@shared/entity-id';
import {
  World, mulberry32, hash2i, clamp, viewDir, aircraftCrewAim, aircraftCrewMuzzle, crewGunMuzzle,
  unquantYaw, lockedHullDamageFactor,
  TICK_RATE, TICK_DT, SNAPSHOT_EVERY, PLAYER, WORLD, NET, SWIMMING,
  createMoveState, stepMove, fallDamage,
  type MoveState, type InputCmd, BTN, HYPERSPEED_ENABLED,
  WEAPONS, pelletDir,
  RAILGUN_ID, NUKE_LAUNCHER_ID, RAIL_CHARGE, NUKE_MARKER, NUKE_BOMB,
  createFullAmmoLoadout, refillWeaponAmmo, cancelReload, stepWeaponState,
  type WeaponDef, type WeaponAmmo,
  generateTeleporters, findCaveFloorSpots, TELEPORT_RADIUS, TELEPORT_COOLDOWN_SECONDS,
  EncounterField, ENCOUNTER_REGION_SIZE, findRescueSurfaceTarget,
  type TeleporterPad, encodeTeleport,
  rayCapsule, capsuleClearance,
  VEHICLE, VEHICLE_DEFS, VEHICLE_VARIANT, bastionGunMuzzle, gunboatGunMuzzle, vehicleDefinition, vehicleArmament, weaponDefById, vehicleEyeHeight, vehicleLocalOffset, jetBombBay, jetGunMuzzle,
  JEEP_MG, TANK_CANNON, TANK_CLUSTER, CLUSTER_BOMBLET, CLUSTER_COUNT, RUN_OVER,
  JET_MG, JET_BOMB, NOCTURNE_LANCE, CARPET_BOMB_COUNT,
  LOCK_CONE_COS, LOCK_RANGE, LOCK_TICKS,
  HOMING_SPEED_FACTOR, HOMING_RANGE_FACTOR, HOMING_TURN_RATE, HOMING_AIR_TURN_RATE, HOMING_BREAK_COS,
  LOCK_NONE, LOCK_ACQUIRING, LOCK_LOCKED,
  STRUCTURE_KIND, type StructureKind, type VehicleType,
  ByteWriter, encodeSnapshot, encodeJoin, encodeLeave, encodeSpawn, encodeDeath,
  encodeFire, encodeExplosion, encodeHit, encodeScores, encodeServerMessage,
  encodePickupResult,
  ENT_PLAYER, ENT_PROJECTILE, PICKUP_HEALTH, PICKUP_AMMO, PICKUP_WEAPON,
  type PickupKind,
  PICKUP_RESULT_COLLECTED, PICKUP_RESULT_FULL,
  type Snapshot, type SnapshotEntity, type SnapshotPickup, type FireEnd,
  type SnapshotVehicle, CREATURE_DEFS,
} from '@shared/index';
import { cityRewardSites } from '@shared/cities';
import { cityLifeRewards } from '@shared/city-life';
import { buildJungleTemplePlan, templeTrapTouches } from '@shared/jungle-temples';
import { cityVehicleSites } from '@shared/cities';
import { vesperRoutes } from '@shared/vesper-city';
import { carryTransit, placeTrainArtillery, transitImpactDamage } from '@shared/transit-motion';
import { carryCityLift } from '@shared/lifts';
import { GUNBOAT_DRAFT, trainArtilleryMuzzle, vehicleEyeOffset, artilleryPitch, MAX_OWNED_ARTILLERY_SHELLS } from '@shared/vehicles';
import { harborBoatSite } from '@shared/transport';
import { airliftPose, airliftDuration, AIRLIFT_CHARGE_SECONDS } from '@shared/airlift';
import { setVehicleColliders, updateVehicleCollider, withVehicleColliders, type VehicleColliderPose } from '@shared/vehicle-collision';
import { Wildlife, type Creature } from './wildlife.js';
import { Frontier } from './frontier.js';
import { awardXp, progressStatus, recordHit, rewardBase, rewardCapture, rewardKill, rewardWar, advanceDaily } from './progression.js';
import { XP_REASON, XP_VALUES } from '@shared/progression';
import { OutpostSystem } from './outposts.js';
import { SpatialIndex } from './spatial-index.js';
import { FACTIONS, WAR_REDEPLOY_WEAPON, WILDLIFE_WEAPON, type Faction, type SpawnOption } from '@shared/frontier';
import { botCampaignRole, botRoleId } from './bots.js';
import { aircraftThreatFor } from './aircraft-threat.js';
import { BotSimulation } from './bot-simulation.js';
import { stepBotGroundVehicle } from './bot-vehicle-simulation.js';
import { captureActors, prepareArrival, validateHandoff, type RuntimeHandoff, type DetachedHandoff } from './runtime-handoff.js';

// The authoritative simulation. Runs at a fixed 60 Hz; consumes queued client
// inputs, resolves combat with lag compensation, and emits snapshots+events.
// It knows nothing about WebSockets - connections implement PlayerSink.

const NATIVE_WEAPON_TRACE = World.prototype.trace;
// These thin weapons have no gameplay effect on a terrain-only impact.
const DISTANT_MISS_WEAPONS: readonly number[] = [0, 1, 2, 7, 8, 200, 204, 214];
/** A human's handheld weapon advances one tick per command, as the shooter's
 * client predicts it, so its shots land on the predicted commands. Every
 * server tick funds one command. Unspent ticks are kept long enough for a
 * client to catch up after a stalled frame (it resynchronizes instead beyond
 * a 30-tick gap), and a stream may run as far ahead as the client's largest
 * prediction lead. Commands beyond that no longer advance the weapon, so
 * sending more cannot raise the rate of fire. */
const HUMAN_WEAPON_CREDIT_TICKS = 36;
const HUMAN_WEAPON_LEAD_TICKS = 30;

export interface PlayerSink {
  send(bytes: Uint8Array): void;
}

export class ServerPlayer {
  state: MoveState;
  health: number = PLAYER.MAX_HEALTH;
  weapon = 0;
  fireCd = 0.5;
  reloadWeapon = -1;
  reloadCd = 0;
  reloadHeld = false;
  ammo: WeaponAmmo[] = createFullAmmoLoadout();
  regenBlockUntil = 0;
  respawnAtTick = -1;
  preferredSpawnId = '';
  spawnProtectedUntil = -1;
  botRosterIndex?: number;
  lastDeath?: { x: number; y: number; z: number };
  faction: Faction = 0;
  factionChangeAt = 0;
  salvage = 30;
  salvageSpent = 0;
  salvageEarned = 0;
  discoveries = new Set<string>();
  /** Planet seeds whose one-time conquest contract has been earned. */
  campaignRewards: number[] = [];
  lastInputAtTick = 0;
  frags = 0;
  deaths = 0;
  spree = 0;
  ping = 0;
  /** Persistent career progression (humans). */
  xp = 0;
  careerKills = 0;
  captures = 0;
  warsWon = 0;
  bestStreak = 0;
  /** Daily orders: the UTC day they belong to, progress per order and a
   * completed-order bitmask (see dailyOrders in shared/progression). */
  dailyDay = 0;
  dailyProgress: number[] = [0, 0, 0];
  dailyDone = 0;
  /** This war only (reset when the next war begins): the debrief. */
  warKills = 0;
  warDeaths = 0;
  warCaptures = 0;
  warXp = 0;
  /** Enemy soldier who last killed this player (revenge bonus). */
  lastKilledBy = -1;
  /** Earliest tick this soldier may use instant redeploy again. */
  deployReadyAt = 0;
  /** Earliest tick this soldier may deploy in another fighter jet. */
  jetReadyAt = 0;
  /** Tick a bot began waiting for its assault staging to clear (-1 = not waiting). */
  deployWaitSince = -1;
  /** Recent attackers by id → tick of their last hit, for assist credit. */
  readonly recentAttackers = new Map<number, number>();
  inputQueue: InputCmd[] = [];
  lastCmd: InputCmd | null = null;
  /** Server ticks of handheld weapon time a human has not spent on commands. */
  weaponTicks = 0;
  lastProcessedSeq = 0;
  lastQueuedSeq = 0;
  hasQueuedSeq = false;
  /** Full-resource pickup contacts already reported to this player. */
  fullPickupContacts = new Set<number>();
  /** Recent enemy blast that may receive credit for an ensuing fall death. */
  fallCreditAttackerId = -1;
  fallCreditWeapon = 255;
  fallCreditUntilTick = -1;
  /** Vehicle the player currently occupies, or -1. */
  vehicleId = -1;
  useHeld = false;
  /** Brief immunity window after being clipped by a hull (repeat-hit guard). */
  ranOverUntilTick = -1;
  vehFireCd = 0;
  vehAltCd = 0;
  /** Homing lock progress (rocket launcher aimed at an occupied hull). */
  lockTargetId = -1;
  /** Stable occupied hull; the target player changes when crew take over. */
  lockVehicleId = -1;
  lockTicks = 0;
  lockState = LOCK_NONE;
  /** Teleporter re-fire lockout and off-pad re-arm state. */
  teleportCdUntil = 0;
  teleportArmed = true;
  recallSince = -1;
  trapCooldownUntil = -1;
  transitDamageUntil = -1;
  airlift?: { source: number; destination: number; start: number; x: number; y: number; z: number; health: number };
  recallAnchor = { x: 0, y: 0, z: 0, health: 0 };

  constructor(
    readonly id: number,
    readonly name: string,
    readonly sink: PlayerSink | null,
    readonly isBot: boolean,
    spawn: { x: number; y: number; z: number },
  ) {
    this.state = createMoveState(spawn.x, spawn.y, spawn.z);
  }
}

export interface Projectile {
  id: number;
  owner: number;
  weapon: number;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  distLeft: number;
  fuseLeft: number;
  /** Wall-clock flight age; used for sub-tick terrain arming. */
  ageSeconds: number;
  sleeping: boolean;
  /** Player id whose vehicle this rocket is homing on, or -1. */
  homingTarget?: number;
  /** Guidance follows this hull through driver/passenger promotion. */
  homingVehicleId?: number;
  /** A locked anti-armor warhead retains its payload even if guidance breaks. */
  hullDamageScale?: number;
}

/**
 * A world vehicle. While occupied, the driver's MoveState is authoritative
 * for pose (possession model) and this record mirrors it; while parked, the
 * record itself is authoritative and replicated in snapshots.
 *
 * The driver owns motion; one passenger owns an independent weapon.
 */
export interface ServerVehicle {
  id: number;
  type: Exclude<VehicleType, 0>;
  variant?: number;
  x: number; y: number; z: number;
  heading: number;
  health: number;
  occupant: number;
  gunner?: number;
  transportRoute?: number;
  motionState?: MoveState;
  respawnAtTick: number;
  campaignFaction?: Faction;
  campaignBaseId?: string;
  campaignHome?: { x: number; y: number; z: number; heading: number };
  /** A fighter launched by airborne deployment; removed once wrecked or abandoned. */
  deployed?: boolean;
  /** Tick a deployed hull was left without a crew (-1 while crewed). */
  abandonedAt?: number;
}

interface VehicleSite {
  y?: number;
  x: number;
  z: number;
  heading: number;
  type: Exclude<VehicleType, 0>;
  variant?: number;
}

const VEHICLE_CRASH_MIN_IMPACT = 10;
const VEHICLE_CRASH_DAMAGE_SCALE = 9;
/** A hull abandoned this far above ground crashes instead of floating. */
const VEHICLE_ABANDON_CRASH_HEIGHT = 8;
/** Below this hull speed a collision with a pedestrian is just a nudge. */
const RUN_OVER_MIN_SPEED = 7;
const VEHICLE_EXPLOSION_DEF: WeaponDef = {
  ...TANK_CANNON,
  id: 201,
  splashRadius: 8,
  splashMax: 90,
  splashImpulse: 24,
};
/** Per-world caps keep hulls special without starving a roaming population. */
const VEHICLE_CAPS: Record<Exclude<VehicleType, 0>, number> = {
  [VEHICLE.JEEP]: 9,
  [VEHICLE.TANK]: 5,
  [VEHICLE.JET]: 3,
  [VEHICLE.GUNBOAT]: 6,
};

/** One district in four keeps its full motor pool, preserving grouped bases. */
export function vehicleDistrictActive(seed: number, cx: number, cz: number): boolean {
  return (hash2i(seed ^ 0x401a, cx, cz) & 3) === 0;
}
/**
 * Parked hulls replicate far beyond ordinary entity interest: they are
 * static, cheap (21 bytes before optional variant fields), and the client draws a beacon column over them
 * so a stranded player can actually FIND one. Occupied hulls still use the
 * ordinary interest radius via their driver's entity.
 */
const VEHICLE_INTEREST_RADIUS = 1800;
/** Instant redeploy: allowed this long after the last hit taken, then cools down. */
const DEPLOY_COMBAT_GRACE_SECONDS = 6;
const DEPLOY_COOLDOWN_SECONDS = 15;
/** Airborne deployment: cooldown per soldier, cap per faction, launch speed. */
const JET_DEPLOY_COOLDOWN_TICKS = 45 * TICK_RATE;
const JET_DEPLOY_FACTION_CAP = 4;
const JET_DEPLOY_SPEED = 85;
const JET_DEPLOY_ALTITUDE = 260;
/** Launch this far behind the friendly base, so a pilot can orient before enemy air defenses. */
const JET_DEPLOY_BEHIND = 1300;
const JET_ABANDON_TICKS = 40 * TICK_RATE;
/** Off-screen travel: a bot this far from its objective, unseen by any human
 * and out of combat, redeploys at its forward staging instead of marching. */
const BOT_REDEPLOY_DISTANCE = 1200;
const BOT_REDEPLOY_HUMAN_RANGE = 900;
const BOT_REDEPLOY_MARCH_TICKS = 20 * TICK_RATE;
const BOT_REDEPLOY_PER_PASS = 6;
/** Bounded spawn-option evaluations per pass (each one scans reinforcement options). */
const BOT_REDEPLOY_CHECKS_PER_PASS = 12;
/** Longest a bot waits for its own assault staging before using another base. */
const BOT_STAGING_WAIT_TICKS = 8 * TICK_RATE;
const MAX_SNAPSHOT_VEHICLES = 24;

interface QueuedEvent {
  bytes: Uint8Array;
  /** If set, only players within `radius` of (x,z) receive the event. */
  x?: number;
  z?: number;
  radius?: number;
  /** Strategic shot owners still receive their own distant impact once. */
  alwaysFor?: number;
}

interface HistEntry { x: number; y: number; z: number; alive: boolean }
interface HistFrame { tick: number; byId: Map<number, HistEntry> }

/** Longer than the maximum configured blast launch across the world height span. */
const BLAST_FALL_CREDIT_TICKS = 10 * TICK_RATE;

export const PICKUP_LIFETIME_TICKS = 30 * TICK_RATE;
export const PICKUP_GRACE_TICKS = Math.round(0.25 * TICK_RATE);
export const MAX_LIVE_PICKUPS = 48;
export const HEALTH_PICKUP_AMOUNT = 35;
export const BOT_AMMO_REGEN_TICKS = 8 * TICK_RATE;
export const BOSS_REWARD_LIFETIME_TICKS = 5 * 60 * TICK_RATE;
export const BOSS_REWARD_RESERVATION_TICKS = 90 * TICK_RATE;
export const BOSS_CONTRIBUTION_WINDOW_TICKS = 2 * 60 * TICK_RATE;
export const BOSS_MIN_DAMAGE_FRACTION = .01;
const PICKUP_COLLECT_RADIUS = 1.25;
const PICKUP_CONTACT_RELEASE_RADIUS = 1.55;
const PICKUP_PLAYER_CELL_SIZE = 4;
const PICKUP_PLAYER_GRID_OFFSET =
  Math.ceil(WORLD.BORDER / PICKUP_PLAYER_CELL_SIZE) + 2;
const PICKUP_PLAYER_GRID_STRIDE = PICKUP_PLAYER_GRID_OFFSET * 2 + 1;

export interface ServerPickup extends SnapshotPickup {
  availableAtTick: number;
  expiresAtTick: number;
  /** Cave loot: never expires and never evicted by the live-pickup cap. */
  permanent?: boolean;
  /** Shared boss cache: participants get time to return before it becomes public. */
  rewardFor?: ReadonlySet<number>;
  reservedUntilTick?: number;
}

/** A fixed cave-loot spot that respawns its pickup after collection. */
interface CaveLootSpot {
  region?: string;
  kind: PickupKind;
  weapon: number;
  x: number; y: number; z: number;
  activeId: number;
  respawnAtTick: number;
}

const CAVE_LOOT_RESPAWN_TICKS = 45 * TICK_RATE;
/** Weapon stashes hidden through the caverns (each = weapon + ammo crate). */
const CAVE_STASH_COUNT = 90;
/** Health lost per second while touching a lava pool (on foot). */
const LAVA_DPS = 40;

/** Fixed weapon-scaled payload; approximately 15% of a spawn loadout. */
export function ammoPickupAmount(weapon: number): number {
  const def = WEAPONS[weapon];
  if (!def || def.infiniteReserve) return 0;
  return Math.max(1, Math.ceil((def.magazineSize + def.reserveSize) * 0.15));
}

export class Game {
  readonly world: World;
  readonly idRange: EntityIdRange;
  private readonly entityAllocator?: EntityAllocator;
  readonly wildlife: Wildlife;
  private readonly wildlifeEnabled: boolean;
  tick = 0;
  readonly players = new Map<number, ServerPlayer>();
  readonly projectiles = new Map<number, Projectile>();
  readonly pickups = new Map<number, ServerPickup>();
  readonly vehicles = new Map<number, ServerVehicle>();
  readonly stats = { shotsFired: 0, kills: 0 };
  readonly botSimulation = new BotSimulation();
  readonly frontier: Frontier | null;
  readonly camps = new OutpostSystem(this);
  private readonly playerIndex = new SpatialIndex<ServerPlayer>(256);
  private readonly projectileIndex = new SpatialIndex<Projectile>(256);
  private readonly ownedArtillery = new Map<number, Projectile[]>();
  private readonly homingObstructions = new WeakMap<ServerPlayer, Map<number, { fraction: number; tick: number }>>();
  private readonly rewardedBosses = new WeakSet<Creature>();
  /** Per bot: objective it is marching to and since when. */
  private readonly marches = new Map<number, { target: string; since: number }>();

  teleporterPads: TeleporterPad[] = [];
  private caveLoot: CaveLootSpot[] = [];
  private vehicleSites: VehicleSite[] = [];
  private encounterField: EncounterField | null = null;
  private encounterRevision = -1;
  private readonly knownLootRegions = new Set<string>();
  private activeLootRegions = new Set<string>();
  private regionalVehicles = false;
  private regionalTeleporters = false;
  private readonly vehicleRegionRetry = new Map<string, number>();
  private readonly vehicleRegionQueue: string[] = [];
  private vehicleRegionJob: { key: string; iterator: Generator<void> } | null = null;
  private nextVehicleId = 1;
  private nextPlayerId = 1;
  private nextBotRosterIndex = 0;
  private nextProjectileId = 1;
  private nextPickupId = 1;
  private events: QueuedEvent[] = [];
  private history: (HistFrame | null)[] = new Array(NET.LAG_HISTORY_TICKS).fill(null);
  private rng: () => number;
  /** Loot activity must never perturb the deterministic player spawn stream. */
  private lootRng: () => number;
  private readonly hyperspeed: boolean;

  constructor(
    readonly seed: number,
    options: { vehicles?: boolean; teleporters?: boolean; wildlife?: boolean; frontier?: boolean; entityNamespace?: number; entityAllocator?: EntityAllocator;
      /** Honour playtest hyperspeed from humans (default HYPERSPEED_ENABLED). */
      hyperspeed?: boolean } = {},
  ) {
    this.hyperspeed = options.hyperspeed ?? HYPERSPEED_ENABLED;
    if (options.entityNamespace !== undefined && options.entityAllocator) throw new Error('Choose a reserved allocator or a legacy namespace');
    this.entityAllocator = options.entityAllocator;
    this.idRange = options.entityNamespace === undefined ? LOCAL_ENTITY_RANGE : namespaceRange(options.entityNamespace);
    this.world = new World(seed);
    this.frontier = options.frontier ? new Frontier(this.world) : null;
    if (this.frontier) {
      this.frontier.mobileSpawns = p => this.mobileSpawnOptions(p);
      this.frontier.airSpawns = p => this.airSpawnOptions(p);
      this.frontier.spawnActors = () => this.players.values();
      this.frontier.warStarted = () => this.redeployForWar();
      this.frontier.warDecided = war => rewardWar(this.players.values(), war.victor);
      this.frontier.captured = event => rewardCapture(event.participants, event.site, event.neutralized);
      this.frontier.baseChanged = (base, owner) => { if (owner) rewardBase(this.players.values(), base, owner); };
      this.frontier.progress = p => progressStatus(p);
    }
    this.wildlifeEnabled = options.wildlife ?? false;
    this.wildlife = new Wildlife(this.world, (id, amount) => {
      const player = this.players.get(id);
      if (!player || this.tick < player.spawnProtectedUntil) return;
      const hull = this.vehicles.get(player.vehicleId);
      if (hull) this.damageVehicle(hull, amount, null, 255);
      else this.damage(player, amount, player, WILDLIFE_WEAPON, 0, 0, 0);
    }, (creature, attacker) => this.dropCreatureLoot(creature, attacker), this.idRange, this.entityAllocator,
    { protectedAreas: () => this.frontier?.protectedAreas() ?? [] });
    if (this.frontier) this.frontier.threatReports = p => this.wildlife.threatReports(p.state.px, p.state.pz);
    if (this.frontier) this.frontier.airfields = () => this.airfieldReports();
    this.rng = mulberry32(seed ^ 0x51ce7);
    this.lootRng = mulberry32(seed ^ 0x10_07_5eed);
    // Bounded districts and filtered runway candidates keep vehicle setup
    // independent of a full-world primitive scan. Tests that do not exercise
    // vehicles skip setup; the live server always opts in.
    if (options.vehicles) this.initVehicles();
    if (options.teleporters) this.initTeleporters();
  }

  /** Cold start only: set the shared time before admitting actors. A running
   * simulation must catch up by stepping, never by moving this clock. */
  initializeClock(tick: number): void {
    if (this.tick !== 0 || this.players.size || this.projectiles.size || !Number.isSafeInteger(tick) || tick < 0) throw new Error('Cannot initialize an active simulation clock');
    this.tick = tick;
    this.world.motionTime = tick / TICK_RATE;
    this.updateVehicles();
  }

  // ---- Teleporters --------------------------------------------------------

  /** Static admission layout; regional discoveries never change its indices. */
  get baseTeleporterPads(): readonly TeleporterPad[] { return this.encounterField?.base ?? []; }

  initTeleporters(): void {
    this.regionalTeleporters = true;
    if (this.teleporterPads.length > 0) return;
    this.teleporterPads = generateTeleporters(this.world);
    this.encounterField = new EncounterField(this.world, this.teleporterPads);
    // Rooftop caches reward the stairs/lifts and elevated routes. Only the
    // surface carbine/repeater appear here; cavern exclusives stay underground.
    for (const city of this.world.collectCities()) for (const spot of cityRewardSites(city)) {
      for (const kind of [PICKUP_WEAPON, PICKUP_AMMO] as const) this.caveLoot.push({
        kind, weapon: spot.weapon, x: spot.x + (kind === PICKUP_AMMO ? 1.7 : 0),
        y: spot.y + .4, z: spot.z, activeId: 0, respawnAtTick: 0,
      });
    }
    for (const city of this.world.collectCities()) for (const spot of cityLifeRewards(city)) {
      const weapon = spot.weapon ?? -1;
      const kind = spot.kind === 'health' ? PICKUP_HEALTH : spot.kind === 'weapon' && WEAPONS[weapon]?.spawnEmpty ? PICKUP_WEAPON : PICKUP_AMMO;
      this.caveLoot.push({ kind, weapon, x: spot.x, y: spot.y + .4, z: spot.z, activeId: 0, respawnAtTick: 0 });
    }
    // Platform aid kiosks give waiting passengers a useful, replenishing stop.
    for (const station of this.world.collectTransportPlan().stations) {
      for (const [kind, weapon, dx] of [[PICKUP_HEALTH, -1, 50], [PICKUP_AMMO, 3, 55]] as const) {
        this.caveLoot.push({ kind, weapon, x: station.x + dx, y: station.railY + 1.6,
          z: station.z - 32, activeId: 0, respawnAtTick: 0 });
      }
    }
    for (const site of this.world.collectJungleTemples()) for (const spot of buildJungleTemplePlan(site).loot) {
      this.caveLoot.push({ kind: WEAPONS[spot.weapon]?.spawnEmpty ? PICKUP_WEAPON : PICKUP_AMMO,
        weapon: spot.weapon, x: spot.x, y: spot.y + .4, z: spot.z, activeId: 0, respawnAtTick: 0 });
    }
    // Exclusive weapons reward exploring chambers with walkable surface
    // exits. Keep them away from pads, with a matching ammo crate nearby.
    const cavePads = this.teleporterPads.filter((pad) => pad.cave);
    const stashes = findCaveFloorSpots(
      this.world, CAVE_STASH_COUNT, 0x10071007, 65, 200000, cavePads, 55, true,
    );
    for (let i = 0; i < stashes.length; i++) {
      const spot = stashes[i];
      const weapon = i % 2 === 0 ? RAILGUN_ID : NUKE_LAUNCHER_ID;
      this.caveLoot.push({
        kind: PICKUP_WEAPON, weapon,
        ...this.settleLootSpot(spot, 0, 0),
        activeId: 0, respawnAtTick: 0,
      });
      this.caveLoot.push({
        kind: PICKUP_AMMO, weapon,
        ...this.settleLootSpot(spot, 1.7, 0.9),
        activeId: 0, respawnAtTick: 0,
      });
    }
  }

  /** Settle a loot spot onto the cave floor near a found stash point. */
  private settleLootSpot(
    base: { x: number; y: number; z: number }, dx: number, dz: number,
  ): { x: number; y: number; z: number } {
    const x = base.x + dx, z = base.z + dz;
    let originY = base.y + 1.4;
    for (let lift = 0; lift < 5 && this.world.sdf(x, originY, z) <= 0.02; lift++) {
      originY += 0.25;
    }
    if (this.world.sdf(x, originY, z) > 0.02) {
      const hit = this.world.trace(x, originY, z, 0, -1, 0, originY - WORLD.KILL_Y);
      if (hit.hit) {
        for (const hover of [0.35, 0.55, 0.8]) {
          if (this.world.sdf(x, hit.y + hover, z) > 0.08) {
            return { x, y: hit.y + hover, z };
          }
        }
      }
    }
    // Rough floor beside the stash; fall back to the found point itself.
    return { x: base.x, y: base.y + 0.4, z: base.z };
  }

  private updateTeleporters(): void {
    if (this.teleporterPads.length === 0) return;
    const r2 = TELEPORT_RADIUS * TELEPORT_RADIUS;
    for (const p of this.players.values()) {
      // Bots stay surface-bound: a bot warped into a cavern would wander
      // there forever and starve the arena.
      if (p.isBot) continue;
      if (!p.state.alive || p.state.vehicle !== VEHICLE.NONE || p.state.airlift) continue;
      let onPad: TeleporterPad | null = null;
      for (const pad of this.teleporterPads) {
        const dx = p.state.px - pad.x, dz = p.state.pz - pad.z;
        if (dx * dx + dz * dz > r2) continue;
        if (Math.abs(p.state.py - pad.y) > 3.2) continue;
        onPad = pad;
        break;
      }
      if (!onPad) {
        p.teleportArmed = true;
        continue;
      }
      if (!p.teleportArmed || this.tick < p.teleportCdUntil) continue;
      const dest = this.teleporterPads[onPad.partner];
      if (!dest) continue;
      const from = { x: p.state.px, y: p.state.py, z: p.state.pz };
      p.state.px = dest.x;
      p.state.py = dest.y + 0.25;
      p.state.pz = dest.z;
      p.state.vx = 0; p.state.vy = 0; p.state.vz = 0;
      p.state.grounded = false;
      p.teleportArmed = false;
      p.teleportCdUntil = this.tick + TELEPORT_COOLDOWN_SECONDS * TICK_RATE;
      // Global event: both ends may be outside any interest radius pair.
      this.events.push({
        bytes: encodeTeleport({
          id: p.id,
          fromX: from.x, fromY: from.y, fromZ: from.z,
          toX: p.state.px, toY: p.state.py, toZ: p.state.pz,
        }),
      });
    }
  }

  // ---- Vehicles -----------------------------------------------------------

  /** A stationary four-second recall prevents disconnected lower rooms from
   * becoming traps. Moving, shooting, damage or releasing Use cancels it. */
  private updateCaveRecall(): void {
    if (!this.regionalTeleporters) return;
    for (const p of this.players.values()) {
      const s = p.state, held = ((p.lastCmd?.buttons ?? 0) & BTN.USE) !== 0;
      if (p.isBot || !s.alive || s.vehicle !== VEHICLE.NONE || !held ||
          ((p.lastCmd?.buttons ?? 0) & (BTN.FIRE | BTN.ALTFIRE)) !== 0) { p.recallSince = -1; continue; }
      if (Math.hypot(s.vx, s.vy, s.vz) > 1.2 || !s.grounded) { p.recallSince = -1; continue; }
      if (p.recallSince < 0) {
        if (this.world.terrainHeight(s.px, s.pz) - s.py < 2.5 ||
            !this.world.roofedAbove(s.px, s.py + PLAYER.EYE_HEIGHT, s.pz)) continue;
        p.recallSince = this.tick;
        p.recallAnchor = { x: s.px, y: s.py, z: s.pz, health: p.health };
      }
      if (Math.hypot(s.px - p.recallAnchor.x, s.py - p.recallAnchor.y, s.pz - p.recallAnchor.z) > .8 ||
          p.health < p.recallAnchor.health) { p.recallSince = -1; continue; }
      if (this.tick - p.recallSince < 4 * TICK_RATE) continue;
      const target = findRescueSurfaceTarget(this.teleporterPads, s.px, s.pz);
      if (!target) continue;
      const from = { x: s.px, y: s.py, z: s.pz };
      s.px = target.x; s.py = target.y + .25; s.pz = target.z;
      s.vx = s.vy = s.vz = 0; s.grounded = false;
      p.teleportArmed = false; p.teleportCdUntil = this.tick + TELEPORT_COOLDOWN_SECONDS * TICK_RATE;
      p.recallSince = -1;
      this.events.push({ bytes: encodeTeleport({ id: p.id, fromX: from.x, fromY: from.y, fromZ: from.z,
        toX: s.px, toY: s.py, toZ: s.pz }) });
      p.sink?.send(encodeServerMessage('Surface recall complete'));
    }
  }

  initVehicles(): void {
    if (this.vehicleSites.length > 0) return;
    this.regionalVehicles = true;
    this.encounterField ??= new EncounterField(this.world);
    const siteRng = mulberry32(this.seed ^ 0x7e41c1e);
    const candidates: Record<Exclude<VehicleType, 0>, VehicleSite[]> = {
      [VEHICLE.JEEP]: [],
      [VEHICLE.TANK]: [],
      [VEHICLE.JET]: [],
      [VEHICLE.GUNBOAT]: [],
    };
    const half = WORLD.BORDER;
    const sites = new Map<string, ReturnType<World['collectSurfaceSites']>[number]>();
    const district = (x: number, z: number): void => {
      for (const site of this.world.collectSurfaceSites(x - 180, x + 180, z - 180, z + 180)) {
        sites.set(`${site.x},${site.z}`, site);
      }
    };
    // Keep some hulls near the main population and sample a fixed number
    // of districts throughout the expanded map. Extending the border moves
    // those districts apart instead of multiplying expensive site searches.
    for (const x of [-768, 0, 768]) for (const z of [-768, 0, 768]) district(x, z);
    const span = half - 400;
    for (let x = 0; x < 5; x++) for (let z = 0; z < 5; z++) {
      district((x / 4 * 2 - 1) * span, (z / 4 * 2 - 1) * span);
    }
    for (const site of this.world.collectSurfaceSites(-half, half, -half, half, STRUCTURE_KIND.RUNWAY)) {
      sites.set(`${site.x},${site.z}`, site);
    }
    for (const site of sites.values()) {
      // Sites hugging the border wall park vehicles against (or on top of)
      // the wall geometry; leave a generous margin.
      if (Math.max(Math.abs(site.x), Math.abs(site.z)) > half - 120) continue;
      const alongX = site.hx >= site.hz;
      const stripHeading = alongX ? -Math.PI / 2 : 0;
      if (site.kind === STRUCTURE_KIND.RUNWAY) {
        candidates[VEHICLE.JET].push({
          x: site.x, z: site.z, heading: stripHeading, type: VEHICLE.JET,
        });
        continue;
      }
      // Ground vehicles park just off the foundation apron.
      const roll = siteRng();
      let type: Exclude<VehicleType, 0> | undefined;
      if ((site.kind === STRUCTURE_KIND.BUNKER && roll < 0.6) ||
          (site.kind === STRUCTURE_KIND.MILITARY_BASE && roll < 0.6)) {
        type = VEHICLE.TANK;
      } else if (
        site.kind === STRUCTURE_KIND.MILITARY_BASE ||
        site.kind === STRUCTURE_KIND.ENCAMPMENT ||
        site.kind === STRUCTURE_KIND.BUNKER ||
        site.kind === STRUCTURE_KIND.HANGAR ||
        site.kind === STRUCTURE_KIND.RELAY ||
        site.kind === STRUCTURE_KIND.COURTYARD
      ) {
        type = VEHICLE.JEEP;
      }
      if (!type) continue;
      const radius = VEHICLE_DEFS[type].radius;
      for (const [dx, dz] of [[site.hx + 5.5, 3], [-site.hx - 5.5, -3], [3, site.hz + 5.5], [-3, -site.hz - 5.5]]) {
        const x = site.x + dx, z = site.z + dz;
        const y = this.world.groundY(x, z);
        const col = this.world.column(x, z);
        if (col.lavaY > -999 || Math.abs(y - col.h) > 1.5) continue;
        const heights = [[radius, 0], [-radius, 0], [0, radius], [0, -radius]]
          .map(([ox, oz]) => this.world.groundY(x + ox, z + oz));
        if (heights.some((height) => Math.abs(height - y) > 0.8)) continue;
        if (this.world.sdf(x, y + radius, z) < radius - 0.15) continue;
        candidates[type].push({ x, z, heading: 0, type });
        break;
      }
    }
    for (const type of [VEHICLE.JEEP, VEHICLE.TANK, VEHICLE.JET] as const) {
      const list = candidates[type];
      // Deterministic thinning to the cap, spread across the whole map.
      const keep = Math.min(list.length, VEHICLE_CAPS[type]);
      const stride = list.length > 0 ? list.length / Math.max(1, keep) : 1;
      for (let i = 0; i < keep; i++) {
        const site = list[Math.min(list.length - 1, Math.floor(i * stride))];
        this.vehicleSites.push(site);
        this.spawnVehicleAt(site);
      }
    }
    // Capital hulls are deterministic landmarks, independent of random district thinning.
    for (const city of this.world.collectCities()) for (const site of cityVehicleSites(city)) {
      this.vehicleSites.push(site);
      this.spawnVehicleAt(site);
    }
    for (const harbor of this.world.collectTransportPlan().harbors) {
      const berth = harborBoatSite(harbor), wet = this.world.liquidAt(berth.x, harbor.y - .1, berth.z);
      const site: VehicleSite = { type: VEHICLE.GUNBOAT, x: berth.x,
        y: (wet?.surfaceY ?? harbor.y) - GUNBOAT_DRAFT - .05, z: berth.z, heading: berth.heading };
      this.vehicleSites.push(site); this.spawnVehicleAt(site);
    }
    for (const route of this.world.collectTransportPlan().routes) if (route.kind === 'train') {
      const state = createMoveState(0, 0, 0); placeTrainArtillery(this.world, state, route.id, this.tick / TICK_RATE);
      const v = this.spawnVehicleAt({ type: VEHICLE.TANK, variant: VEHICLE_VARIANT.RAIL, x: state.px,
        y: state.py - .05, z: state.pz, heading: state.heading });
      v.transportRoute = route.id;
    }
    this.initCampaignVehicles();
  }

  private initCampaignVehicles(): void {
    if (!this.frontier) return;
    for (const base of this.frontier.bases) {
      const roads = this.world.collectRoadSegments(base.x - 240, base.x + 240, base.z - 240, base.z + 240).filter(r => !r.trail);
      const city = base.kind === 'city' ? this.world.collectCities().find(c => base.id === `base-city-${c.id}`) : undefined;
      // Capitals have walkable decks below their skyline. Parking on the
      // highest groundY hit places transports on roofs instead of avenues.
      const lanes = city?.theme === 'vesper'
        ? vesperRoutes(city).filter(r => Math.abs(r.y - (city.y + .06)) < .1).map(r => ({
          a: { x: r.ax, y: r.y, z: r.az }, b: { x: r.bx, y: r.y, z: r.bz } }))
        : city?.theme === 'aurelia' ? [
          { a: { x: city.x - 200, y: city.y + .06, z: city.z }, b: { x: city.x + 200, y: city.y + .06, z: city.z } },
          { a: { x: city.x, y: city.y + .06, z: city.z }, b: { x: city.x, y: city.y + .06, z: city.z + 200 } },
        ]
        : roads;
      const points = lanes.flatMap(r => {
        const dx = r.b.x - r.a.x, dz = r.b.z - r.a.z, length = Math.hypot(dx, dz);
        const nearest = length ? Math.max(0, Math.min(1, ((base.x - r.a.x) * dx + (base.z - r.a.z) * dz) / (length * length))) : 0;
        return [-64, -40, -16, 16, 40, 64].map(offset => {
          const t = Math.max(0, Math.min(1, nearest + offset / Math.max(1, length)));
          return { x: r.a.x + dx * t, y: city ? city.y + .06 : r.a.y + (r.b.y - r.a.y) * t,
            z: r.a.z + dz * t, heading: Math.atan2(-dx, -dz) };
        });
      }).sort((a, b) => Math.hypot(a.x - base.x, a.z - base.z) - Math.hypot(b.x - base.x, b.z - base.z));
      const types = base.kind === 'outpost' ? [VEHICLE.JEEP, VEHICLE.JEEP, VEHICLE.TANK, VEHICLE.JEEP, VEHICLE.TANK, VEHICLE.JEEP] as const
        : base.kind === 'city' ? [VEHICLE.JEEP, VEHICLE.JEEP, VEHICLE.TANK, VEHICLE.JEEP] as const : [VEHICLE.JEEP] as const;
      let index = 0;
      for (const point of points) {
        if (index >= types.length) break;
        if (Math.hypot(point.x - base.x, point.z - base.z) > 220 || [...this.vehicles.values()].some(v => Math.hypot(v.x - point.x, v.z - point.z) < 16)) continue;
        const type = types[index], def = vehicleDefinition(type)!, y = city ? point.y : this.world.groundY(point.x, point.z);
        if (this.world.liquidAt(point.x, y + .1, point.z) || Math.abs(y - point.y) > 2) continue;
        if ([[0, 0], [def.radius, 0], [-def.radius, 0], [0, def.radius], [0, -def.radius]].some(([dx, dz]) => {
          const floor = this.world.trace(point.x + dx, y + .8, point.z + dz, 0, -1, 0, 1.6);
          return !floor.hit || Math.abs(floor.dist - .8) > .3;
        })) continue;
        if (this.world.sdf(point.x, y + def.radius, point.z) < def.radius - .15) continue;
        const site = { type, x: point.x, y, z: point.z, heading: point.heading };
        this.vehicleSites.push(site);
        const v = this.spawnVehicleAt(site);
        v.campaignFaction = base.owner; v.campaignBaseId = base.id;
        v.campaignHome = { x: site.x, y: site.y, z: site.z, heading: site.heading };
        index++;
      }
    }
  }

  /** Deploy specialist crews beside real, unoccupied hulls. Boarding and
   * flight still use their ordinary inputs and authoritative collision. */
  private stageVehicleCrew(player: ServerPlayer): void {
    const role = botCampaignRole(botRoleId(player));
    const type = role === 'pilot' || role === 'aircrew' ? VEHICLE.JET : role === 'sailor' || role === 'navalcrew' ? VEHICLE.GUNBOAT : 0;
    if (!type) return;
    const crew = role === 'aircrew' || role === 'navalcrew';
    const candidates = [...this.vehicles.values()].filter(v => v.type === type &&
      (crew ? v.campaignFaction === player.faction && (v.gunner ?? -1) < 0 :
        v.occupant < 0 && (v.campaignFaction === undefined || v.campaignFaction === player.faction)));
    candidates.sort((a, b) => Math.hypot(a.x - player.state.px, a.z - player.state.pz) - Math.hypot(b.x - player.state.px, b.z - player.state.pz));
    const hull = candidates[0]; if (!hull) return;
    const def = vehicleDefinition(type, hull.variant)!;
    const anchor = hull.respawnAtTick >= 0 ? hull.campaignHome : hull;
    if (!anchor) return;
    for (let k = 0; k < 16; k++) {
      const angle = k * Math.PI / 8, radius = type === VEHICLE.GUNBOAT ? 8 : def.radius + 1.5;
      const x = anchor.x + Math.cos(angle) * radius, z = anchor.z + Math.sin(angle) * radius, y = this.world.groundY(x, z) + .08;
      if (this.world.liquidAt(x, y, z) || Math.abs(y - anchor.y) > 5 || capsuleClearance(this.world, x, y, z) < -.02) continue;
      if ([...this.players.values()].some(p => p.id !== player.id && p.state.alive && this.areEnemies(player, p) &&
        Math.abs(p.state.py - y) < 60 && Math.hypot(p.state.px - x, p.state.pz - z) < 180)) continue;
      Object.assign(player.state, { px: x, py: y, pz: z }); hull.campaignFaction = player.faction;
      hull.campaignHome ??= { x: hull.x, y: hull.y - .05, z: hull.z, heading: hull.heading };
      return;
    }
  }

  private mobileSpawnOptions(player: ServerPlayer): SpawnOption[] {
    if (!player.faction) return [];
    const result: SpawnOption[] = [];
    for (const v of this.vehicles.values()) {
      if (v.type !== VEHICLE.JEEP || v.respawnAtTick >= 0 || v.campaignFaction !== player.faction || v.health < vehicleDefinition(v.type, v.variant)!.maxHealth * .4) continue;
      const driver = this.players.get(v.occupant), motion = driver?.state ?? v.motionState;
      if (motion && (motion.airlift || Math.hypot(motion.vx, motion.vy, motion.vz) > 1.5)) continue;
      if (this.frontier!.bases.some(b => b.owner === player.faction && Math.hypot(b.x - v.x, b.z - v.z) < 150)) continue;
      if ([...this.players.values()].some(q => q.state.alive && this.areEnemies(player, q) && Math.hypot(q.state.px - v.x, q.state.pz - v.z) < 100)) continue;
      const radius = vehicleDefinition(v.type, v.variant)!.radius + 3;
      for (let k = 0; k < 8; k++) {
        const x = v.x + Math.cos(k * Math.PI / 4) * radius, z = v.z + Math.sin(k * Math.PI / 4) * radius, y = this.world.groundY(x, z) + .08;
        if (Math.abs(y - v.y) > 2 || this.world.liquidAt(x, y, z) || capsuleClearance(this.world, x, y, z) < -.02) continue;
        result.push({ id: `mobile-${v.id}`, name: 'Mobile rally jeep', x, y, z, kind: 'mobile' }); break;
      }
    }
    return result.slice(0, 12);
  }

  /** Fighter deployment: airborne over the faction's held ground nearest its
   * current operation, flying toward the fight. Humans only; never automatic. */
  private airSpawnOptions(player: ServerPlayer): SpawnOption[] {
    if (!this.frontier || !player.faction || player.isBot) return [];
    const order = this.frontier.order(player);
    const owned = this.frontier.bases.filter(b => b.owner === player.faction);
    if (!owned.length) return [];
    const goal = order ?? owned[0];
    const anchor = owned.reduce((a, b) => Math.hypot(a.x - goal.x, a.z - goal.z) <= Math.hypot(b.x - goal.x, b.z - goal.z) ? a : b);
    let dx = goal.x - anchor.x, dz = goal.z - anchor.z, length = Math.hypot(dx, dz);
    if (length < 1) { dx = -anchor.x; dz = -anchor.z; length = Math.hypot(dx, dz) || 1; }
    const ux = dx / length, uz = dz / length;
    const limit = WORLD.BORDER - 900;
    const x = clamp(anchor.x - ux * JET_DEPLOY_BEHIND, -limit, limit), z = clamp(anchor.z - uz * JET_DEPLOY_BEHIND, -limit, limit), heading = Math.atan2(-ux, -uz);
    let ground = -Infinity;
    for (let d = 0; d <= 2400; d += 300) for (const side of [-120, 0, 120])
      ground = Math.max(ground, this.world.groundY(x + ux * d - uz * side, z + uz * d + ux * side));
    const y = Math.max(ground, 0) + JET_DEPLOY_ALTITUDE;
    let active = 0;
    for (const v of this.vehicles.values()) {
      const pilot = this.players.get(v.occupant);
      if (v.deployed && v.respawnAtTick < 0 && pilot && !pilot.isBot && pilot.faction === player.faction) active++;
    }
    const cooling = this.tick < player.jetReadyAt, full = active >= JET_DEPLOY_FACTION_CAP;
    return [{ id: 'air-jet', name: 'Fighter jet · airborne', kind: 'air', x, y, z, heading, baseId: anchor.id,
      available: !cooling && !full,
      reason: cooling ? `Fighter ready in ${Math.ceil((player.jetReadyAt - this.tick) / TICK_RATE)} s.`
        : full ? 'All faction fighter slots are flying. Try again shortly.'
        : `Launch airborne over ${anchor.name}, heading for ${order ? order.name.replace(/^(Capture|Defend) /, '') : 'the front'}.` }];
  }

  /** Seat a deploying soldier in a fresh fighter already in level flight. */
  private launchJet(p: ServerPlayer, heading: number): void {
    const s = p.state;
    const v = this.spawnVehicleAt({ type: VEHICLE.JET, x: s.px, y: s.py - .05, z: s.pz, heading });
    v.deployed = true; v.abandonedAt = -1; v.occupant = p.id; v.campaignFaction = p.faction;
    p.vehicleId = v.id; p.spawnProtectedUntil = -1;
    s.vehicle = VEHICLE.JET; s.vehicleVariant = 0; s.seat = 0; s.vehicleId = v.id; s.transportRoute = undefined;
    s.heading = heading; s.vehiclePitch = 0; s.vehicleRoll = 0; s.boosting = false; s.vehicleRotation = undefined;
    s.vx = -Math.sin(heading) * JET_DEPLOY_SPEED; s.vy = 0; s.vz = -Math.cos(heading) * JET_DEPLOY_SPEED;
    s.grounded = false; s.boostFuel = 1;
    p.vehFireCd = 0.5; p.vehAltCd = 1;
    p.jetReadyAt = this.tick + JET_DEPLOY_COOLDOWN_TICKS;
  }

  /** Bots never spend minutes marching across empty country where no human
   * can see them: an idle, unobserved bot far from its objective quietly
   * redeploys at the objective's forward staging (the ordinary respawn path).
   * Bots near any human keep moving physically. */
  private redeployDistantBots(): void {
    const frontier = this.frontier!;
    const humans: ServerPlayer[] = [];
    for (const p of this.players.values()) if (!p.isBot && p.state.alive) humans.push(p);
    let moved = 0, checked = 0;
    for (const p of this.players.values()) {
      if (!p.isBot || !p.state.alive || p.state.vehicle !== VEHICLE.NONE || p.airlift || p.state.airlift) { this.marches.delete(p.id); continue; }
      const role = botCampaignRole(botRoleId(p));
      if (role === 'pilot' || role === 'aircrew' || role === 'sailor' || role === 'navalcrew') continue;
      const order = frontier.order(p);
      if (!order) { this.marches.delete(p.id); continue; }
      const march = this.marches.get(p.id);
      if (!march || march.target !== order.targetId) { this.marches.set(p.id, { target: order.targetId, since: this.tick }); continue; }
      if (this.tick - march.since < BOT_REDEPLOY_MARCH_TICKS || this.tick < p.regenBlockUntil) continue;
      const goal = order.phase === 'assemble' ? order.staging : order;
      if (Math.hypot(goal.x - p.state.px, goal.z - p.state.pz) < BOT_REDEPLOY_DISTANCE) continue;
      if (humans.some(h => Math.hypot(h.state.px - p.state.px, h.state.pz - p.state.pz) < BOT_REDEPLOY_HUMAN_RANGE)) continue;
      let threatened = false;
      for (const q of this.playerIndex.query(p.state.px, p.state.pz, 160)) {
        if (q.state.alive && this.areEnemies(p, q) && Math.hypot(q.state.px - p.state.px, q.state.pz - p.state.pz) < 160) { threatened = true; break; }
      }
      if (threatened) continue;
      // Only worthwhile when a safe deployment near the objective exists now.
      if (++checked > BOT_REDEPLOY_CHECKS_PER_PASS) break;
      const near = frontier.spawnOptions(p, this.tick).some(o => o.kind !== 'air' && Math.hypot(o.x - goal.x, o.z - goal.z) < 700);
      if (!near) continue;
      p.state.alive = false; p.health = 0; p.state.vx = p.state.vy = p.state.vz = 0;
      cancelReload(p); this.clearFallDamageCredit(p);
      p.respawnAtTick = this.tick + 2 * TICK_RATE; p.spawnProtectedUntil = -1;
      this.events.push({ bytes: encodeDeath(p.id, p.id, WAR_REDEPLOY_WEAPON), x: p.state.px, z: p.state.pz, radius: NET.INTEREST_RADIUS * 1.5 });
      this.marches.delete(p.id);
      if (++moved >= BOT_REDEPLOY_PER_PASS) break;
    }
  }

  /** A new war begins: every soldier redeploys from the rotated home regions
   * through the ordinary respawn flow (staggered, safety-checked), and depot
   * vehicles return home under their base's new owner. */
  private redeployForWar(): void {
    for (const p of this.players.values()) {
      p.warKills = p.warDeaths = p.warCaptures = p.warXp = 0;
      if (p.state.vehicle !== VEHICLE.NONE) this.releaseVehicleSeat(p);
      p.airlift = undefined; p.state.airlift = undefined;
      p.state.vx = p.state.vy = p.state.vz = 0;
      p.preferredSpawnId = ''; p.lastDeath = undefined;
      p.spree = 0;
      if (p.state.alive) {
        p.state.alive = false; p.health = 0;
        cancelReload(p); this.clearFallDamageCredit(p);
        this.events.push({ bytes: encodeDeath(p.id, p.id, WAR_REDEPLOY_WEAPON) });
      }
      // Humans get a short deployment choice; bots trickle in over 3 s so the
      // safety-checked spawn searches do not land on a single tick.
      p.respawnAtTick = this.tick + (p.isBot ? 20 + (p.id * 7919) % 160 : 6 * TICK_RATE);
      p.spawnProtectedUntil = -1;
      this.frontier?.send(p, this.players.values(), this.tick);
    }
    for (const v of this.vehicles.values()) {
      if (v.deployed) { this.vehicles.delete(v.id); continue; }
      if (!v.campaignHome || !v.campaignBaseId || v.transportRoute) continue;
      v.x = v.campaignHome.x; v.y = v.campaignHome.y + .05; v.z = v.campaignHome.z; v.heading = v.campaignHome.heading;
      v.health = vehicleDefinition(v.type, v.variant)!.maxHealth; v.occupant = -1; v.gunner = -1;
      v.respawnAtTick = -1; v.motionState = undefined;
      v.campaignFaction = this.frontier?.bases.find(b => b.id === v.campaignBaseId)?.owner ?? 0;
    }
    this.projectiles.clear(); this.ownedArtillery.clear();
  }

  requestRespawn(player: ServerPlayer, id: string): boolean {
    if (!this.frontier || id.length > 80) return false;
    if (id && !this.frontier.spawnOptions(player, this.tick).some(option => option.id === id)) return false;
    player.preferredSpawnId = id;
    this.frontier.send(player, this.players.values(), this.tick); return true;
  }

  private spawnVehicleAt(site: VehicleSite): ServerVehicle {
    const def = vehicleDefinition(site.type, site.variant)!;
    const groundY = this.world.groundY(site.x, site.z);
    const id = this.allocateEntity('nextVehicleId', this.vehicles);
    const v: ServerVehicle = {
      id,
      type: site.type, variant: site.variant ?? 0,
      x: site.x,
      y: (site.y ?? groundY) + 0.05,
      z: site.z,
      heading: site.heading,
      health: def.maxHealth,
      occupant: -1,
      respawnAtTick: -1,
    };
    this.vehicles.set(v.id, v);
    return v;
  }

  /** Active districts carry their own transport and loot density. Bounded
   * candidate steps keep exploration from launching a whole-map rescan. */
  private updateEncounters(backlog = 0): void {
    const field = this.encounterField;
    if (!field) return;
    const humans = [...this.players.values()].filter(p => !p.isBot && p.state.alive);
    const points = humans.length ? humans.map(p => ({ x: p.state.px, z: p.state.pz })) : [{ x: 0, z: 0 }];
    // Selection/revisions stay current even while new procedural discovery
    // waits for simulation headroom. One candidate can still overrun; under
    // debt, a six-tick heartbeat bounds starvation without batching a scan.
    const behind = backlog >= 2;
    field.update(points, behind ? 0 : 1, behind ? (this.tick % 6 === 0 ? 1 : 0) : 8);
    if (field.revision !== this.encounterRevision) {
      this.encounterRevision = field.revision;
      if (this.regionalTeleporters) this.teleporterPads = field.pads.slice();
      this.activeLootRegions = new Set(field.regions.map(r => r.key));
      for (const region of field.regions) {
        if (!this.regionalTeleporters) break;
        if (this.knownLootRegions.has(region.key)) continue;
        this.knownLootRegions.add(region.key);
        for (let i = 0; i < region.loot.length; i++) {
          const spot = region.loot[i];
          if (this.caveLoot.some(s => Math.abs(s.y - spot.y) < 5 && Math.hypot(s.x - spot.x, s.z - spot.z) < 12)) continue;
          const weapon = spot.weapon;
          for (const [kind, dx, dz] of [[PICKUP_WEAPON, 0, 0], [PICKUP_AMMO, 1.7, 0.9]] as const) {
            this.caveLoot.push({ region: region.key, kind, weapon, ...this.settleLootSpot(spot, dx, dz),
              activeId: 0, respawnAtTick: 0 });
          }
        }
      }
    }
    if (!this.regionalVehicles) return;
    if (this.tick % 60 === 1) {
      for (const region of field.regions) {
        if ((this.vehicleRegionRetry.get(region.key) ?? 0) > this.tick || this.vehicleRegionJob?.key === region.key || this.vehicleRegionQueue.includes(region.key)) continue;
        this.vehicleRegionQueue.push(region.key);
      }
    }
    if (!this.vehicleRegionJob) {
      const key = this.vehicleRegionQueue.shift();
      if (key) this.vehicleRegionJob = { key, iterator: this.populateVehicleRegion(key) };
    }
    if (this.vehicleRegionJob?.iterator.next().done) {
      this.vehicleRegionRetry.set(this.vehicleRegionJob.key, this.tick + 45 * TICK_RATE);
      this.vehicleRegionJob = null;
    }
  }

  private *populateVehicleRegion(key: string): Generator<void> {
    if (!this.activeLootRegions.has(key)) return;
    const [cx, cz] = key.split(',').map(Number), size = ENCOUNTER_REGION_SIZE;
    if (!vehicleDistrictActive(this.seed, cx, cz)) return;
    const x0 = cx * size, z0 = cz * size;
    const counts = [0, 0, 0, 0];
    for (const v of this.vehicles.values()) if (v.x >= x0 && v.x < x0 + size && v.z >= z0 && v.z < z0 + size) counts[v.type]++;
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
      if (!this.activeLootRegions.has(key)) return;
      const sites = this.world.collectSurfaceSites(x0 + i * 256, x0 + (i + 1) * 256,
        z0 + j * 256, z0 + (j + 1) * 256);
      yield;
      for (const site of sites) {
        if (!this.activeLootRegions.has(key)) return;
        let type: Exclude<VehicleType, 0> = site.kind === STRUCTURE_KIND.RUNWAY ? VEHICLE.JET
          : (site.kind === STRUCTURE_KIND.BUNKER || site.kind === STRUCTURE_KIND.MILITARY_BASE) && counts[VEHICLE.TANK] < 1 ? VEHICLE.TANK : VEHICLE.JEEP;
        if (counts[type] >= (type === VEHICLE.JEEP ? 3 : 1)) continue;
        if (type === VEHICLE.JEEP && !([STRUCTURE_KIND.MILITARY_BASE, STRUCTURE_KIND.ENCAMPMENT, STRUCTURE_KIND.BUNKER,
          STRUCTURE_KIND.HANGAR, STRUCTURE_KIND.RELAY, STRUCTURE_KIND.COURTYARD] as StructureKind[]).includes(site.kind)) continue;
        const radius = VEHICLE_DEFS[type].radius;
        const offsets = type === VEHICLE.JET ? [[0, 0]] :
          [[site.hx + 5.5, 3], [-site.hx - 5.5, -3], [3, site.hz + 5.5], [-3, -site.hz - 5.5]];
        for (const [dx, dz] of offsets) {
          const x = site.x + dx, z = site.z + dz, y = this.world.groundY(x, z);
          if (Math.max(Math.abs(x), Math.abs(z)) > WORLD.BORDER - 100) continue;
          const col = this.world.column(x, z);
          if (col.lavaY > -999 || this.world.sdf(x, y + radius, z) < radius - 0.15) continue;
          if (type !== VEHICLE.JET && (Math.abs(y - col.h) > 1.5 ||
              [[radius, 0], [-radius, 0], [0, radius], [0, -radius]].some(([ox, oz]) => Math.abs(this.world.groundY(x + ox, z + oz) - y) > 0.8))) continue;
          if ([...this.vehicles.values()].some(v => Math.hypot(v.x - x, v.z - z) < 12)) continue;
          if (this.vehicles.size >= 160) {
            const players = [...this.players.values()].filter(p => p.state.alive);
            const removable = [...this.vehicles.values()].filter(v => !v.variant && !v.campaignBaseId && !v.campaignHome && v.occupant < 0 &&
              players.every(p => Math.hypot(p.state.px - v.x, p.state.pz - v.z) > 2400));
            removable.sort((a, b) => Math.hypot(b.x - x, b.z - z) - Math.hypot(a.x - x, a.z - z));
            if (!removable[0]) return;
            this.vehicles.delete(removable[0].id);
          }
          const candidate = { x, z, type, heading: type === VEHICLE.JET && site.hx >= site.hz ? -Math.PI / 2 : 0 };
          if (!this.vehicleSites.some(s => s.type === type && Math.hypot(s.x - x, s.z - z) < 1)) this.vehicleSites.push(candidate);
          this.spawnVehicleAt(candidate); counts[type]++; break;
        }
        yield;
      }
    }
  }

  private toggleVehicle(p: ServerPlayer): void {
    if (p.state.vehicle !== VEHICLE.NONE) {
      this.exitVehicle(p);
      return;
    }
    let best: ServerVehicle | null = null;
    let bestD2 = Infinity;
    for (const v of this.vehicles.values()) {
      if ((v.occupant >= 0 && ((v.gunner ?? -1) >= 0 || v.transportRoute)) || v.respawnAtTick >= 0) continue;
      const pilot = this.players.get(v.occupant);
      if (this.frontier && pilot && pilot.faction !== p.faction) continue;
      const def = vehicleDefinition(v.type, v.variant)!;
      const dx = v.x - p.state.px;
      const dy = (v.y + def.radius) - (p.state.py + 1);
      const dz = v.z - p.state.pz;
      const d2 = dx * dx + dy * dy + dz * dz;
      const range = def.enterRange;
      if (d2 <= range * range && d2 < bestD2) { best = v; bestD2 = d2; }
    }
    if (!best) return;
    p.spawnProtectedUntil = -1;
    const driver = this.players.get(best.occupant);
    if (this.frontier) best.campaignFaction = p.faction;
    if (driver) best.gunner = p.id;
    else best.occupant = p.id;
    p.vehicleId = best.id;
    const s = p.state;
    s.vehicle = best.type;
    s.vehicleVariant = best.variant ?? 0;
    s.seat = best.transportRoute ? 2 : driver ? 1 : 0; s.vehicleId = best.id; s.transportRoute = best.transportRoute;
    s.heading = best.heading;
    s.vehiclePitch = 0; s.vehicleRoll = 0; s.boosting = false;
    s.vehicleRotation = undefined; // the first flight tick starts from this possession's runway heading
    s.px = best.x; s.py = best.y; s.pz = best.z;
    s.vx = 0; s.vy = 0; s.vz = 0;
    s.boostFuel = 1;
    if (driver) this.copyCrewPose(p, driver);
    p.vehFireCd = 0.5;
    p.vehAltCd = 1;
  }

  private copyCrewPose(passenger: ServerPlayer, driver: ServerPlayer): void {
    const a = passenger.state, b = driver.state;
    a.px = b.px; a.py = b.py; a.pz = b.pz;
    a.vx = b.vx; a.vy = b.vy; a.vz = b.vz;
    a.heading = b.heading; a.vehiclePitch = b.vehiclePitch; a.vehicleRoll = b.vehicleRoll;
    a.vehicleRotation = b.vehicleRotation ? { ...b.vehicleRotation } : undefined;
    a.grounded = b.grounded; a.boostFuel = b.boostFuel; a.boosting = b.boosting;
  }

  requestAirlift(p: ServerPlayer, destination: number): boolean {
    if (!p.state.alive || p.state.vehicle || p.airlift || p.state.airlift) return false;
    const pods = this.world.collectTransportPlan().pods, s = p.state;
    const source = pods.find(pod => Math.hypot(pod.x - s.px, pod.y - s.py, pod.z - s.pz) < 3.2);
    if (!source || source.id === destination || !pods.some(pod => pod.id === destination)) return false;
    p.airlift = { source: source.id, destination, start: this.tick, x: s.px, y: s.py, z: s.pz, health: p.health };
    p.sink?.send(encodeServerMessage('Airlift charging — hold position for 3 seconds'));
    return true;
  }

  private updateAirlifts(): void {
    for (const p of this.players.values()) {
      if (p.state.airlift) {
        const s=p.state, flight=s.airlift!, plan=this.world.collectTransportPlan();
        const pose=airliftPose(plan,flight,this.tick);
        if(!s.alive||!pose) {s.airlift=undefined;continue;}
        // Flights advance even if a background tab stops sending input.
        s.px=pose.x;s.py=pose.y;s.pz=pose.z;s.vx=pose.vx;s.vy=pose.vy;s.vz=pose.vz;
        s.simulationTick=this.tick;
        if(pose.progress>=1) {
          s.airlift=undefined;s.vx=s.vy=s.vz=0;s.grounded=false;
          p.teleportArmed=false;p.teleportCdUntil=this.tick+3*TICK_RATE;
          p.sink?.send(encodeServerMessage(`Arrived at ${plan.pods.find(pod=>pod.id===flight.destination)!.name}`));
        }
        continue;
      }
      const flight = p.airlift; if (!flight) continue;
      const s = p.state;
      if (!s.alive || s.vehicle || p.health < flight.health || Math.hypot(s.px - flight.x, s.py - flight.y, s.pz - flight.z) > 1.5) {
        p.airlift = undefined; p.sink?.send(encodeServerMessage('Airlift cancelled')); continue;
      }
      if (this.tick - flight.start < AIRLIFT_CHARGE_SECONDS * TICK_RATE) continue;
      const pods=this.world.collectTransportPlan().pods;
      const source=pods.find(pod=>pod.id===flight.source)!, destination=pods.find(pod=>pod.id===flight.destination)!;
      s.airlift={source:source.id,destination:destination.id,startTick:this.tick,durationTicks:Math.round(airliftDuration(source,destination)*TICK_RATE)};
      s.px=source.x;s.py=source.y+.08;s.pz=source.z;
      s.vx=s.vy=s.vz=0;s.grounded=false;p.airlift=undefined;
      p.sink?.send(encodeServerMessage(`Launching to ${destination.name}`));
    }
  }

  /** Release only this seat; a remaining gunner takes over the moving hull. */
  private releaseVehicleSeat(p: ServerPlayer): ServerVehicle | undefined {
    const v = this.vehicles.get(p.vehicleId), s = p.state;
    if (v?.occupant === p.id) {
      v.x = s.px; v.y = s.py; v.z = s.pz; v.heading = s.heading;
      v.motionState = undefined;
      const next = this.players.get(v.gunner ?? -1);
      if (next?.state.alive) { this.copyCrewPose(next, p); next.state.seat = 0; v.occupant = next.id; }
      else v.occupant = -1;
      v.gunner = -1;
    } else if (v?.gunner === p.id) v.gunner = -1;
    s.vehicle = VEHICLE.NONE; s.vehicleVariant = 0; s.seat = undefined; s.vehicleId = undefined; s.transportRoute = undefined;
    p.vehicleId = -1;
    return v;
  }

  private exitVehicle(p: ServerPlayer): void {
    const v = this.vehicles.get(p.vehicleId);
    const s = p.state;
    const type = s.vehicle as Exclude<VehicleType, 0>;
    const def = vehicleDefinition(type, s.vehicleVariant);
    this.releaseVehicleSeat(p);

    // Place the pilot beside the hull on the first capsule-clear side,
    // sweeping eight directions at two distances before giving up.
    const baseDist = def ? def.radius + 1.4 : 2.4;
    const right = s.heading - Math.PI / 2;
    let placed = false;
    outer:
    for (const dist of type === VEHICLE.GUNBOAT ? [7.5, baseDist, baseDist + 1.6] : [baseDist, baseDist + 1.6]) {
      for (let k = 0; k < 8; k++) {
        const angle = right + (k * Math.PI) / 4;
        const ex = s.px - Math.sin(angle) * dist;
        const ez = s.pz - Math.cos(angle) * dist;
        const floor = this.world.trace(ex, s.py + (type === VEHICLE.GUNBOAT ? 4.5 : 2), ez, 0, -1, 0, type === VEHICLE.GUNBOAT ? 6 : 8);
        if (!floor.hit) continue;
        const gy = floor.y;
        const exitPose = { ...s, px: ex, py: gy + .1, pz: ez, simulationTick: this.tick };
        const clear = withVehicleColliders(this.world, exitPose, 0,
          () => capsuleClearance(this.world, ex, gy + .1, ez));
        if (clear > 0.02) {
          s.px = ex; s.py = gy + 0.1; s.pz = ez;
          placed = true;
          break outer;
        }
      }
    }
    if (!placed) {
      // Bail out upward (mid-air jet exits land here) and let physics sort
      // out the fall onto the hull or surrounding terrain.
      s.py += def ? def.radius + 1.2 : 2;
    }
    s.vx = 0; s.vy = 0; s.vz = 0;
    s.grounded = false;

    if (!v || v.occupant >= 0 || v.transportRoute) return;
    // Settle the abandoned hull onto the real ground below. Only a jet
    // abandoned mid-flight crashes (nobody wants one floating mid-sky);
    // jeeps and tanks simply drop - exiting above an entrance shaft used
    // to blow the hull up because the shaft floor read as "hopelessly
    // airborne".
    const support = this.world.trace(v.x, v.y + .2, v.z, 0, -1, 0, VEHICLE_ABANDON_CRASH_HEIGHT);
    if (v.type === VEHICLE.JET && !support.hit) {
      this.destroyVehicle(v, p, 255);
    } else {
      v.motionState = createMoveState(v.x, v.y, v.z);
      Object.assign(v.motionState, { vehicle: v.type, vehicleVariant: v.variant ?? 0, heading: v.heading,
        grounded: support.hit && Math.abs(support.y - v.y) < .2, simulationTick: this.tick });
    }
  }

  /**
   * Pedestrians clipped by a moving hull get run over: lethal at driving
   * speed, survivable (with a shove) only at a crawl. Occupants of other
   * vehicles are immune - hull-vs-hull stays a weapons matter.
   */
  private sweepRunOver(driver: ServerPlayer, from?: {x:number;y:number;z:number}): void {
    const s = driver.state;
    const def = vehicleDefinition(s.vehicle, s.vehicleVariant);
    if (!def) return;
    const speed = Math.hypot(s.vx, s.vz);
    if (speed < RUN_OVER_MIN_SPEED) return;
    const rr = def.radius + PLAYER.RADIUS + 0.35;
    for (const q of this.players.values()) {
      if (q.id === driver.id || !q.state.alive) continue;
      if (q.state.vehicle !== VEHICLE.NONE) continue;
      if (this.tick < q.ranOverUntilTick) continue;
      // Batched remote ground motion is short, but its whole segment must
      // still meet pedestrians; crew and damage continue on every tick.
      let x=s.px,y=s.py,z=s.pz;
      if(from){
        const vx=s.px-from.x,vz=s.pz-from.z,length=vx*vx+vz*vz;
        const t=length?clamp(((q.state.px-from.x)*vx+(q.state.pz-from.z)*vz)/length,0,1):1;
        x=from.x+vx*t;y=from.y+(s.py-from.y)*t;z=from.z+vz*t;
      }
      const dx = q.state.px - x;
      const dz = q.state.pz - z;
      if (dx * dx + dz * dz > rr * rr) continue;
      if (q.state.py > y + def.radius * 2 + 0.5 ||
          q.state.py + PLAYER.HEIGHT < y - 0.5) continue;
      q.ranOverUntilTick = this.tick + 45;
      const dmg = (speed - RUN_OVER_MIN_SPEED + 4) * 22;
      this.damage(q, dmg, driver, RUN_OVER.id, s.vx * 0.5, 6, s.vz * 0.5);
    }
  }

  damageVehicle(
    v: ServerVehicle,
    amount: number,
    attacker: ServerPlayer | null,
    weaponId: number,
  ): void {
    if (v.respawnAtTick >= 0 || v.health <= 0 || amount <= 0) return;
    if (this.frontier && attacker) {
      const occupants = [this.players.get(v.occupant), this.players.get(v.gunner ?? -1)].filter((p): p is ServerPlayer => !!p);
      if (occupants.some(p => p.id !== attacker.id && !this.areEnemies(attacker, p))) return;
      if (attacker.faction === 0 && !occupants.some(p => p.id === attacker.id)) return;
    }
    v.health -= amount;
    if (this.frontier && attacker) {
      const victim = this.players.get(v.occupant) ?? this.players.get(v.gunner ?? -1);
      if (victim && this.areEnemies(attacker, victim)) this.frontier.recordCombat(v.x, v.z, [attacker.faction, victim.faction], this.tick);
    }
    if (v.health <= 0) this.destroyVehicle(v, attacker, weaponId);
  }

  private destroyVehicle(
    v: ServerVehicle,
    attacker: ServerPlayer | null,
    weaponId: number,
  ): void {
    const def = vehicleDefinition(v.type, v.variant)!;
    v.health = 0;
    v.respawnAtTick = this.tick + Math.round(def.respawnSeconds * TICK_RATE);
    updateVehicleCollider(this.world, this.tick, this.vehicleCollider(v));
    const occupants = [this.players.get(v.occupant), this.players.get(v.gunner ?? -1)];
    if (attacker && this.frontier && occupants.some(o => o && o.faction !== attacker.faction) && !v.transportRoute) {
      awardXp(attacker, XP_VALUES.vehicle, XP_REASON.VEHICLE);
      advanceDaily(attacker, 'vehicles');
    }
    v.occupant = -1; v.gunner = -1;
    for (const occupant of occupants) if (occupant && occupant.vehicleId === v.id) {
      const s = occupant.state;
      v.x = s.px; v.y = s.py; v.z = s.pz;
      occupant.vehicleId = -1;
      s.vehicle = VEHICLE.NONE; s.vehicleVariant = 0;
      s.seat = undefined; s.vehicleId = undefined;
      s.transportRoute = undefined;
      if (s.alive) this.kill(occupant, attacker ?? occupant, weaponId);
    }
    // The dying hull explodes: splash players AND chain to nearby hulls.
    // damageVehicle's dead-guard bounds the recursion at the hull count.
    this.explode(
      v.x, v.y + def.radius, v.z,
      attacker, VEHICLE_EXPLOSION_DEF, -1, 0,
    );
  }

  private updateVehicles(): void {
    for (const v of this.vehicles.values()) {
      // Unmanned depot stock follows the base when it changes hands. A crew
      // or a transport already on the road keeps its allegiance until lost.
      if (v.campaignBaseId && v.campaignHome && v.occupant < 0 && (v.gunner ?? -1) < 0 &&
          (v.respawnAtTick >= 0 || (this.tick % TICK_RATE === 0 && Math.hypot(v.x - v.campaignHome.x, v.z - v.campaignHome.z) < 8))) {
        const base = this.frontier?.bases.find(b => b.id === v.campaignBaseId);
        if (base) v.campaignFaction = base.owner;
      }
      if (v.transportRoute) {
        const pose = createMoveState(v.x, v.y, v.z); placeTrainArtillery(this.world, pose, v.transportRoute, this.tick / TICK_RATE);
        v.x = pose.px; v.y = pose.py; v.z = pose.pz; v.heading = pose.heading;
        if (v.respawnAtTick >= 0 && this.tick >= v.respawnAtTick) { v.respawnAtTick = -1; v.health = vehicleDefinition(v.type, v.variant)!.maxHealth; }
        continue;
      }
      if (v.respawnAtTick < 0 && v.occupant < 0) {
        const state = v.motionState ??= Object.assign(createMoveState(v.x, v.y, v.z), { vehicle: v.type,
          vehicleVariant: v.variant ?? 0, heading: v.heading, grounded: true, simulationTick: this.tick - 1 });
        const before = (this.tick - 1) / TICK_RATE, now = this.tick / TICK_RATE;
        if (!state.grounded || v.type === VEHICLE.GUNBOAT) stepMove(this.world, state,
          { seq: 0, buttons: 0, weapon: 0, yaw: v.heading, pitch: 0, renderTick: 0, renderFrac: 0 }, TICK_DT, this.tick);
        else { carryTransit(this.world, state, before, now); carryCityLift(this.world, state, before, now); }
        v.x = state.px; v.y = state.py; v.z = state.pz; v.heading = state.heading;
      }
      if (v.deployed) {
        // Deployed fighters never respawn: a wreck or an abandoned hull leaves.
        if (v.occupant >= 0 || (v.gunner ?? -1) >= 0) v.abandonedAt = -1;
        else if ((v.abandonedAt ?? -1) < 0) v.abandonedAt = this.tick;
        if ((v.respawnAtTick >= 0 && this.tick >= v.respawnAtTick) ||
            (v.respawnAtTick < 0 && (v.abandonedAt ?? -1) >= 0 && this.tick - v.abandonedAt! > JET_ABANDON_TICKS)) this.vehicles.delete(v.id);
        continue;
      }
      if (v.respawnAtTick < 0 || this.tick < v.respawnAtTick) continue;
      if (this.vehicleSites.length === 0) { v.respawnAtTick = -1; continue; }
      // Respawn elsewhere: pick a random matching site clear of players.
      let site: VehicleSite | null = null;
      const candidates = v.campaignHome ? [{ ...v.campaignHome, type: v.type, variant: v.variant }]
        : this.vehicleSites.filter(s => s.type === v.type && (s.variant ?? 0) === (v.variant ?? 0));
      for (let attempt = 0; attempt < 8 && candidates.length; attempt++) {
        const candidate = candidates[
          Math.min(
            candidates.length - 1,
            Math.floor(this.rng() * candidates.length),
          )
        ];
        if (candidate.type !== v.type || (candidate.variant ?? 0) !== (v.variant ?? 0)) continue;
        let blocked = false;
        for (const q of this.players.values()) {
          const dx = q.state.px - candidate.x;
          const dz = q.state.pz - candidate.z;
          const clearance = v.campaignHome ? vehicleDefinition(v.type, v.variant)!.radius + 1 : 50;
          if (q.state.alive && dx * dx + dz * dz < clearance * clearance) { blocked = true; break; }
        }
        if (!blocked) { site = candidate; break; }
      }
      if (!site) continue; // try again next tick
      const def = vehicleDefinition(v.type, v.variant)!;
      v.x = site.x;
      v.z = site.z;
      v.y = (site.y ?? this.world.groundY(site.x, site.z)) + 0.05;
      v.heading = site.heading;
      v.health = def.maxHealth;
      v.occupant = -1;
      v.respawnAtTick = -1;
      v.motionState = undefined;
    }
  }

  // ---- Player lifecycle --------------------------------------------------

  /** Campaign reinforcements use held bases; arena fixtures retain their
   * existing nearby-player spawn policy. Selection is revalidated at spawn. */
  private pickSpawn(excludeId: number): { x: number; y: number; z: number; air?: number } | null {
    if (this.frontier) {
      const player = this.players.get(excludeId);
      if (!player) return null;
      const available = this.frontier.spawnOptions(player, this.tick);
      const air = available.find(option => option.kind === 'air' && option.id === player.preferredSpawnId);
      if (air) return { x: air.x, y: air.y, z: air.z, air: air.heading ?? 0 };
      const options = available.filter(option => option.kind !== 'air');
      // Bots deploy for their squad's operation; humans without a chosen base
      // join the nearest active operation (usually its forward staging).
      const order = this.frontier.order(player);
      // An assault squad briefly waits for its forward staging to clear rather
      // than deploying kilometres away and spending minutes marching back.
      if (player.isBot && order && order.phase !== 'defend' && player.respawnAtTick >= 0 &&
          !options.some(option => option.id === `assault-${order.targetId}`) && this.frontier.hasAssaultStaging(player, order.targetId)) {
        if (player.deployWaitSince < 0) player.deployWaitSince = this.tick;
        if (this.tick - player.deployWaitSince < BOT_STAGING_WAIT_TICKS) return null;
      }
      options.sort((a, b) => Number(b.id === player.preferredSpawnId) - Number(a.id === player.preferredSpawnId) ||
        (order ? Math.hypot(a.x - order.x, a.z - order.z) - Math.hypot(b.x - order.x, b.z - order.z) : 0));
      const actors = [...this.players.values()];
      for (const anchor of options) {
        const point = this.placeAt(player, anchor, actors);
        if (point) return point;
      }
      // Stay in the deployment window until a vetted approach is available.
      // Falling back to an occupied flag recreates an endless defender pileup.
      return null;
    }
    const alive: ServerPlayer[] = [];
    for (const q of this.players.values()) {
      if (q.state.alive && q.id !== excludeId) alive.push(q);
    }
    if (alive.length > 0) {
      const anchor = alive[Math.min(
        alive.length - 1,
        Math.floor(this.rng() * alive.length),
      )];
      const near = this.world.findSpawnNear(
        anchor.state.px, anchor.state.pz, this.rng,
      );
      if (near) return near;
    }
    return this.world.findSpawn(this.rng);
  }

  /** A safe, supported, uncrowded standing point near a reinforcement anchor. */
  private placeAt(player: ServerPlayer, anchor: { x: number; y: number; z: number }, actors: readonly ServerPlayer[]): { x: number; y: number; z: number } | null {
    const policy = this.frontier!.reinforcementPlanner;
    for (let attempt = 0; attempt < 24; attempt++) {
      const angle = this.rng() * Math.PI * 2, radius = 3 + this.rng() * 14;
      const x = anchor.x + Math.cos(angle) * radius, z = anchor.z + Math.sin(angle) * radius;
      // Preserve the rally's pedestrian floor below towers and bridges.
      const y = anchor.y;
      if (!policy.supported({ x, y, z }) ||
        !policy.safe(player, { x, y, z }, actors, this.tick)) continue;
      if (actors.some(q => q.id !== player.id && q.state.alive && Math.abs(q.state.py - y) < 3 && Math.hypot(q.state.px - x, q.state.pz - z) < 2)) continue;
      return { x, y, z };
    }
    if (policy.safe(player, anchor, actors, this.tick) && policy.supported(anchor))
      return { x: anchor.x, y: anchor.y, z: anchor.z };
    return null;
  }

  /** Runway sites, and whether a fighter jet is parked on each, free to board. */
  private airfieldReports(): { x: number; z: number; ready: boolean }[] {
    const out: { x: number; z: number; ready: boolean }[] = [];
    for (const site of this.vehicleSites) {
      if (site.type !== VEHICLE.JET) continue;
      let ready = false;
      for (const v of this.vehicles.values()) {
        if (v.type === VEHICLE.JET && !v.deployed && v.respawnAtTick < 0 && v.occupant < 0 &&
          Math.hypot(v.x - site.x, v.z - site.z) < 80) { ready = true; break; }
      }
      out.push({ x: Math.round(site.x), z: Math.round(site.z), ready });
    }
    return out;
  }

  /** Out of combat, a soldier can move straight to any available reinforcement
   * point (or launch in a fighter) instead of walking there. Returns a reason
   * when refused. Combat, airlift and the short cooldown still apply. It does
   * not become the remembered respawn choice (only a pick on the map does):
   * otherwise one deployment would pin every later one, and every respawn,
   * to that point after the fight had moved on. */
  deployNow(player: ServerPlayer, id: string): string | null {
    if (!this.frontier || id.length > 80) return 'Deployment is not available on this server.';
    const s = player.state;
    if (!s.alive) return null; // the respawn selection already handles the dead
    if (player.airlift || s.airlift || s.transportRoute) return 'Finish your current trip before redeploying.';
    if (this.tick < player.regenBlockUntil - (PLAYER.REGEN_DELAY - DEPLOY_COMBAT_GRACE_SECONDS) * TICK_RATE)
      return `You are in combat. Redeploy is ready ${DEPLOY_COMBAT_GRACE_SECONDS} s after your last hit.`;
    if (this.tick < player.deployReadyAt) return `Redeploy ready in ${Math.ceil((player.deployReadyAt - this.tick) / TICK_RATE)} s.`;
    const option = this.frontier.spawnOptions(player, this.tick).find(o => o.id === id);
    if (!option) return 'That deployment is no longer available. Pick another on the map.';
    const actors = [...this.players.values()];
    const point = option.kind === 'air' ? { x: option.x, y: option.y, z: option.z } : this.placeAt(player, option, actors);
    if (!point) return 'That rally is crowded right now. Try again in a moment.';
    if (s.vehicle !== VEHICLE.NONE) this.releaseVehicleSeat(player);
    const from = { x: s.px, y: s.py, z: s.pz };
    s.px = point.x; s.py = point.y; s.pz = point.z; s.vx = s.vy = s.vz = 0; s.grounded = false;
    player.deployReadyAt = this.tick + DEPLOY_COOLDOWN_SECONDS * TICK_RATE;
    player.spawnProtectedUntil = this.tick + 3 * TICK_RATE; player.recallSince = -1;
    if (option.kind === 'air') this.launchJet(player, option.heading ?? 0);
    this.events.push({ bytes: encodeTeleport({ id: player.id, fromX: from.x, fromY: from.y, fromZ: from.z, toX: s.px, toY: s.py, toZ: s.pz }) });
    return null;
  }

  private allocateEntity(cursor: 'nextVehicleId' | 'nextPlayerId' | 'nextProjectileId' | 'nextPickupId', active: { has(id: number): boolean; size: number }): number {
    if (this.entityAllocator) return this.entityAllocator.allocate(active);
    const allocation = allocateEntityId(this[cursor], active, this.idRange);
    this[cursor] = allocation.next;
    return allocation.id;
  }

  /** Reserve one intact faction squad for an arriving expedition without
   * colliding with the ordinals allocated to future local reinforcements. */
  reserveBotRoster(faction: Faction, count: number): number[] {
    if (!faction || !Number.isInteger(count) || count < 1 || count > 6) throw new Error('Invalid arriving squad');
    let start = Math.ceil(this.nextBotRosterIndex / 18) * 18;
    // Orbital infantry must not turn into runway/naval specialists simply
    // because the next local ordinal happens to start a flight-crew block.
    if (Math.floor(start / 3) % 24 === 0) start += 18;
    this.nextBotRosterIndex = start + 18;
    return Array.from({ length: count }, (_, i) => start + faction - 1 + i * 3);
  }

  addPlayer(name: string, sink: PlayerSink | null, isBot = false, entityId?: number): ServerPlayer {
    if (entityId !== undefined && (!isEntityId(entityId) || this.players.has(entityId))) throw new Error('Invalid or occupied player ID');
    const id = entityId ?? this.allocateEntity('nextPlayerId', this.players);
    const initial = this.frontier?.bases[0] ?? this.pickSpawn(-1) ?? this.world.findSpawn(this.rng);
    const p = new ServerPlayer(id, name, sink, isBot, initial);
    if (this.frontier && isBot) p.botRosterIndex = this.nextBotRosterIndex++;
    if (this.frontier) { p.faction = (isBot ? p.botRosterIndex! % 3 + 1 : Math.floor(this.rng() * 3) + 1) as Faction; p.weapon = 1; }
    // An unplaced bot belongs to its squad but has no battlefield position.
    // Do not let the temporary first-base coordinates bias its initial order.
    if (this.frontier && isBot) p.state.alive = false;
    this.players.set(id, p);
    this.botSimulation.invalidateRoster();
    const spawn = this.frontier ? this.pickSpawn(id) : initial;
    if (spawn) {
      Object.assign(p.state, { px: spawn.x, py: spawn.y, pz: spawn.z });
      if (this.frontier && isBot) p.state.alive = true;
    }
    else { p.state.alive = false; p.health = 0; p.respawnAtTick = this.tick + TICK_RATE; }
    if (spawn && this.frontier && isBot) this.stageVehicleCrew(p);
    if (this.frontier) p.spawnProtectedUntil = this.tick + 3 * TICK_RATE;
    this.events.push({ bytes: encodeJoin(id, name, isBot) });
    this.events.push({ bytes: encodeSpawn(id, p.state.px, p.state.py, p.state.pz) });
    return p;
  }

  /** Bring a fresh connection up to date: everyone's names + scores. */
  reattachPlayer(player: ServerPlayer): void {
    if (this.players.has(player.id)) throw new Error('Player is already attached');
    player.inputQueue.length = 0; player.lastCmd = null;
    player.state.vx = player.state.vy = player.state.vz = 0;
    this.players.set(player.id, player);
    this.botSimulation.invalidateRoster();
    this.events.push({ bytes: encodeJoin(player.id, player.name, player.isBot) });
    this.events.push({ bytes: encodeSpawn(player.id, player.state.px, player.state.py, player.state.pz) });
  }

  /** Freeze a complete crew atomically. This is a simulation primitive;
   * the coordinator must commit ownership before a different node imports it. */
  takeHandoff(ids: readonly number[]): DetachedHandoff {
    const detached = captureActors(this, ids), selected = detached.players;
    for (const frame of this.history) {
      if (!frame || frame.tick <= this.tick - NET.LAG_HISTORY_TICKS) continue;
      const players = [...frame.byId].filter(([id]) => selected.has(id)).map(([id, pose]) => ({ id, ...pose }));
      if (players.length) detached.record.history.push({ tick: frame.tick, players });
    }
    validateHandoff(detached.record);
    for (const id of selected.keys()) {
      this.players.delete(id);
      this.events.push({ bytes: encodeLeave(id) });
      for (const frame of this.history) frame?.byId.delete(id);
    }
    this.botSimulation.invalidateRoster();
    for (const v of detached.record.vehicles) this.vehicles.delete(v.id);
    for (const p of detached.record.projectiles) this.projectiles.delete(p.id);
    return detached;
  }

  acceptHandoff(record: RuntimeHandoff, sinks: ReadonlyMap<number, PlayerSink | null>): ServerPlayer[] {
    return this.installHandoff(record, sinks);
  }

  restoreHandoff(detached: DetachedHandoff): ServerPlayer[] {
    return this.installHandoff(detached.record, new Map([...detached.players].map(([id, p]) => [id, p.sink])), detached.players);
  }

  private installHandoff(record: RuntimeHandoff, sinks: ReadonlyMap<number, PlayerSink | null>, originals?: ReadonlyMap<number, ServerPlayer>): ServerPlayer[] {
    const arrival = prepareArrival(this, record, sinks, originals);
    for (const p of arrival.players) {
      this.players.set(p.id, p);
      this.events.push({ bytes: encodeJoin(p.id, p.name, p.isBot) });
    }
    this.botSimulation.invalidateRoster();
    for (const v of arrival.record.vehicles) this.vehicles.set(v.id, v);
    for (const p of arrival.projectiles) this.projectiles.set(p.id, p);
    for (const frame of arrival.record.history) {
      if (frame.tick <= this.tick - NET.LAG_HISTORY_TICKS) continue;
      const index = frame.tick % NET.LAG_HISTORY_TICKS;
      let local = this.history[index];
      if (!local || local.tick < frame.tick) this.history[index] = local = { tick: frame.tick, byId: new Map() };
      if (local.tick !== frame.tick) continue;
      for (const { id, ...pose } of frame.players) local.byId.set(id, pose);
    }
    return arrival.players;
  }

  sendRoster(p: ServerPlayer): void {
    if (!p.sink) return;
    for (const q of this.players.values()) {
      if (q.id !== p.id) p.sink.send(encodeJoin(q.id, q.name, q.isBot));
    }
    p.sink.send(this.buildScores());
    const allegiance = !this.frontier ? '' : p.faction
      ? ` ${FACTIONS[p.faction].name}. Capture control points to secure bases. G: atlas and allegiance.`
      : '';
    p.sink.send(encodeServerMessage(`Welcome to THE MMOFPS.${allegiance}`));
  }

  removePlayer(id: number): void {
    this.camps.forget(id);
    const leaving = this.players.get(id);
    if (leaving?.vehicleId !== undefined && leaving.vehicleId >= 0) this.exitVehicle(leaving);
    if (this.players.delete(id)) {
      this.botSimulation.invalidateRoster();
      // Do not leave ownerless explosives that would later attribute damage
      // to their victims as suicides.
      for (const [projectileId, projectile] of this.projectiles) {
        if (projectile.owner === id) this.projectiles.delete(projectileId);
      }
      this.events.push({ bytes: encodeLeave(id) });
    }
  }

  queueInput(p: ServerPlayer, cmd: InputCmd): void {
    if (p.hasQueuedSeq && !seqNewer(cmd.seq, p.lastQueuedSeq)) return;
    // H is a human playtest shortcut, disabled unless this game allows it;
    // bots keep normal movement and damage either way.
    if (p.isBot || !this.hyperspeed) cmd = { ...cmd, buttons: cmd.buttons & ~BTN.HYPER };
    p.lastInputAtTick = this.tick;
    p.lastQueuedSeq = cmd.seq >>> 0;
    p.hasQueuedSeq = true;
    if (p.inputQueue.length >= 6) p.inputQueue.shift();
    p.inputQueue.push(cmd);
  }

  // ---- Tick --------------------------------------------------------------

  private vehicleCollider(v: ServerVehicle): VehicleColliderPose {
    const driver = this.players.get(v.occupant);
    const motion = driver?.state.vehicle ? driver.state : v.motionState;
    return { id: v.id, type: v.type, variant: v.variant, x: v.x, y: v.y, z: v.z,
      heading: v.heading, health: v.health, respawnAtTick: v.respawnAtTick, transportRoute: v.transportRoute,
      pitch: motion?.vehiclePitch, roll: motion?.vehicleRoll, rotation: motion?.vehicleRotation,
      vx: motion?.vx ?? 0, vy: motion?.vy ?? 0, vz: motion?.vz ?? 0 };
  }

  step(backlog = 0): void {
    this.tick++;
    this.botSimulation.prepare(this.tick,this.players.values(),this.vehicles.values(),this.players.size);
    this.world.motionTime = this.tick / TICK_RATE;
    this.updateVehicles();
    setVehicleColliders(this.world, this.tick, [...this.vehicles.values()].map(v => this.vehicleCollider(v)));
    for (const p of [...this.players.values()].sort((a, b) => (a.state.seat ?? 0) - (b.state.seat ?? 0))) this.processPlayer(p);
    this.updateEncounters(backlog);
    this.updateTeleporters();
    this.updateCaveRecall();
    this.updateAirlifts();
    this.updateProjectiles();
    this.updatePickups();
    this.updateCaveLoot();
    if (this.wildlifeEnabled && this.tick % 6 === 0) this.wildlife.update(this.tick,
      [...this.players.values()].map(p => ({ id: p.id, isBot: p.isBot,
        x: p.state.px, y: p.state.py, z: p.state.pz, alive: p.state.alive, vehicle: p.state.vehicle,
        vehicleId: p.vehicleId, vehicleVariant: p.state.vehicleVariant })),
      this.encounterField?.regions.flatMap(region => region.loot.filter(spot => spot.cave)) ?? []);
    this.updateRespawnsAndRegen();
    this.recordHistory();
    if (this.frontier && this.tick % 12 === 0) this.frontier.step(this.players.values(), this.tick, 12 / TICK_RATE);
    if (this.frontier instanceof Frontier && this.tick % 60 === 30) this.redeployDistantBots();
    if (this.tick % SNAPSHOT_EVERY === 0) this.broadcast();
    if (this.tick % 60 === 0) { this.camps.step(); this.broadcastScores(); }
  }

  shouldThinkBot(p:ServerPlayer):boolean {
    this.botSimulation.prepare(this.tick,this.players.values(),this.vehicles.values(),this.players.size);
    return !this.frontier||this.botSimulation.shouldThink(p);
  }

  remoteGroundPerception(p:ServerPlayer,acquireRange:number):boolean {
    if(!this.frontier||!p.isBot||(p.state.vehicle!==VEHICLE.JEEP&&p.state.vehicle!==VEHICLE.TANK))return false;
    const hull=this.vehicles.get(p.vehicleId);
    if(!hull||hull.respawnAtTick>=0||!(hull.health>0)||hull.type!==p.state.vehicle)return false;
    this.botSimulation.prepare(this.tick,this.players.values(),this.vehicles.values(),this.players.size);
    return this.botSimulation.remoteGroundPerception(this.world,p,acquireRange);
  }

  private processPlayer(p: ServerPlayer): void {
    let applied = 0;
    if (!p.isBot) p.weaponTicks = Math.min(p.weaponTicks + 1, HUMAN_WEAPON_CREDIT_TICKS);
    // All commands in a packet burst share one physical tick. Give each a
    // real interval: repeating the same transport timestamp loses jump
    // velocity and advances an airborne passenger against a frozen ship.
    const count = Math.min(3, p.inputQueue.length);
    while (applied < count) {
      const cmd = p.inputQueue.shift()!;
      p.lastProcessedSeq = cmd.seq;
      p.lastCmd = cmd;
      const dt = TICK_DT / count;
      this.applyCmd(p, cmd, dt, this.tick - 1 + (applied + 1) / count, p.isBot ? dt : this.humanWeaponDt(p));
      applied++;
    }
    // Brief jitter repeats input; a disconnected or hidden tab stops moving/firing.
    // Bots deliberately reuse their last thought. A human's repeat only moves:
    // the late command itself fires, on the command the client predicted.
    if (applied === 0 && p.lastCmd) this.applyCmd(p, this.frontier && this.tick - p.lastInputAtTick > 15 ? { ...p.lastCmd, buttons: 0 } : p.lastCmd,
      TICK_DT, this.tick, p.isBot ? TICK_DT : null);
  }

  /** One tick of handheld weapon time for a human command, or none (edges
   * such as a weapon switch or reload press still apply) once the command
   * stream has run too far ahead of the server clock. */
  private humanWeaponDt(p: ServerPlayer): number {
    if (p.weaponTicks <= -HUMAN_WEAPON_LEAD_TICKS) return 0;
    p.weaponTicks--;
    return TICK_DT;
  }

  /** `weaponDt` advances the handheld weapon; null leaves it untouched. */
  private applyCmd(p: ServerPlayer, cmd: InputCmd, dt = TICK_DT, movementTick = this.tick, weaponDt: number | null = dt): void {
    if (cmd.buttons & (BTN.FIRE | BTN.ALTFIRE)) p.spawnProtectedUntil = -1;
    if (p.state.airlift) {
      this.botSimulation.resetMovement(p);
      stepMove(this.world,p.state,cmd,dt,movementTick);
      p.useHeld=(cmd.buttons & BTN.USE)!==0;
      return;
    }
    // Enter/exit is edge-triggered so one held key cannot bounce the player
    // in and out across consecutive commands.
    const usePressed = (cmd.buttons & BTN.USE) !== 0 && !p.useHeld;
    p.useHeld = (cmd.buttons & BTN.USE) !== 0;
    if (usePressed && p.state.alive) {
      this.botSimulation.resetMovement(p);
      this.toggleVehicle(p);
    }

    const drivingBefore = p.state.vehicle !== VEHICLE.NONE && p.state.seat !== 1;
    const remoteGround = !!this.frontier && this.botSimulation.move(this.world,p,cmd,dt,movementTick);
    const movementDt = p.state.seat === 1 || remoteGround ? 0 : this.frontier
      ? this.botSimulation.physicsDt(this.world,p,cmd,dt,movementTick) : dt;
    // Deferred movement must not defer breathing or apply its elapsed time
    // twice. Resolve this authority tick's air timer from the current pose;
    // the shared movement controller still handles swimming and collision.
    let breath: {air:number;submerged:boolean}|undefined;
    if(p.state.alive&&movementDt!==dt&&!remoteGround&&p.state.seat!==1){
      const eye=vehicleEyeOffset(p.state);
      breath={air:p.state.airSeconds??SWIMMING.AIR_SECONDS,
        submerged:!!this.world.liquidAt(p.state.px+eye.x,p.state.py+eye.y,p.state.pz+eye.z)};
    }
    const batchedGround=p.isBot&&movementDt>dt+.000001&&(p.state.vehicle===VEHICLE.JEEP||p.state.vehicle===VEHICLE.TANK);
    const groundFrom=batchedGround?{x:p.state.px,y:p.state.py,z:p.state.pz}:undefined;
    const res = movementDt === 0 ? { impact: 0, transitImpact: 0 }
      : batchedGround
        ? stepBotGroundVehicle(this.world,p.state,cmd,movementDt,movementTick)
        : stepMove(this.world, p.state, cmd, movementDt, movementTick);
    if(breath){
      p.state.submerged=breath.submerged;
      p.state.airSeconds=clamp(breath.air+dt*(breath.submerged?-1:5),0,SWIMMING.AIR_SECONDS);
    }
    if (p.state.seat === 1) {
      const hull = this.vehicles.get(p.vehicleId), driver = this.players.get(hull?.occupant ?? -1);
      if (driver) this.copyCrewPose(p, driver);
      const eye = vehicleEyeOffset(p.state);
      const submerged = !!this.world.liquidAt(p.state.px + eye.x, p.state.py + eye.y, p.state.pz + eye.z);
      p.state.submerged = submerged;
      p.state.airSeconds = clamp((p.state.airSeconds ?? 18) + dt * (submerged ? -1 : 5), 0, 18);
      p.state.swimming = false;
      if (p.state.vehicle === VEHICLE.JET) cmd = { ...cmd, ...aircraftCrewAim(p.state, cmd.yaw, cmd.pitch) };
      p.lastCmd = cmd;
    }

    if (drivingBefore && p.state.alive) {
      // Crashes damage the hull, never the cushioned occupant.
      const v = this.vehicles.get(p.vehicleId);
      if (v) {
        v.x = p.state.px; v.y = p.state.py; v.z = p.state.pz;
        v.heading = p.state.heading;
        updateVehicleCollider(this.world, movementTick, this.vehicleCollider(v));
        if (res.impact > VEHICLE_CRASH_MIN_IMPACT) {
          // The jeep is the crash-happiest hull, so its wall hits count
          // half - boost slaloms should be survivable, not one-strike.
          const crashScale = p.state.vehicle === VEHICLE.JEEP ? 0.5 : 1;
          this.damageVehicle(
            v,
            (res.impact - VEHICLE_CRASH_MIN_IMPACT) *
              VEHICLE_CRASH_DAMAGE_SCALE * crashScale,
            p, 255,
          );
        }
      }
      this.sweepRunOver(p,groundFrom);
    } else if (res.impact > 0 && p.state.alive) {
      const dmg = fallDamage(res.impact);
      if (dmg > 0) {
        const credit = this.fallDamageCredit(p);
        this.damage(
          p, dmg,
          credit?.attacker ?? p,
          credit?.weapon ?? 255,
          0, 0, 0,
        );
      }
    }

    if (p.state.alive && res.transitImpact > 0 && p.state.vehicle === VEHICLE.NONE && this.tick >= p.transitDamageUntil) {
      const damage = transitImpactDamage(res.transitImpact);
      if (damage > 0) {
        this.damage(p, damage, p, 255, 0, 0, 0);
        // A single rebound can brush several bogies before clearing the
        // track. Treat that brief contact chain as one runover injury.
        p.transitDamageUntil = this.tick + Math.ceil(.75 * TICK_RATE);
      }
    }

    if (p.state.alive && p.state.py < WORLD.KILL_Y) {
      if (p.state.vehicle !== VEHICLE.NONE) {
        const v = this.vehicles.get(p.vehicleId);
        if (v) this.destroyVehicle(v, p, 255);
        else this.kill(p, p, 255);
      } else {
        this.kill(p, p, 255);
      }
    }

    // Both liquids and traps use canonical shared volumes/clock positions.
    if (p.state.alive && (!remoteGround || p.state.swimming || p.state.submerged)) {
      const col = this.world.sampleColumn(p.state.px, p.state.pz);
      const fluid = this.world.liquidAt(p.state.px, p.state.py + .25, p.state.pz);
      if (fluid?.kind === 'lava') {
        if (p.state.vehicle !== VEHICLE.NONE) {
          const v = this.vehicles.get(p.vehicleId);
          if (v && p.state.seat !== 1) this.damageVehicle(v, SWIMMING.LAVA_DPS * 2 * dt, p, 255);
        } else {
          this.damage(p, SWIMMING.LAVA_DPS * dt, p, 255, 0, 0, 0);
        }
      }
      if (p.state.submerged && (p.state.airSeconds ?? SWIMMING.AIR_SECONDS) <= 0)
        this.damage(p, SWIMMING.DROWN_DPS * dt, p, 255, 0, 0, 0);
      if (col.templeSite && this.tick >= p.trapCooldownUntil) for (const trap of buildJungleTemplePlan(col.templeSite).traps) {
        if (!templeTrapTouches(trap, this.tick / TICK_RATE, p.state.px, p.state.py, p.state.pz)) continue;
        this.damage(p, trap.damage, p, 255, 0, 0, 0);
        p.trapCooldownUntil = this.tick + Math.ceil(.65 * TICK_RATE); break;
      }
    }

    // Resolve fall damage before clearing the source at the landing that
    // consumed it. Ceiling and wall contacts leave grounded=false and retain
    // the bounded credit window.
    if (p.state.alive && p.state.grounded) this.clearFallDamageCredit(p);

    p.vehFireCd = Math.max(0, p.vehFireCd - dt);
    p.vehAltCd = Math.max(0, p.vehAltCd - dt);

    if (p.state.alive) {
      if (p.state.vehicle !== VEHICLE.NONE) {
        this.fireVehicleWeapons(p, cmd);
        p.lockTargetId = -1; p.lockVehicleId = -1; p.lockTicks = 0; p.lockState = LOCK_NONE;
      } else {
        this.updateHomingLock(p, cmd);
        const weaponStep = weaponDt === null ? null : stepWeaponState(p, cmd.weapon, cmd.buttons, weaponDt);
        if (weaponStep && weaponStep.firedWeapon >= 0) {
          this.fire(p, cmd, weaponStep.firedWeapon);
        }
      }
    }
  }

  private fireVehicleWeapons(p: ServerPlayer, cmd: InputCmd): void {
    const type = p.state.vehicle;
    if (p.state.seat === 2) {
      const def = weaponDefById(213)!;
      if ((cmd.buttons & (BTN.FIRE | BTN.ALTFIRE)) && p.vehFireCd <= 0) {
        p.vehFireCd = def.interval; this.stats.shotsFired++;
        const aimed = { ...cmd, pitch: artilleryPitch(cmd.pitch) };
        this.fireProjectile(p, aimed, def, true, trainArtilleryMuzzle(p.state.heading, aimed.yaw, aimed.pitch));
      }
      return;
    }
    if (p.state.seat === 1) {
      const def = weaponDefById(type === VEHICLE.JET ? 215 : 214)!;
      if (!(cmd.buttons & BTN.FIRE) || p.vehFireCd > 0) return;
      p.vehFireCd = def.interval; this.stats.shotsFired++;
      const attachment = type === VEHICLE.JET ? aircraftCrewMuzzle(p.state)
        : crewGunMuzzle(type, p.state.vehicleVariant, p.state.heading, cmd.yaw, cmd.pitch);
      if (def.kind === 'hitscan') this.fireHitscan(p, cmd, def, attachment);
      else this.fireProjectile(p, cmd, def, true, attachment);
      return;
    }
    const armament = vehicleArmament(type, p.state.vehicleVariant);
    if ((cmd.buttons & BTN.FIRE) !== 0 && p.vehFireCd <= 0) {
      p.vehFireCd = armament.primary.interval;
      this.stats.shotsFired++;
      if (type === VEHICLE.JET) {
        const nose = vehicleLocalOffset(p.state, 0, 0, -1);
        this.fireHitscan(p, { ...cmd, yaw: Math.atan2(-nose.x, -nose.z),
          pitch: Math.atan2(nose.y, Math.hypot(nose.x, nose.z)) }, armament.primary);
      } else if (armament.primary.kind === 'hitscan') this.fireHitscan(p, cmd, armament.primary);
      else this.fireProjectile(p, cmd, armament.primary);
    }
    if ((cmd.buttons & BTN.ALTFIRE) !== 0 && p.vehAltCd <= 0 && armament.alt) {
      p.vehAltCd = armament.alt.interval;
      this.stats.shotsFired++;
      if (type === VEHICLE.JET) this.dropCarpetBombs(p, armament.alt);
      else this.fireProjectile(p, cmd, armament.alt);
    }
  }

  /** A stick of bombs released along the flight path - classic carpet run. */
  private dropCarpetBombs(p: ServerPlayer, def: WeaponDef = JET_BOMB): void {
    const s = p.state;
    const bay = jetBombBay(s.vehicleVariant);
    const release = vehicleLocalOffset(s, bay.x, bay.y, bay.z);
    const trail = vehicleLocalOffset(s, 0, 0, 4);
    const eject = vehicleLocalOffset(s, 0, -4, 0);
    for (let i = 0; i < (def.id === JET_BOMB.id ? CARPET_BOMB_COUNT : 1); i++) {
      const id = this.allocateEntity('nextProjectileId', this.projectiles);
      this.projectiles.set(id, {
        id, owner: p.id, weapon: def.id,
        x: s.px + release.x + trail.x * i,
        y: s.py + release.y + trail.y * i,
        z: s.pz + release.z + trail.z * i,
        vx: s.vx * 0.85 + eject.x, vy: Math.min(0, s.vy) + eject.y, vz: s.vz * 0.85 + eject.z,
        distLeft: def.range,
        fuseLeft: def.fuse ?? 12,
        ageSeconds: 0,
        sleeping: false,
      });
    }
    this.events.push({
      bytes: encodeFire({
        shooter: p.id, weapon: def.id, seq: 0,
        ox: s.px + release.x, oy: s.py + release.y, oz: s.pz + release.z, ends: [],
      }),
      x: s.px, z: s.pz, radius: NET.FIRE_EVENT_RADIUS,
    });
  }

  /**
   * Rocket lock-on: only occupied hulls can be locked, only while the
   * launcher is the held weapon, and only after LOCK_TICKS of continuous
   * near-center aim with line of sight. Breaking any condition resets.
   */
  private updateHomingLock(p: ServerPlayer, cmd: InputCmd): void {
    if (p.weapon !== 3) {
      this.homingObstructions.delete(p);
      p.lockTargetId = -1; p.lockVehicleId = -1; p.lockTicks = 0; p.lockState = LOCK_NONE;
      return;
    }
    const ex = p.state.px, ey = p.state.py + PLAYER.EYE_HEIGHT, ez = p.state.pz;
    const aim = viewDir(cmd.yaw, cmd.pitch);
    let best: ServerPlayer | null = null;
    const candidates: { player: ServerPlayer; cos: number; tx: number; ty: number; tz: number;
      dist: number; radius: number; order: number }[] = [];
    for (const q of this.players.values()) {
      if (!this.areEnemies(p, q) || !q.state.alive || q.state.vehicle === VEHICLE.NONE || q.state.seat === 1) continue;
      if (p.vehicleId >= 0 && q.vehicleId === p.vehicleId) continue;
      const hull = this.vehicles.get(q.vehicleId);
      if (!hull || hull.occupant !== q.id || hull.health <= 0 || hull.respawnAtTick >= 0) continue;
      const def = vehicleDefinition(q.state.vehicle, q.state.vehicleVariant);
      const tx = q.state.px - ex;
      const ty = q.state.py + (def?.radius ?? 1) - ey;
      const tz = q.state.pz - ez;
      // Reject distant/off-axis hulls before a square root. Keep a small
      // boundary margin so the original normalized comparison decides ties.
      const distance2 = tx * tx + ty * ty + tz * tz;
      if (distance2 > (LOCK_RANGE + 1e-7) ** 2 || distance2 < (6 - 1e-7) ** 2) continue;
      const along = tx * aim.x + ty * aim.y + tz * aim.z;
      if (along < 0 || along * along < (LOCK_CONE_COS * LOCK_CONE_COS - 1e-12) * distance2) continue;
      const dist = Math.hypot(tx, ty, tz);
      if (dist < 6 || dist > LOCK_RANGE) continue;
      const cos = along / dist;
      if (cos < LOCK_CONE_COS) continue;
      candidates.push({ player: q, cos, tx, ty, tz, dist, radius: def?.radius ?? 1, order: candidates.length });
    }
    // The previous scan ultimately chose the visible hull nearest the aim
    // center, with later Map entries winning equal angles. Test that winner
    // first so weaker candidates never spend a terrain trace unnecessarily.
    candidates.sort((a, b) => b.cos - a.cos || b.order - a.order);
    let obstructions = this.homingObstructions.get(p);
    if (!candidates.length) this.homingObstructions.delete(p);
    for (const candidate of candidates) {
      const { tx, ty, tz, dist, radius } = candidate;
      const dx = tx / dist, dy = ty / dist, dz = tz / dist, hullId = candidate.player.vehicleId;
      const limit = dist - radius - .5, witness = obstructions?.get(hullId);
      if (witness && this.tick >= witness.tick && this.tick - witness.tick <= 120) {
        const along = dist * witness.fraction;
        // This is a new geometric proof on the CURRENT ray, not cached LOS.
        // Moving cover, either actor moving, or a closer hull can invalidate
        // it; in those cases the full authoritative trace still runs below.
        if (along >= 0 && along < limit && this.world.sdf(ex + dx * along, ey + dy * along, ez + dz * along) <= 0) {
          witness.tick = this.tick; continue;
        }
      }
      const th = this.world.trace(ex, ey, ez, dx, dy, dz, dist, false);
      if (th.hit && th.dist < limit) {
        // Prefer a verified interior point to a fragile surface endpoint.
        // Thin obstacles retain the trace's known-solid endpoint instead.
        const inside = Math.min(th.dist + .5, (th.dist + limit) * .5);
        const fraction = inside > th.dist && this.world.sdf(ex + dx * inside, ey + dy * inside, ez + dz * inside) <= 0
          ? inside / dist : th.dist / dist;
        if (!obstructions) { obstructions = new Map(); this.homingObstructions.set(p, obstructions); }
        if (!obstructions.has(hullId) && obstructions.size >= 8) obstructions.delete(obstructions.keys().next().value!);
        obstructions.set(hullId, { fraction, tick: this.tick });
        continue;
      }
      obstructions?.delete(hullId);
      best = candidate.player; break;
    }
    if (best && best.vehicleId === p.lockVehicleId) {
      p.lockTicks = Math.min(p.lockTicks + 1, LOCK_TICKS + 30);
      p.lockTargetId = best.id; p.lockVehicleId = best.vehicleId;
    } else if (best) {
      p.lockTargetId = best.id;
      p.lockVehicleId = best.vehicleId;
      p.lockTicks = 1;
    } else if (p.lockTargetId >= 0 && p.lockTicks > 0) {
      // Brief lock persistence: an achieved lock survives a short flick
      // (leading a fast hull, snap-firing) but decays quickly, so evasive
      // flying still shakes pursuers off before a second shot.
      p.lockTicks -= 3;
      if (p.lockTicks <= 0) {
        p.lockTargetId = -1;
        p.lockVehicleId = -1;
        p.lockTicks = 0;
      }
    } else {
      p.lockTargetId = -1;
      p.lockVehicleId = -1;
      p.lockTicks = 0;
    }
    p.lockState = p.lockTargetId < 0
      ? LOCK_NONE
      : p.lockTicks >= LOCK_TICKS ? LOCK_LOCKED : LOCK_ACQUIRING;
  }

  // ---- Combat ------------------------------------------------------------

  private fire(p: ServerPlayer, cmd: InputCmd, weapon: number): void {
    const def = WEAPONS[weapon];
    p.spawnProtectedUntil = -1;
    this.stats.shotsFired++;
    if (weapon === NUKE_LAUNCHER_ID) this.fireNukeDesignator(p, cmd, def);
    else if (def.kind === 'hitscan') this.fireHitscan(p, cmd, def);
    else this.fireProjectile(p, cmd, def);
  }

  /**
   * The nuke launcher paints a target: an instant trace places a NUKE_MARKER
   * beacon at the impact point, replicated to everyone. When the marker's
   * fuse expires, dropNuke() spawns the falling bomb above it.
   */
  private fireNukeDesignator(p: ServerPlayer, cmd: InputCmd, def: WeaponDef): void {
    const dir = pelletDir(this.seed, p.id, cmd.seq, 0, cmd.yaw, cmd.pitch, 0);
    const ex = p.state.px, ey = p.state.py + PLAYER.EYE_HEIGHT, ez = p.state.pz;
    const th = this.world.trace(ex, ey, ez, dir.x, dir.y, dir.z, def.range);
    const tx = th.hit ? th.x : ex + dir.x * def.range;
    const ty = th.hit ? th.y : ey + dir.y * def.range;
    const tz = th.hit ? th.z : ez + dir.z * def.range;
    const id = this.allocateEntity('nextProjectileId', this.projectiles);
    this.projectiles.set(id, {
      id, owner: p.id, weapon: NUKE_MARKER.id,
      x: tx, y: ty + 0.4, z: tz,
      vx: 0, vy: 0, vz: 0,
      distLeft: NUKE_MARKER.range,
      fuseLeft: NUKE_MARKER.fuse ?? 10,
      ageSeconds: 0,
      sleeping: false,
    });
    this.events.push({
      bytes: encodeFire({
        shooter: p.id, weapon: def.id, seq: cmd.seq,
        ox: ex, oy: ey, oz: ez,
        ends: [{ x: tx, y: ty, z: tz, hitKind: th.hit ? 0 : 2 }],
      }),
      x: ex, z: ez, radius: NET.FIRE_EVENT_RADIUS,
    });
  }

  /** Marker fuse expired: the bomb falls out of the sky. */
  private dropNuke(marker: Projectile): void {
    // The bomb ALWAYS falls from the open sky. A marker painted underground
    // (or beneath an overhang) is struck at ground level directly above it:
    // the surface takes the impact and the blast reaches down through the
    // radial falloff - the cave shakes rather than the bomb fizzling on a
    // cave ceiling centimeters above the marker.
    const surfaceY = this.world.groundY(marker.x, marker.z);
    const dropY = Math.min(
      WORLD.MAX_HEIGHT + 60,
      Math.max(surfaceY, marker.y) + 240,
    );
    const id = this.allocateEntity('nextProjectileId', this.projectiles);
    this.projectiles.set(id, {
      id, owner: marker.owner, weapon: NUKE_BOMB.id,
      x: marker.x, y: dropY, z: marker.z,
      vx: 0, vy: -55, vz: 0,
      distLeft: NUKE_BOMB.range,
      fuseLeft: NUKE_BOMB.fuse ?? 30,
      ageSeconds: 0,
      sleeping: false,
    });
  }

  /** The lag-compensation target time for this shot, in (fractional) ticks. */
  private rewindTarget(cmd: InputCmd): number {
    let target = cmd.renderTick + cmd.renderFrac;
    if (!(target > 0)) target = this.tick - NET.INTERP_TICKS;
    return clamp(target, this.tick - NET.MAX_REWIND_TICKS, this.tick);
  }

  private rewindPos(id: number, target: number): HistEntry | null {
    const t0 = Math.floor(target);
    const frac = target - t0;
    const f0 = this.history[((t0 % NET.LAG_HISTORY_TICKS) + NET.LAG_HISTORY_TICKS) % NET.LAG_HISTORY_TICKS];
    const f1 = this.history[(((t0 + 1) % NET.LAG_HISTORY_TICKS) + NET.LAG_HISTORY_TICKS) % NET.LAG_HISTORY_TICKS];
    const e0 = f0 && f0.tick === t0 ? f0.byId.get(id) : undefined;
    const e1 = f1 && f1.tick === t0 + 1 ? f1.byId.get(id) : undefined;
    if (e0 && e1) {
      if (!e0.alive || !e1.alive) return null;
      return {
        x: e0.x + (e1.x - e0.x) * frac,
        y: e0.y + (e1.y - e0.y) * frac,
        z: e0.z + (e1.z - e0.z) * frac,
        alive: true,
      };
    }
    // History not populated yet (fresh join) - fall back to current position.
    const q = this.players.get(id);
    if (!q || !q.state.alive) return null;
    return { x: q.state.px, y: q.state.py, z: q.state.pz, alive: true };
  }

  /** Fire-time cosmetic policy; custom bot observers always retain events. */
  private distantMissObserversAllow(x: number, y: number, z: number): boolean {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false;
    for (const q of this.players.values()) {
      if (q.isBot) { if (q.sink) return false; continue; }
      const s = q.state;
      if (q.airlift || s.airlift || !Number.isFinite(s.px) || !Number.isFinite(s.py) || !Number.isFinite(s.pz) ||
        !Number.isFinite(s.vx) || !Number.isFinite(s.vy) || !Number.isFinite(s.vz) ||
        s.vx*s.vx+s.vy*s.vy+s.vz*s.vz > 256*256) return false;
      const dx = x-s.px, dz = z-s.pz, d2 = dx*dx+dz*dz;
      if (!Number.isFinite(d2) || !(d2 > NET.INTEREST_RADIUS*NET.INTEREST_RADIUS)) return false;
    }
    return true;
  }

  /** A miss proof only. Possible hits retain the original trace/selection path. */
  private unobservedShotHasTarget(p: ServerPlayer, target: number,
    x: number, y: number, z: number, dir: { x: number; y: number; z: number }, range: number): boolean {
    for (const q of this.players.values()) {
      if (!this.areEnemies(p, q) || q.state.vehicle !== VEHICLE.NONE) continue;
      const hp = this.rewindPos(q.id, target);
      if (hp && rayCapsule(x, y, z, dir.x, dir.y, dir.z, range,
        hp.x, hp.y + PLAYER.RADIUS, hp.y + PLAYER.HEIGHT - PLAYER.RADIUS, hp.z, PLAYER.RADIUS) >= 0) return true;
    }
    for (const v of this.vehicles.values()) {
      if (v.respawnAtTick >= 0 || v.id === p.vehicleId) continue;
      const radius = vehicleDefinition(v.type, v.variant)!.radius, cy = v.y + radius;
      if (rayCapsule(x, y, z, dir.x, dir.y, dir.z, range,
        v.x, cy, cy, v.z, radius) >= 0) return true;
    }
    return this.wildlife.hitRay(x, y, z, dir.x, dir.y, dir.z, range) !== null;
  }

  private fireHitscan(p: ServerPlayer, cmd: InputCmd, def: WeaponDef, attachment?: {x:number;y:number;z:number}): void {
    const eye = p.state.vehicle !== VEHICLE.NONE
      ? vehicleEyeHeight(p.state.vehicle as VehicleType, p.state.vehicleVariant)
      : PLAYER.EYE_HEIGHT;
    const jetAttachment = jetGunMuzzle(p.state.vehicleVariant);
    const jetMuzzle = attachment ?? (p.state.vehicle === VEHICLE.JET
      ? vehicleLocalOffset(p.state, jetAttachment.x, jetAttachment.y, jetAttachment.z) : p.state.vehicleVariant === VEHICLE_VARIANT.BASTION
        ? bastionGunMuzzle(p.state.heading, cmd.yaw, cmd.pitch) : null);
    const ex = p.state.px + (jetMuzzle?.x ?? 0), ey = p.state.py + (jetMuzzle?.y ?? eye),
      ez = p.state.pz + (jetMuzzle?.z ?? 0);
    const target = this.rewindTarget(cmd);
    // Omit a whole certified-miss cosmetic shot only outside all human
    // interest at fire time. Teleports, respawns and new arrivals afterward
    // may miss that already-fired cosmetic; damage and nearby shots stay live.
    const unobserved = this.world.trace === NATIVE_WEAPON_TRACE && p.isBot && (def.beamRadius ?? 0) === 0 &&
      Number.isFinite(def.range) && def.range >= 0 &&
      Number.isInteger(def.pellets) && def.pellets > 0 &&
      DISTANT_MISS_WEAPONS.includes(def.id) && this.distantMissObserversAllow(ex, ey, ez);
    if (unobserved) {
      let misses = true;
      for (let i = 0; i < def.pellets; i++) {
        const dir = pelletDir(this.seed, p.id, cmd.seq, i, cmd.yaw, cmd.pitch, def.spread);
        if (!Number.isFinite(dir.x + dir.y + dir.z) ||
          this.unobservedShotHasTarget(p, target, ex, ey, ez, dir, def.range)) { misses = false; break; }
      }
      if (misses) return;
    }
    const ends: FireEnd[] = [];
    let totalDmg = 0;
    let killed = false;

    // Inflating a capsule models the broad laser, but its virtual leading edge
    // can extend through cover. Prove visibility to the actual body surface
    // before accepting such a hit; ordinary thin rays need no extra trace.
    const beamVisible = (dir: {x: number; y: number; z: number}, t: number,
      x: number, bottom: number, top: number, z: number, radius: number): boolean => {
      if (!def.beamRadius) return true;
      const dx = x - ex, dy = clamp(ey + dir.y * t, bottom, top) - ey, dz = z - ez;
      const distance = Math.hypot(dx, dy, dz);
      if (distance <= radius) return true;
      return !this.world.trace(ex, ey, ez, dx / distance, dy / distance, dz / distance,
        Math.max(0, distance - radius - .01)).hit;
    };

    for (let i = 0; i < def.pellets; i++) {
      const dir = pelletDir(this.seed, p.id, cmd.seq, i, cmd.yaw, cmd.pitch, def.spread);
      const th = this.world.trace(ex, ey, ez, dir.x, dir.y, dir.z, def.range);
      const maxT = th.hit ? th.dist : def.range;

      let bestT = Infinity;
      let victim: ServerPlayer | null = null;
      let directVictimId = -1;
      for (const q of this.players.values()) {
        // Drivers are protected by their hull, which is swept below.
        if (!this.areEnemies(p, q) || q.state.vehicle !== VEHICLE.NONE) continue;
        const hp = this.rewindPos(q.id, target);
        if (!hp) continue;
        const t = rayCapsule(
          ex, ey, ez, dir.x, dir.y, dir.z, maxT,
          hp.x, hp.y + PLAYER.RADIUS, hp.y + PLAYER.HEIGHT - PLAYER.RADIUS, hp.z,
          PLAYER.RADIUS + (def.beamRadius ?? 0),
        );
        if (t >= 0 && t < bestT && beamVisible(dir, t, hp.x, hp.y + PLAYER.RADIUS,
            hp.y + PLAYER.HEIGHT - PLAYER.RADIUS, hp.z, PLAYER.RADIUS)) {
          bestT = t; victim = q;
        }
      }
      let vehicleVictim: ServerVehicle | null = null;
      for (const v of this.vehicles.values()) {
        if (v.respawnAtTick >= 0 || v.id === p.vehicleId) continue;
        const r = vehicleDefinition(v.type, v.variant)!.radius;
        const cy = v.y + r;
        const t = rayCapsule(
          ex, ey, ez, dir.x, dir.y, dir.z, Math.min(maxT, bestT),
          v.x, cy, cy, v.z, r + (def.beamRadius ?? 0),
        );
        if (t >= 0 && t < bestT && beamVisible(dir, t, v.x, cy, cy, v.z, r)) {
          bestT = t; victim = null; vehicleVictim = v;
        }
      }

      let creatureHit = this.wildlife.hitRay(ex, ey, ez, dir.x, dir.y, dir.z, Math.min(maxT, bestT), def.beamRadius ?? 0);
      if (creatureHit) {
        const body = CREATURE_DEFS[creatureHit.c.species], c = creatureHit.c;
        const radius = Math.min(body.radius, body.height / 2);
        if (!beamVisible(dir, creatureHit.t, c.x, c.y + radius,
            c.y + body.height - radius, c.z, radius)) creatureHit = null;
      }
      if (creatureHit && creatureHit.t < bestT) {
        totalDmg += def.damage;
        killed = this.wildlife.damage(creatureHit.c, def.damage, p.id, this.tick) || killed;
        ends.push({ x: ex + dir.x * creatureHit.t, y: ey + dir.y * creatureHit.t,
          z: ez + dir.z * creatureHit.t, hitKind: 1 });
      } else if (vehicleVictim) {
        totalDmg += def.damage;
        this.damageVehicle(vehicleVictim, def.damage, p, def.id);
        ends.push({ x: ex + dir.x * bestT, y: ey + dir.y * bestT, z: ez + dir.z * bestT, hitKind: 1 });
      } else if (victim) {
        directVictimId = victim.id;
        totalDmg += def.damage;
        const kb = def.knockback;
        const wasAlive = victim.state.alive;
        this.damage(victim, def.damage, p, def.id, dir.x * kb, Math.abs(kb) * 0.35, dir.z * kb);
        if (wasAlive && !victim.state.alive) killed = true;
        ends.push({ x: ex + dir.x * bestT, y: ey + dir.y * bestT, z: ez + dir.z * bestT, hitKind: 1 });
      } else if (th.hit) {
        ends.push({ x: th.x, y: th.y, z: th.z, hitKind: 0 });
        // A railgun terrain miss is not wasted: it plants a charge at the
        // impact point that detonates into a huge shockwave moments later.
        if (def.id === RAILGUN_ID) {
          const cid = this.allocateEntity('nextProjectileId', this.projectiles);
          this.projectiles.set(cid, {
            id: cid, owner: p.id, weapon: RAIL_CHARGE.id,
            x: th.x - dir.x * 0.3, y: th.y - dir.y * 0.3, z: th.z - dir.z * 0.3,
            vx: 0, vy: 0, vz: 0,
            distLeft: RAIL_CHARGE.range,
            fuseLeft: RAIL_CHARGE.fuse ?? 2.6,
            ageSeconds: 0,
            sleeping: false,
          });
        }
      } else {
        ends.push({ x: ex + dir.x * def.range, y: ey + dir.y * def.range, z: ez + dir.z * def.range, hitKind: 2 });
      }
      const end = ends[ends.length - 1];
      if (def.id === NOCTURNE_LANCE.id && end.hitKind !== 2) {
        // Each coherent beam pays one small authoritative blast. Offset back
        // into the proven clear ray so terrain impacts do not hide their own
        // splash inside the wall. Nine pellets bound work and event volume.
        this.explode(end.x - dir.x * .12, end.y - dir.y * .12, end.z - dir.z * .12,
          p, def, directVictimId, 0);
      }
    }

    if (totalDmg > 0 && p.sink) p.sink.send(encodeHit(totalDmg, killed));
    this.events.push({
      bytes: encodeFire({ shooter: p.id, weapon: def.id, seq: cmd.seq, ox: ex, oy: ey, oz: ez, ends }),
      x: ex, z: ez, radius: NET.FIRE_EVENT_RADIUS,
    });
  }

  private fireProjectile(p: ServerPlayer, cmd: InputCmd, def: WeaponDef, report = true, attachment?: {x:number;y:number;z:number}): void {
    const dir = pelletDir(this.seed, p.id, cmd.seq, 0, cmd.yaw, cmd.pitch, 0);
    const eye = p.state.vehicle !== VEHICLE.NONE
      ? vehicleEyeHeight(p.state.vehicle as VehicleType, p.state.vehicleVariant)
      : PLAYER.EYE_HEIGHT;
    const muzzle = p.state.vehicle !== VEHICLE.NONE ? 2.6 : 0.5;
    const siegeMuzzle = attachment ?? (p.state.vehicle === VEHICLE.GUNBOAT
      ? gunboatGunMuzzle(p.state.heading,cmd.yaw,cmd.pitch)
      : p.state.vehicle === VEHICLE.TANK && p.state.vehicleVariant === VEHICLE_VARIANT.BASTION
        ? bastionGunMuzzle(p.state.heading, cmd.yaw, cmd.pitch) : undefined);
    const ex = p.state.px + (siegeMuzzle?.x ?? 0), ey = p.state.py + (siegeMuzzle?.y ?? eye),
      ez = p.state.pz + (siegeMuzzle?.z ?? 0);
    const launchOffset = siegeMuzzle ? 0 : muzzle;
    const id = this.allocateEntity('nextProjectileId', this.projectiles);
    let speed = def.speed ?? 48;
    // A fully locked rocket flies hot and steers; see advanceProjectile.
    const homing = def.id === 3 && p.lockState === LOCK_LOCKED && p.lockTargetId >= 0;
    if (homing) speed *= HOMING_SPEED_FACTOR;
    const lockedType = this.vehicles.get(p.lockVehicleId)?.type ?? this.players.get(p.lockTargetId)?.state.vehicle ?? VEHICLE.NONE;
    this.projectiles.set(id, {
      id, owner: p.id, weapon: def.id,
      x: ex + dir.x * launchOffset, y: ey + dir.y * launchOffset, z: ez + dir.z * launchOffset,
      vx: dir.x * speed, vy: dir.y * speed, vz: dir.z * speed,
      distLeft: def.range * (homing ? HOMING_RANGE_FACTOR : 1),
      fuseLeft: def.fuse ?? Infinity,
      ageSeconds: 0,
      sleeping: false,
      homingTarget: homing ? p.lockTargetId : -1,
      homingVehicleId: homing ? p.lockVehicleId : -1,
      hullDamageScale: homing ? lockedHullDamageFactor(lockedType) : 1,
    });
    if (report) this.events.push({
      bytes: encodeFire({ shooter: p.id, weapon: def.id, seq: cmd.seq, ox: ex, oy: ey, oz: ez, ends: [] }),
      x: ex, z: ez, radius: NET.FIRE_EVENT_RADIUS,
    });
  }

  /** Gentle pure-pursuit steering; wide evasion breaks the lock for good. */
  private steerHomingProjectile(r: Projectile, dt: number): void {
    if (r.homingTarget === undefined || r.homingTarget < 0) return;
    const hull = r.homingVehicleId !== undefined && r.homingVehicleId >= 0 ? this.vehicles.get(r.homingVehicleId) : undefined;
    const t = this.players.get(hull ? hull.occupant : r.homingTarget);
    const occupiedTarget = r.homingVehicleId === undefined || r.homingVehicleId < 0 ||
      (!!hull && hull.health > 0 && hull.respawnAtTick < 0 && t?.vehicleId === hull.id &&
       this.players.get(r.owner)?.vehicleId !== hull.id);
    if (!occupiedTarget || !t || !t.state.alive || t.state.vehicle === VEHICLE.NONE) {
      r.homingTarget = -1; r.homingVehicleId = -1;
      return;
    }
    r.homingTarget = t.id;
    const def = vehicleDefinition(t.state.vehicle, t.state.vehicleVariant);
    const speed = Math.hypot(r.vx, r.vy, r.vz);
    if (speed < 1e-3) return;
    const tx = t.state.px - r.x;
    const ty = t.state.py + (def?.radius ?? 1) - r.y;
    const tz = t.state.pz - r.z;
    const dist = Math.hypot(tx, ty, tz);
    if (dist < 1e-3) return;
    const dx = tx / dist, dy = ty / dist, dz = tz / dist;
    const vx = r.vx / speed, vy = r.vy / speed, vz = r.vz / speed;
    const cos = vx * dx + vy * dy + vz * dz;
    if (cos < HOMING_BREAK_COS) {
      r.homingTarget = -1; r.homingVehicleId = -1;
      return;
    }
    const angle = Math.acos(clamp(cos, -1, 1));
    const maxTurn = (t.state.vehicle === VEHICLE.JET ? HOMING_AIR_TURN_RATE : HOMING_TURN_RATE) * dt;
    if (angle < 1e-4) return;
    const k = Math.min(1, maxTurn / angle);
    // Rotate the unit velocity toward the target direction by k of the gap.
    let px = dx - vx * cos, py = dy - vy * cos, pz = dz - vz * cos;
    const pl = Math.hypot(px, py, pz);
    if (pl < 1e-6) return;
    px /= pl; py /= pl; pz /= pl;
    const rotated = angle * k;
    const c = Math.cos(rotated), s = Math.sin(rotated);
    r.vx = (vx * c + px * s) * speed;
    r.vy = (vy * c + py * s) * speed;
    r.vz = (vz * c + pz * s) * speed;
  }

  private updateProjectiles(): void {
    for (const r of [...this.projectiles.values()]) {
      const def = weaponDefById(r.weapon);
      if (!def || def.kind !== 'projectile') {
        this.projectiles.delete(r.id);
        continue;
      }
      this.steerHomingProjectile(r, TICK_DT);

      if (r.sleeping) {
        const victim = this.overlappingProjectileVictim(r, def);
        if (victim) {
          this.projectileHitPlayer(r, def, victim, r.x, r.y, r.z);
          continue;
        }
      }

      // A fused projectile advances only as far as its remaining fuse permits.
      // This keeps non-tick-aligned fuse values deterministic and prevents one
      // final full-tick step beyond the configured detonation time.
      const simDt = Math.min(TICK_DT, r.fuseLeft);
      if (simDt > 0) {
        if (r.sleeping) r.ageSeconds += simDt;
        else if (this.advanceProjectile(r, def, simDt)) continue;
      }
      r.fuseLeft -= simDt;

      // A low-energy early ricochet may settle on the ground. That continuous
      // contact becomes explosive exactly when its finite terrain window ends;
      // indefinite ricochet weapons retain their existing dormant behavior.
      const terrainBounceTime = def.terrainBounceTime;
      if (
        r.sleeping &&
        def.bounces !== true &&
        terrainBounceTime !== undefined &&
        r.ageSeconds + 1e-9 >= Math.max(0, terrainBounceTime)
      ) {
        this.explode(
          r.x, r.y, r.z,
          this.players.get(r.owner) ?? null,
          def, -1, r.id,
        );
        this.projectiles.delete(r.id);
        continue;
      }

      if (r.fuseLeft <= 1e-9 || r.distLeft <= 1e-9) {
        // The cluster shell's fuse is its split timer, not a detonation.
        if (r.weapon === TANK_CLUSTER.id && r.fuseLeft <= 1e-9) {
          this.splitClusterShell(r);
          this.projectiles.delete(r.id);
          continue;
        }
        // The nuke marker's fuse is its countdown: time to drop the bomb.
        if (r.weapon === NUKE_MARKER.id && r.fuseLeft <= 1e-9) {
          this.dropNuke(r);
          this.projectiles.delete(r.id);
          continue;
        }
        this.expireProjectile(r, def);
      }
    }
  }

  /** Burst the shell into a deterministic cone of bomblets. */
  private splitClusterShell(parent: Projectile): void {
    const speed = Math.hypot(parent.vx, parent.vy, parent.vz);
    const bx = speed > 1e-3 ? parent.vx / speed : 0;
    const by = speed > 1e-3 ? parent.vy / speed : -1;
    const bz = speed > 1e-3 ? parent.vz / speed : 0;
    // Any perpendicular basis works; derive one without special cases.
    let ux = -bz, uy = 0, uz = bx;
    const ul = Math.hypot(ux, uy, uz);
    if (ul < 1e-6) { ux = 1; uy = 0; uz = 0; } else { ux /= ul; uz /= ul; }
    const wx = by * uz - bz * uy;
    const wy = bz * ux - bx * uz;
    const wz = bx * uy - by * ux;
    // Bomblet velocity = inherited shell momentum + a FIXED lateral scatter.
    // Keeping the scatter absolute (not a cone angle) makes the footprint
    // independent of shell speed: a fast flat shot stays a tight, precise
    // blanket carried downrange, and a vertical shot climbs before raining
    // straight back down, instead of spraying a ball in all directions.
    const SCATTER = 15; // m/s at the disc edge
    for (let i = 0; i < CLUSTER_COUNT; i++) {
      // Sunflower disc (golden-angle spacing, sqrt radius growth): blankets
      // the full footprint evenly instead of a single ring with a hole in
      // the middle. Still fully deterministic.
      const a = i * 2.39996;
      const lat = SCATTER * Math.sqrt((i + 0.5) / CLUSTER_COUNT);
      const id = this.allocateEntity('nextProjectileId', this.projectiles);
      this.projectiles.set(id, {
        id, owner: parent.owner, weapon: CLUSTER_BOMBLET.id,
        x: parent.x, y: parent.y, z: parent.z,
        vx: parent.vx * 0.9 + (ux * Math.cos(a) + wx * Math.sin(a)) * lat,
        vy: parent.vy * 0.9 + (uy * Math.cos(a) + wy * Math.sin(a)) * lat,
        vz: parent.vz * 0.9 + (uz * Math.cos(a) + wz * Math.sin(a)) * lat,
        distLeft: CLUSTER_BOMBLET.range,
        fuseLeft: CLUSTER_BOMBLET.fuse ?? 12,
        ageSeconds: 0,
        sleeping: false,
      });
    }
    this.events.push({
      bytes: encodeExplosion(parent.x, parent.y, parent.z, TANK_CLUSTER.id, parent.id),
      x: parent.x, z: parent.z, radius: NET.FIRE_EVENT_RADIUS,
    });
  }

  /**
   * Range/fuse exhaustion is not an impact. Rockets retain their useful
   * terminal airburst, while impact-only artillery retires without inventing
   * an explosion in empty space.
   */
  private expireProjectile(r: Projectile, def: WeaponDef): void {
    if (!def.impactOnly) {
      this.explode(
        r.x, r.y, r.z,
        this.players.get(r.owner) ?? null,
        def, -1, r.id,
      );
    }
    this.projectiles.delete(r.id);
  }

  /**
   * Advance one projectile through a fixed simulation slice.
   *
   * Acceleration is integrated kinematically and every chord is swept against
   * players and the canonical world. Opt-in ricocheting projectiles may consume
   * the remaining slice after a bounce; the contact budget prevents pathological
   * CSG corners from trapping the server in an unbounded loop.
   *
   * Returns true when the projectile detonated and removed itself.
   */
  private advanceProjectile(r: Projectile, def: WeaponDef, dt: number): boolean {
    const gravity = Math.max(0, def.gravity ?? 0);
    const projR = def.projRadius ?? 0.16;
    const maxContacts = 4;
    const contactSkin = 0.008;
    const startAge = r.ageSeconds;
    let remaining = dt;

    for (
      let contactCount = 0;
      contactCount < maxContacts && remaining > 1e-7 && r.distLeft > 1e-9;
      contactCount++
    ) {
      let stepDt = remaining;
      let sx = r.vx * stepDt;
      let sy = r.vy * stepDt - 0.5 * gravity * stepDt * stepDt;
      let sz = r.vz * stepDt;
      let stepLen = Math.sqrt(sx * sx + sy * sy + sz * sz);
      if (stepLen < 1e-9) break;

      // Range is a strict center-path budget, not a post-step lifetime check.
      // Clip the terminal chord before any player or terrain sweep so nothing
      // can be hit even a fraction of a tick beyond the configured distance.
      if (stepLen > r.distLeft) {
        const scale = r.distLeft / stepLen;
        sx *= scale;
        sy *= scale;
        sz *= scale;
        stepLen = r.distLeft;
        stepDt *= scale;
      }
      const dx = sx / stepLen, dy = sy / stepLen, dz = sz / stepLen;

      // The player capsule is already expanded by projR, so its sweep ends at
      // stepLen. Adding projR to maxT would detect victims beyond this slice.
      let bestT = Infinity;
      let victim: ServerPlayer | null = null;
      let vehicleVictim: ServerVehicle | null = null;
      const owner = this.players.get(r.owner);
      // A short projectile chord can only touch bodies whose expanded bounds
      // overlap it. Preserve the canonical capsule sweep and Map tie order
      // for every possible hit, including starts inside an expanded body.
      const minX = Math.min(r.x, r.x + sx) - 1e-7, maxX = Math.max(r.x, r.x + sx) + 1e-7;
      const minY = Math.min(r.y, r.y + sy) - 1e-7, maxY = Math.max(r.y, r.y + sy) + 1e-7;
      const minZ = Math.min(r.z, r.z + sz) - 1e-7, maxZ = Math.max(r.z, r.z + sz) + 1e-7;
      const bodyRadius = PLAYER.RADIUS + projR;
      for (const q of this.players.values()) {
        // Occupants are protected by the hull, swept as a sphere below.
        if (!q.state.alive || q.id === r.owner || q.state.vehicle !== VEHICLE.NONE) continue;
        if (q.state.px + bodyRadius < minX || q.state.px - bodyRadius > maxX ||
            q.state.pz + bodyRadius < minZ || q.state.pz - bodyRadius > maxZ ||
            q.state.py + PLAYER.HEIGHT + projR < minY || q.state.py - projR > maxY) continue;
        if (owner && !this.areEnemies(owner, q)) continue;
        const t = rayCapsule(
          r.x, r.y, r.z, dx, dy, dz, stepLen,
          q.state.px, q.state.py + PLAYER.RADIUS, q.state.py + PLAYER.HEIGHT - PLAYER.RADIUS, q.state.pz,
          PLAYER.RADIUS + projR,
        );
        if (t >= 0 && t < bestT) { bestT = t; victim = q; }
      }
      const ownerVehicleId = owner?.vehicleId ?? -1;
      for (const v of this.vehicles.values()) {
        if (v.respawnAtTick >= 0 || v.id === ownerVehicleId) continue;
        const radius = vehicleDefinition(v.type, v.variant)!.radius;
        const vr = radius + projR, cy = v.y + radius;
        if (v.x + vr < minX || v.x - vr > maxX || v.z + vr < minZ || v.z - vr > maxZ ||
            cy + vr < minY || cy - vr > maxY) continue;
        const t = rayCapsule(
          r.x, r.y, r.z, dx, dy, dz, stepLen,
          v.x, cy, cy, v.z, vr,
        );
        if (t >= 0 && t < bestT) { bestT = t; victim = null; vehicleVictim = v; }
      }

      // Terrain is traced slightly beyond the center's displacement, then the
      // surface distance is backed up by the projectile radius.
      const th = this.world.trace(r.x, r.y, r.z, dx, dy, dz, stepLen + projR);
      const wallT = th.hit ? Math.max(0, th.dist - projR) : Infinity;

      const creatureHit = this.wildlife.hitRay(r.x, r.y, r.z, dx, dy, dz,
        Math.min(stepLen, wallT, bestT), projR);
      if (creatureHit && creatureHit.t < bestT) {
        const hx = r.x + dx * creatureHit.t, hy = r.y + dy * creatureHit.t, hz = r.z + dz * creatureHit.t;
        const owner = this.players.get(r.owner) ?? null;
        this.wildlife.damage(creatureHit.c, def.damage, r.owner, this.tick);
        this.explode(hx, hy, hz, owner, def, -1, r.id);
        this.projectiles.delete(r.id); return true;
      }

      if (vehicleVictim && bestT <= wallT && bestT <= stepLen) {
        const hx = r.x + dx * bestT, hy = r.y + dy * bestT, hz = r.z + dz * bestT;
        const owner = this.players.get(r.owner) ?? null;
        // Direct hull hit: full direct damage on the hull, then the normal
        // splash (which also feeds hulls, so no double-dipping here).
        this.damageVehicle(vehicleVictim, def.damage * (r.hullDamageScale ?? 1), owner, def.id);
        this.explode(hx, hy, hz, owner, def, -1, r.id);
        this.projectiles.delete(r.id);
        return true;
      }
      if (victim && bestT <= wallT && bestT <= stepLen) {
        const hx = r.x + dx * bestT, hy = r.y + dy * bestT, hz = r.z + dz * bestT;
        this.projectileHitPlayer(r, def, victim, hx, hy, hz);
        return true;
      }

      if (wallT <= stepLen) {
        const frac = stepLen > 0 ? wallT / stepLen : 0;
        const impactDt = stepDt * frac;
        const impactAge = startAge + (dt - remaining) + impactDt;
        r.x += dx * wallT;
        r.y += dy * wallT;
        r.z += dz * wallT;
        r.vy -= gravity * impactDt;
        r.distLeft = Math.max(0, r.distLeft - wallT);

        const finiteBounceWindow = Math.max(0, def.terrainBounceTime ?? 0);
        const bouncesAtImpact = def.bounces === true ||
          impactAge + 1e-9 < finiteBounceWindow;
        if (!bouncesAtImpact) {
          this.explode(
            r.x, r.y, r.z,
            this.players.get(r.owner) ?? null,
            def, -1, r.id,
          );
          this.projectiles.delete(r.id);
          return true;
        }

        // Reflect the into-surface component, retain a damped tangent, and
        // leave a tiny outward skin so the next sweep cannot re-hit at t=0.
        const nx = th.nx, ny = th.ny, nz = th.nz;
        const restitution = clamp(def.bounce ?? 0.58, 0, 1);
        const tangentRetention = clamp(def.bounceFriction ?? 0.82, 0, 1);
        const vn = r.vx * nx + r.vy * ny + r.vz * nz;
        if (vn < 0) {
          r.vx -= (1 + restitution) * vn * nx;
          r.vy -= (1 + restitution) * vn * ny;
          r.vz -= (1 + restitution) * vn * nz;
        }
        const outN = r.vx * nx + r.vy * ny + r.vz * nz;
        const tx = r.vx - outN * nx;
        const ty = r.vy - outN * ny;
        const tz = r.vz - outN * nz;
        r.vx = outN * nx + tx * tangentRetention;
        r.vy = outN * ny + ty * tangentRetention;
        r.vz = outN * nz + tz * tangentRetention;
        r.x += nx * contactSkin;
        r.y += ny * contactSkin;
        r.z += nz * contactSkin;

        const postSpeed = Math.sqrt(r.vx * r.vx + r.vy * r.vy + r.vz * r.vz);
        if (ny > 0.55 && postSpeed < 1.4) {
          r.vx = 0; r.vy = 0; r.vz = 0;
          r.sleeping = true;
          break;
        }

        remaining -= impactDt;
        // A zero-time crease contact still has a bounded contact budget. The
        // outward skin normally makes progress on the next iteration.
        continue;
      }

      r.x += sx;
      r.y += sy;
      r.z += sz;
      r.vy -= gravity * stepDt;
      r.distLeft = Math.max(0, r.distLeft - stepLen);
      remaining = Math.max(0, remaining - stepDt);
    }
    r.ageSeconds = startAge + dt;
    return false;
  }

  /** A stationary grenade remains dangerous if a player walks into it. */
  private overlappingProjectileVictim(r: Projectile, def: WeaponDef): ServerPlayer | null {
    const radius = PLAYER.RADIUS + (def.projRadius ?? 0.16);
    const radiusSq = radius * radius;
    for (const q of this.players.values()) {
      if (!q.state.alive || q.id === r.owner || q.state.vehicle !== VEHICLE.NONE) continue;
      const owner = this.players.get(r.owner);
      if (owner && !this.areEnemies(owner, q)) continue;
      const axisY = clamp(
        r.y,
        q.state.py + PLAYER.RADIUS,
        q.state.py + PLAYER.HEIGHT - PLAYER.RADIUS,
      );
      const dx = r.x - q.state.px;
      const dy = r.y - axisY;
      const dz = r.z - q.state.pz;
      if (dx * dx + dy * dy + dz * dz <= radiusSq) return q;
    }
    return null;
  }

  private projectileHitPlayer(
    r: Projectile,
    def: WeaponDef,
    victim: ServerPlayer,
    x: number, y: number, z: number,
  ): void {
    const owner = this.players.get(r.owner) ?? null;
    const wasAlive = victim.state.alive;
    // Direct impact owns the direct damage. A survivor is explicitly identified
    // to explode(), which guarantees its impulse without a redundant LOS test
    // while still preventing a second splash-damage application.
    this.damage(victim, def.damage, owner ?? victim, def.id, 0, 0, 0);
    if (owner && owner.sink) {
      owner.sink.send(encodeHit(def.damage, wasAlive && !victim.state.alive));
    }
    this.explode(x, y, z, owner, def, victim.id, r.id);
    this.projectiles.delete(r.id);
  }

  private explode(
    x: number, y: number, z: number,
    owner: ServerPlayer | null,
    def: WeaponDef,
    directVictimId: number,
    projectileId: number,
  ): void {
    this.events.push({
      bytes: encodeExplosion(x, y, z, def.id, projectileId),
      x, z, radius: NET.FIRE_EVENT_RADIUS,
      alwaysFor: def.id === 213 ? owner?.id : undefined,
    });
    const radius = def.splashRadius ?? 4.5;
    const maxDmg = def.splashMax ?? 70;
    const maxImpulse = Math.max(0, def.splashImpulse ?? 0);
    const upwardBias = Math.max(0, def.splashLift ?? 0);

    for (const c of this.wildlife.creatures.values()) {
      if (c.deadUntil) continue;
      const body = CREATURE_DEFS[c.species];
      const dx = c.x - x, dy = c.y + body.height * 0.5 - y, dz = c.z - z;
      const length = Math.hypot(dx, dy, dz), distance = Math.max(0, length - body.radius);
      if (distance >= radius) continue;
      if (length > 0.5 && this.world.trace(x, y, z, dx / length, dy / length, dz / length,
          Math.max(0, length - body.radius)).hit) continue;
      this.wildlife.damage(c, maxDmg * (1 - distance / radius), owner?.id ?? -1, this.tick);
    }

    // Hulls take splash before players: they are large, need no LOS finesse,
    // and a dying hull's own explosion chains here (bounded by the dead-hull
    // guard in damageVehicle).
    for (const v of this.vehicles.values()) {
      if (v.respawnAtTick >= 0) continue;
      const vdef = vehicleDefinition(v.type, v.variant)!;
      const ddx = v.x - x, ddy = v.y + vdef.radius - y, ddz = v.z - z;
      const dist = Math.max(0, Math.hypot(ddx, ddy, ddz) - vdef.radius);
      if (dist > radius) continue;
      const falloff = radius > 0 ? clamp(1 - dist / radius, 0, 1) : 0;
      this.damageVehicle(v, maxDmg * falloff * 1.6, owner, def.id);
    }

    for (const q of this.players.values()) {
      if (!q.state.alive) continue;
      // Occupants are shielded by the hull; the hull loop above pays instead.
      if (q.state.vehicle !== VEHICLE.NONE) continue;
      if (owner && owner.id !== q.id && !this.areEnemies(owner, q)) continue;
      const directVictim = q.id === directVictimId;
      const ay = clamp(y, q.state.py + PLAYER.RADIUS, q.state.py + PLAYER.HEIGHT - PLAYER.RADIUS);
      const ddx = q.state.px - x, ddy = ay - y, ddz = q.state.pz - z;
      const dl = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
      const dist = Math.max(0, dl - PLAYER.RADIUS);
      if (dist > radius) continue;

      // The projectile sweep already proved direct contact. Everyone else
      // requires an independent blast LOS so explosions do not reach through
      // terrain.
      if (!directVictim && dl > 0.5) {
        const nx = ddx / dl, ny = ddy / dl, nz = ddz / dl;
        const th = this.world.trace(x + nx * 0.15, y + ny * 0.15, z + nz * 0.15, nx, ny, nz, dl);
        if (th.hit && th.dist < dl - PLAYER.RADIUS - 0.2) continue;
      }

      const falloff = radius > 0 ? clamp(1 - dist / radius, 0, 1) : 0;
      // Retain 35% of the configured push at the damage radius. The old
      // damage-derived curve became nearly inert at its edge, even though an
      // explosion there was still clearly visible and tactically relevant.
      const imp = maxImpulse * (0.35 + 0.65 * falloff);
      let nx = 0, ny = 0, nz = 0;
      if (dl > 1e-3) { nx = ddx / dl; ny = ddy / dl; nz = ddz / dl; }
      const launched = this.applyImpulse(
        q,
        nx * imp,
        (ny + upwardBias) * imp,
        nz * imp,
      );
      if (launched) this.rememberFallDamageCredit(q, owner, def.id);

      // A direct-hit victim already received def.damage above, but deliberately
      // remains in this loop for the full radial blast impulse.
      if (directVictim) continue;

      let dmg = maxDmg * falloff;
      if (owner && q.id === owner.id) dmg *= 0.55; // reduced self-damage: rocket jumps!
      const wasAlive = q.state.alive;
      this.damage(q, dmg, owner ?? q, def.id, 0, 0, 0);
      if (owner && owner.sink && q.id !== owner.id && dmg >= 1) {
        owner.sink.send(encodeHit(dmg, wasAlive && !q.state.alive));
      }
    }
  }

  private applyImpulse(victim: ServerPlayer, kx: number, ky: number, kz: number): boolean {
    if (kx === 0 && ky === 0 && kz === 0) return false;
    victim.state.vx += kx;
    victim.state.vy += ky;
    victim.state.vz += kz;
    victim.state.grounded = false;
    return true;
  }

  private rememberFallDamageCredit(
    victim: ServerPlayer,
    attacker: ServerPlayer | null,
    weapon: number,
  ): void {
    // A self/environmental blast supersedes any older enemy launch; otherwise
    // an unrelated later rocket jump could incorrectly preserve stale credit.
    if (!attacker || attacker.id === victim.id) {
      this.clearFallDamageCredit(victim);
      return;
    }
    victim.fallCreditAttackerId = attacker.id;
    victim.fallCreditWeapon = weapon;
    victim.fallCreditUntilTick = this.tick + BLAST_FALL_CREDIT_TICKS;
  }

  private fallDamageCredit(
    victim: ServerPlayer,
  ): { attacker: ServerPlayer; weapon: number } | null {
    if (
      victim.fallCreditAttackerId >= 0 &&
      this.tick <= victim.fallCreditUntilTick
    ) {
      const attacker = this.players.get(victim.fallCreditAttackerId);
      if (attacker && attacker.id !== victim.id) {
        return { attacker, weapon: victim.fallCreditWeapon };
      }
    }
    this.clearFallDamageCredit(victim);
    return null;
  }

  private clearFallDamageCredit(victim: ServerPlayer): void {
    victim.fallCreditAttackerId = -1;
    victim.fallCreditWeapon = 255;
    victim.fallCreditUntilTick = -1;
  }

  private damage(victim: ServerPlayer, amount: number, attacker: ServerPlayer, weaponId: number, kx: number, ky: number, kz: number): void {
    if (!victim.state.alive || victim.state.airlift || (attacker.id !== victim.id && !this.areEnemies(attacker, victim))) return;
    // The H playtest cheat doubles as god mode: at 10x run speed every
    // ridge launch would be a lethal fall, defeating the point of getting
    // somewhere fast. Covers all damage (fall included - it routes through
    // here); only the kill floor below the world stays lethal. Bots never
    // send BTN.HYPER.
    if (victim.lastCmd && (victim.lastCmd.buttons & BTN.HYPER) !== 0) return;
    if (attacker.id !== victim.id && this.tick < victim.spawnProtectedUntil) return;
    if (amount > 0 && attacker.id !== victim.id) {
      this.frontier?.recordCombat(victim.state.px, victim.state.pz, [victim.faction, attacker.faction], this.tick);
      recordHit(victim, attacker, this.tick);
    }
    if (amount > 0) victim.recallSince = -1;
    victim.health -= amount;
    victim.regenBlockUntil = this.tick + PLAYER.REGEN_DELAY * TICK_RATE;
    this.applyImpulse(victim, kx, ky, kz);
    if (ky > 1) victim.state.grounded = false;
    if (victim.health <= 0) this.kill(victim, attacker, weaponId);
  }

  private kill(victim: ServerPlayer, attacker: ServerPlayer, weaponId: number): void {
    const spreeBefore = victim.spree;
    const motion = { x: victim.state.px, y: victim.state.py, z: victim.state.pz,
      vx: clamp(victim.state.vx, -100, 100), vy: clamp(victim.state.vy, -60, 65), vz: clamp(victim.state.vz, -100, 100),
      yaw: victim.lastCmd ? unquantYaw(victim.lastCmd.yaw) : victim.state.heading };
    victim.lastDeath = { x: motion.x, y: motion.y, z: motion.z };
    // Dying at the wheel frees the hull in place (vehicle destruction paths
    // clear possession before calling kill, so this only covers oddballs
    // like the kill floor or admin kills).
    if (victim.state.vehicle !== VEHICLE.NONE) {
      this.releaseVehicleSeat(victim);
    }
    victim.health = 0;
    victim.airlift=undefined;victim.state.airlift=undefined;
    victim.state.alive = false;
    victim.state.vx = 0; victim.state.vy = 0; victim.state.vz = 0;
    victim.deaths++; victim.warDeaths++;
    victim.respawnAtTick = this.tick + PLAYER.RESPAWN_SECONDS * 60;
    victim.spawnProtectedUntil = -1;
    this.frontier?.send(victim, this.players.values(), this.tick);
    cancelReload(victim);
    this.clearFallDamageCredit(victim);
    if (attacker.id !== victim.id) { attacker.frags++; attacker.warKills++; }
    else if (weaponId !== WILDLIFE_WEAPON) attacker.frags--;
    this.stats.kills++;
    this.events.push({ bytes: encodeDeath(victim.id, attacker.id, weaponId, motion) });
    if (attacker.id !== victim.id) this.dropPickups(victim);

    // UT-style spree announcements.
    if (victim.spree >= 5 && attacker.id !== victim.id) {
      this.events.push({ bytes: encodeServerMessage(`${attacker.name} ended ${victim.name}'s killing spree (${victim.spree}).`) });
    }
    victim.spree = 0;
    if (attacker.id !== victim.id) {
      attacker.spree++;
      const label =
        attacker.spree === 5 ? 'is on a KILLING SPREE' :
        attacker.spree === 10 ? 'is on a RAMPAGE' :
        attacker.spree === 15 ? 'is DOMINATING' :
        attacker.spree === 20 ? 'is UNSTOPPABLE' :
        attacker.spree === 25 ? 'is GODLIKE' : null;
      if (label) this.events.push({ bytes: encodeServerMessage(`${attacker.name} ${label}! (${attacker.spree} kills)`) });
    }
    if (this.frontier) rewardKill(victim, attacker, this.tick, spreeBefore, this.frontier.territories, this.players);
  }

  private updateRespawnsAndRegen(): void {
    for (const p of this.players.values()) {
      if (
        p.fallCreditAttackerId >= 0 &&
        (p.state.grounded || this.tick > p.fallCreditUntilTick)
      ) {
        this.clearFallDamageCredit(p);
      }
      if (!p.state.alive) {
        if (p.respawnAtTick >= 0 && this.tick >= p.respawnAtTick) {
          const spawn = this.pickSpawn(p.id);
          if (!spawn) { p.respawnAtTick = this.tick + TICK_RATE; continue; }
          const s = p.state;
          s.px = spawn.x; s.py = spawn.y; s.pz = spawn.z;
          s.vx = 0; s.vy = 0; s.vz = 0;
          s.grounded = false; s.jumpHeld = true; s.dodgeCd = 0; s.alive = true;
          s.airSeconds = SWIMMING.AIR_SECONDS; s.swimming = false; s.submerged = false;
          p.health = PLAYER.MAX_HEALTH;
          p.fireCd = 0.4;
          refillWeaponAmmo(p);
          // Death takes cave weapons away entirely: never respawn holding
          // an empty, unselectable railgun/nuke launcher.
          if (WEAPONS[p.weapon]?.spawnEmpty) p.weapon = 0;
          this.clearFallDamageCredit(p);
          p.respawnAtTick = -1; p.deployWaitSince = -1;
          if (this.frontier) p.spawnProtectedUntil = this.tick + 3 * TICK_RATE;
          if (this.frontier && p.isBot) this.stageVehicleCrew(p);
          if (spawn.air !== undefined) this.launchJet(p, spawn.air);
          p.inputQueue.length = 0;
          p.lastCmd = null;
          this.events.push({ bytes: encodeSpawn(p.id, p.state.px, p.state.py, p.state.pz) });
        }
      } else if (p.health < PLAYER.MAX_HEALTH && this.tick >= p.regenBlockUntil) {
        p.health = Math.min(PLAYER.MAX_HEALTH, p.health + PLAYER.REGEN_RATE * TICK_DT);
      }
      if (
        p.state.alive &&
        p.isBot &&
        this.tick % BOT_AMMO_REGEN_TICKS === p.id % BOT_AMMO_REGEN_TICKS
      ) {
        this.regenerateBotAmmo(p);
      }
    }
  }

  // ---- Resource pickups -------------------------------------------------

  private dropPickups(victim: ServerPlayer): void {
    const ammoWeapons: number[] = [];
    if (this.lootRng() < 0.70) {
      const weapon = this.randomFiniteAmmoWeapon(ammoWeapons);
      if (weapon >= 0) {
        ammoWeapons.push(weapon);
        this.spawnPickup(PICKUP_AMMO, weapon, victim);
      }
    }
    if (this.lootRng() < 0.25) {
      const weapon = this.randomFiniteAmmoWeapon(ammoWeapons);
      if (weapon >= 0) {
        ammoWeapons.push(weapon);
        this.spawnPickup(PICKUP_AMMO, weapon, victim);
      }
    }
    if (this.lootRng() < 0.35) {
      this.spawnPickup(PICKUP_HEALTH, -1, victim);
    }
  }

  /** Keep the fixed cave-loot spots stocked, respawning after collection. */
  private updateCaveLoot(): void {
    for (const spot of this.caveLoot) {
      if (spot.region && !this.activeLootRegions.has(spot.region)) {
        if (spot.activeId) this.pickups.delete(spot.activeId);
        spot.activeId = 0;
        continue;
      }
      if (spot.activeId !== 0) {
        if (this.pickups.has(spot.activeId)) continue;
        spot.activeId = 0;
        spot.respawnAtTick = this.tick + CAVE_LOOT_RESPAWN_TICKS;
        continue;
      }
      if (this.tick < spot.respawnAtTick) continue;
      const id = this.allocateEntity('nextPickupId', this.pickups);
      this.pickups.set(id, {
        id, kind: spot.kind, weapon: spot.weapon,
        x: spot.x, y: spot.y, z: spot.z,
        availableAtTick: this.tick,
        expiresAtTick: Number.MAX_SAFE_INTEGER,
        permanent: true,
      });
      spot.activeId = id;
    }
  }

  private randomFiniteAmmoWeapon(excluded: readonly number[]): number {
    const choices = WEAPONS
      .filter((def) => !def.infiniteReserve && !def.spawnEmpty && !excluded.includes(def.id))
      .map((def) => def.id);
    if (choices.length === 0) return -1;
    return choices[Math.min(choices.length - 1, Math.floor(this.lootRng() * choices.length))];
  }

  private dropCreatureLoot(creature: Creature, attacker: number): void {
    if (CREATURE_DEFS[creature.species].boss) {
      this.rewardBoss(creature, attacker);
      return;
    }
    const player = this.players.get(attacker);
    if (!player) return;
    // Reuse the authoritative bounded pickup placement/cap without changing
    // the player's actual position or allowing fauna to unlock rare weapons.
    const victim = { state: { ...player.state, px: creature.x, py: creature.y, pz: creature.z } } as ServerPlayer;
    this.spawnPickup(PICKUP_HEALTH, -1, victim);
    if (CREATURE_DEFS[creature.species].damage > 0) {
      const carried = player.weapon;
      const weapon = WEAPONS[carried]?.infiniteReserve || WEAPONS[carried]?.spawnEmpty ? 1 : carried;
      this.spawnPickup(PICKUP_AMMO, weapon, victim);
    }
  }

  private rewardBoss(creature: Creature, attacker: number): void {
    if (creature.health > 0 || this.rewardedBosses.has(creature)) return;
    this.rewardedBosses.add(creature);
    const def = CREATURE_DEFS[creature.species];
    const reward = def.bossReward ?? { salvage: 500, weapon: NUKE_LAUNCHER_ID, ammoCrates: 2 };
    const participants = [...creature.damageContributors]
      .filter(([, hit]) => hit.damage >= def.health * BOSS_MIN_DAMAGE_FRACTION &&
        hit.lastHitTick <= this.tick && this.tick - hit.lastHitTick <= BOSS_CONTRIBUTION_WINDOW_TICKS)
      .map(([id, hit]) => ({ player: this.players.get(id), damage: hit.damage }))
      .filter((entry): entry is { player: ServerPlayer; damage: number } => !!entry.player && !entry.player.isBot)
      .sort((a, b) => b.damage - a.damage || a.player.id - b.player.id);
    const eligible = new Set(participants.map(({ player }) => player.id));
    const salvage = Math.max(0, Math.min(1_000_000, Math.floor(reward.salvage)));
    const weapon = WEAPONS[reward.weapon]?.spawnEmpty ? reward.weapon : NUKE_LAUNCHER_ID;
    const ammoCrates = Math.max(0, Math.min(8, Math.floor(reward.ammoCrates)));
    for (const { player } of participants) {
      const gained = Math.min(salvage, Math.max(0, 1_000_000 - player.salvage));
      // Like discovery rewards, this is part of the ordinary character
      // checkpoint. salvageEarned is a coordinator extraction watermark and
      // must never be changed by a local simulation reward.
      player.salvage += gained;
      player.sink?.send(encodeServerMessage(`${def.name} bounty: +${gained} salvage.`));
      awardXp(player, XP_VALUES.boss, XP_REASON.BOSS);
    }

    // One shared cache per kill, regardless of party size. Dead contributors
    // keep their salvage and their reservation; respawning cannot mint loot.
    const victim = { state: { px: creature.x, py: creature.y, pz: creature.z } } as ServerPlayer;
    const drops: [PickupKind, number][] = [[PICKUP_HEALTH, -1], [PICKUP_WEAPON, weapon],
      ...Array.from({ length: ammoCrates }, (): [PickupKind, number] => [PICKUP_AMMO, weapon])];
    let cached = false;
    for (const [kind, carried] of drops) {
      const pickup = this.spawnPickup(kind, carried, victim);
      if (!pickup) continue;
      pickup.expiresAtTick = this.tick + BOSS_REWARD_LIFETIME_TICKS;
      if (eligible.size) {
        pickup.rewardFor = eligible;
        pickup.reservedUntilTick = this.tick + BOSS_REWARD_RESERVATION_TICKS;
      }
      if (kind === PICKUP_WEAPON) cached = true;
    }
    const leader = participants[0]?.player ?? this.players.get(attacker);
    const credit = leader ? `${leader.name}${participants.length > 1 ? ` and ${participants.length - 1} fellow hunter${participants.length > 2 ? 's' : ''}` : ''}` : 'planetary forces';
    this.events.push({ bytes: encodeServerMessage(
      `PLANET BOUNTY: ${def.name} defeated by ${credit}! ${participants.length} hunter${participants.length === 1 ? '' : 's'} rewarded.${cached ? ` ${WEAPONS[weapon].name} cache at the kill site${eligible.size ? ', reserved for participants for 90 seconds' : ''}.` : ''}`) });
  }

  private spawnPickup(
    kind: PickupKind,
    weapon: number,
    victim: ServerPlayer,
  ): ServerPickup | null {
    const position = this.pickupPlacement(victim);
    if (!position) return null;

    // Retire ordinary drops oldest-first, then reserved rewards only if the
    // entire cap is occupied by them.
    // The cap governs TRANSIENT drops only: permanent cave loot neither
    // counts against it nor gets evicted (there are more cave-loot spots
    // than MAX_LIVE_PICKUPS, so counting them would purge every drop).
    let transient = 0;
    for (const pk of this.pickups.values()) {
      if (!pk.permanent) transient++;
    }
    while (transient >= MAX_LIVE_PICKUPS) {
      let oldest: number | undefined;
      for (const [pid, pk] of this.pickups) {
        if (!pk.permanent && this.tick >= (pk.reservedUntilTick ?? 0)) { oldest = pid; break; }
      }
      // Still a hard cap if every live drop is a recent boss reward.
      if (oldest === undefined) for (const [pid, pk] of this.pickups) {
        if (!pk.permanent) { oldest = pid; break; }
      }
      if (oldest === undefined) break;
      this.pickups.delete(oldest);
      transient--;
    }

    const id = this.allocateEntity('nextPickupId', this.pickups);
    const pickup: ServerPickup = {
      id, kind, weapon,
      x: position.x, y: position.y, z: position.z,
      availableAtTick: this.tick + PICKUP_GRACE_TICKS,
      expiresAtTick: this.tick + PICKUP_LIFETIME_TICKS,
    };
    this.pickups.set(id, pickup);
    return pickup;
  }

  /**
   * Drops follow the victim's local vertical air column rather than groundY,
   * which starts in the sky and would incorrectly place cavern deaths on the
   * exterior terrain roof.
   */
  private pickupPlacement(victim: ServerPlayer): { x: number; y: number; z: number } | null {
    for (let attempt = 0; attempt < 6; attempt++) {
      const angle = this.lootRng() * Math.PI * 2;
      const radius = attempt === 5 ? 0 : 0.25 + this.lootRng() * 0.7;
      const x = victim.state.px + Math.cos(angle) * radius;
      const z = victim.state.pz + Math.sin(angle) * radius;
      let originY = victim.state.py + PLAYER.RADIUS;
      // Offset sampling may put the ray just inside a nearby slope. Search a
      // short distance upward for air without ever escaping a cavern ceiling.
      for (let lift = 0; lift < 5 && this.world.sdf(x, originY, z) <= 0.02; lift++) {
        originY += 0.18;
      }
      if (this.world.sdf(x, originY, z) <= 0.02) continue;
      const maxDist = Math.max(0, originY - WORLD.KILL_Y);
      const hit = this.world.trace(x, originY, z, 0, -1, 0, maxDist);
      if (!hit.hit) continue;
      for (const hover of [0.32, 0.5, 0.72]) {
        const y = hit.y + hover;
        if (this.world.sdf(x, y, z) > 0.08) return { x, y, z };
      }
    }
    return null;
  }

  private updatePickups(): void {
    if (this.pickups.size === 0) {
      for (const p of this.players.values()) p.fullPickupContacts.clear();
      return;
    }

    const nextFullContacts = new Map<ServerPlayer, Set<number>>();
    const collectRadiusSq = PICKUP_COLLECT_RADIUS * PICKUP_COLLECT_RADIUS;
    const releaseRadiusSq =
      PICKUP_CONTACT_RELEASE_RADIUS * PICKUP_CONTACT_RELEASE_RADIUS;
    // One lightweight XZ hash avoids a pickup x all-player scan. Candidates
    // still receive the exact capsule-distance and stable-ID tie checks below.
    const playerBuckets = new Map<number, ServerPlayer[]>();
    for (const p of this.players.values()) {
      if (!p.state.alive) continue;
      const cellX = Math.floor(p.state.px / PICKUP_PLAYER_CELL_SIZE);
      const cellZ = Math.floor(p.state.pz / PICKUP_PLAYER_CELL_SIZE);
      const key = pickupPlayerCellKey(cellX, cellZ);
      const bucket = playerBuckets.get(key);
      if (bucket) bucket.push(p);
      else playerBuckets.set(key, [p]);
    }

    for (const [id, pickup] of this.pickups) {
      if (this.tick >= pickup.expiresAtTick) {
        this.pickups.delete(id);
        continue;
      }
      if (this.tick < pickup.availableAtTick) continue;
      let collector: ServerPlayer | null = null;
      let collectorDistSq = Infinity;
      // Most available crates have no touching player. Allocate contact lists
      // only when needed, retaining the same candidate and notice order.
      let retainedFullContacts: ServerPlayer[] | undefined;
      let enteredFullContacts: ServerPlayer[] | undefined;

      const minCellX = Math.floor(
        (pickup.x - PICKUP_CONTACT_RELEASE_RADIUS) / PICKUP_PLAYER_CELL_SIZE,
      );
      const maxCellX = Math.floor(
        (pickup.x + PICKUP_CONTACT_RELEASE_RADIUS) / PICKUP_PLAYER_CELL_SIZE,
      );
      const minCellZ = Math.floor(
        (pickup.z - PICKUP_CONTACT_RELEASE_RADIUS) / PICKUP_PLAYER_CELL_SIZE,
      );
      const maxCellZ = Math.floor(
        (pickup.z + PICKUP_CONTACT_RELEASE_RADIUS) / PICKUP_PLAYER_CELL_SIZE,
      );
      for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
        for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ++) {
          const candidates = playerBuckets.get(pickupPlayerCellKey(cellX, cellZ));
          if (!candidates) continue;
          for (const p of candidates) {
            if (pickup.rewardFor && this.tick < (pickup.reservedUntilTick ?? 0) && !pickup.rewardFor.has(p.id)) continue;
            const missing = this.pickupMissingResource(p, pickup);
            if (missing === null) continue;
            const d2 = this.pickupCapsuleDistanceSq(p, pickup);
            const wasFullContact = p.fullPickupContacts.has(id);
            if (wasFullContact && d2 <= releaseRadiusSq) {
              (retainedFullContacts ??= []).push(p);
            }
            if (d2 > collectRadiusSq) continue;
            if (missing <= 0) {
              if (!wasFullContact) {
                (retainedFullContacts ??= []).push(p);
                (enteredFullContacts ??= []).push(p);
              }
              continue;
            }
            if (
              d2 < collectorDistSq ||
              (d2 === collectorDistSq && collector !== null && p.id < collector.id)
            ) {
              collector = p;
              collectorDistSq = d2;
            }
          }
        }
      }

      if (collector) {
        const amount = this.collectPickup(collector, pickup);
        if (amount > 0) {
          collector.sink?.send(encodePickupResult({
            pickupId: pickup.id,
            kind: pickup.kind,
            weapon: pickup.weapon,
            result: PICKUP_RESULT_COLLECTED,
            amount,
          }));
          this.pickups.delete(id);
          continue;
        }
      }

      // Keep reported contacts latched until the player genuinely leaves a
      // slightly larger radius. This avoids enter/exit spam at the boundary.
      if (retainedFullContacts) for (const p of retainedFullContacts) {
        let contacts = nextFullContacts.get(p);
        if (!contacts) {
          contacts = new Set<number>();
          nextFullContacts.set(p, contacts);
        }
        contacts.add(id);
      }
      // A full notice is meaningful only while the crate remains available;
      // an eligible collector winning this tick suppresses these notices.
      if (enteredFullContacts) for (const p of enteredFullContacts) {
        p.sink?.send(encodePickupResult({
          pickupId: pickup.id,
          kind: pickup.kind,
          weapon: pickup.weapon,
          result: PICKUP_RESULT_FULL,
          amount: 0,
        }));
      }
    }

    for (const p of this.players.values()) {
      const next = nextFullContacts.get(p);
      p.fullPickupContacts.clear();
      if (!p.state.alive || !next) continue;
      for (const id of next) p.fullPickupContacts.add(id);
    }
  }

  private pickupCapsuleDistanceSq(p: ServerPlayer, pickup: ServerPickup): number {
    const axisY = clamp(
      pickup.y,
      p.state.py + PLAYER.RADIUS,
      p.state.py + PLAYER.HEIGHT - PLAYER.RADIUS,
    );
    const dx = pickup.x - p.state.px;
    const dy = pickup.y - axisY;
    const dz = pickup.z - p.state.pz;
    return dx * dx + dy * dy + dz * dz;
  }

  /**
   * Resource units still missing, zero when full, or null for a malformed /
   * unsupported pickup that must neither be collected nor reported as full.
   */
  private pickupMissingResource(p: ServerPlayer, pickup: ServerPickup): number | null {
    if (pickup.kind === PICKUP_HEALTH) {
      if (pickup.weapon !== -1) return null;
      return Math.max(0, PLAYER.MAX_HEALTH - p.health);
    }
    if (pickup.kind === PICKUP_WEAPON) {
      // The weapon crate itself: refills the magazine of a spawnEmpty weapon.
      const def = WEAPONS[pickup.weapon];
      const ammo = p.ammo[pickup.weapon];
      if (!def || def.id !== pickup.weapon || !def.spawnEmpty || !ammo) return null;
      return Math.max(0, Math.min(def.magazineSize - ammo.magazine,
        def.magazineSize + def.reserveSize - ammo.magazine - ammo.reserve));
    }
    if (pickup.kind !== PICKUP_AMMO) return null;
    const def = WEAPONS[pickup.weapon];
    const ammo = p.ammo[pickup.weapon];
    if (!def || def.id !== pickup.weapon || def.infiniteReserve || !ammo) return null;
    return Math.max(
      0,
      def.magazineSize + def.reserveSize - ammo.magazine - ammo.reserve,
    );
  }

  /** Returns the exact amount gained, or zero for an ineligible collector. */
  private collectPickup(p: ServerPlayer, pickup: ServerPickup): number {
    const missing = this.pickupMissingResource(p, pickup);
    if (missing === null || missing <= 0) return 0;
    if (pickup.kind === PICKUP_HEALTH) {
      const amount = Math.min(missing, HEALTH_PICKUP_AMOUNT);
      p.health += amount;
      return amount;
    }
    const def = WEAPONS[pickup.weapon];
    const ammo = p.ammo[pickup.weapon];
    // pickupMissingResource proved that this is a finite, valid ammo slot.
    if (!def || !ammo) return 0;
    if (pickup.kind === PICKUP_WEAPON) {
      // Found the gun itself: load a full magazine on the spot.
      ammo.magazine += missing;
      return missing;
    }
    const amount = Math.min(missing, ammoPickupAmount(pickup.weapon));
    ammo.reserve += amount;
    return amount;
  }

  private regenerateBotAmmo(p: ServerPlayer): void {
    for (const def of WEAPONS) {
      if (def.infiniteReserve || def.spawnEmpty) continue;
      const ammo = p.ammo[def.id];
      if (!ammo) continue;
      const maxTotal = def.magazineSize + def.reserveSize;
      if (ammo.magazine + ammo.reserve < maxTotal) ammo.reserve++;
    }
  }

  // ---- Lag-compensation history -----------------------------------------

  private recordHistory(): void {
    const byId = new Map<number, HistEntry>();
    for (const p of this.players.values()) {
      byId.set(p.id, { x: p.state.px, y: p.state.py, z: p.state.pz, alive: p.state.alive });
    }
    this.history[this.tick % NET.LAG_HISTORY_TICKS] = { tick: this.tick, byId };
  }

  // ---- Replication -------------------------------------------------------

  private buildSnapshotFor(p: ServerPlayer, indexed = false): Uint8Array {
    if (!indexed) this.rebuildInterest();
    const ents: SnapshotEntity[] = [];
    const strategic: { d2: number; e: SnapshotEntity }[] = [];
    const withDist: { d2: number; e: SnapshotEntity }[] = [];
    const pickupDist: { d2: number; p: SnapshotPickup }[] = [];
    const R2 = NET.INTEREST_RADIUS * NET.INTEREST_RADIUS;
    const px = p.state.px, py = p.state.py, pz = p.state.pz;

    for (const q of this.playerIndex.query(px, pz, NET.INTEREST_RADIUS)) {
      if (q.id === p.id) continue;
      const dx = q.state.px - px, dy = q.state.py - py, dz = q.state.pz - pz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > R2) continue;
      withDist.push({
        d2,
        e: {
          kind: ENT_PLAYER, id: q.id,
          x: q.state.px, y: q.state.py, z: q.state.pz,
          yaw: q.lastCmd ? q.lastCmd.yaw : 0,
          pitch: q.lastCmd ? q.lastCmd.pitch : 0,
          grounded: q.state.grounded,
          dead: !q.state.alive,
          weapon: q.weapon,
          vehicle: q.state.vehicle, vehicleVariant: q.state.vehicleVariant,
          seat: q.state.seat, vehicleId: q.state.vehicleId,
          transportRoute: q.state.transportRoute,
          heading: q.state.heading,
          vehiclePitch: q.state.vehiclePitch, vehicleRoll: q.state.vehicleRoll,
          vehicleRotation: q.state.vehicleRotation,
        },
      });
    }
    for (const r of this.snapshotProjectiles(p)) {
      const dx = r.x - px, dy = r.y - py, dz = r.z - pz;
      const d2 = dx * dx + dy * dy + dz * dz;
      const ownedArtillery = r.weapon === 213 && r.owner === p.id;
      if (d2 > R2 && !ownedArtillery) continue;
      (ownedArtillery ? strategic : withDist).push({
        d2,
        e: {
          kind: ENT_PROJECTILE, id: r.id, weapon: r.weapon,
          x: r.x, y: r.y, z: r.z,
          vx: r.vx, vy: r.vy, vz: r.vz,
          owner: r.owner,
        },
      });
    }
    strategic.sort((a,b)=>a.d2-b.d2);
    for (let i=0;i<strategic.length&&i<MAX_OWNED_ARTILLERY_SHELLS;i++) ents.push(strategic[i].e);
    withDist.sort((a, b) => a.d2 - b.d2);
    for (let i = 0; i < withDist.length && ents.length < NET.MAX_SNAPSHOT_ENTITIES; i++) ents.push(withDist[i].e);
    for (const pickup of this.pickups.values()) {
      const dx = pickup.x - px, dy = pickup.y - py, dz = pickup.z - pz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > R2) continue;
      pickupDist.push({
        d2,
        p: {
          id: pickup.id, kind: pickup.kind, weapon: pickup.weapon,
          x: pickup.x, y: pickup.y, z: pickup.z,
        },
      });
    }
    pickupDist.sort((a, b) => a.d2 - b.d2 || a.p.id - b.p.id);

    const vehicleWithDist: { d2: number; v: SnapshotVehicle }[] = [];
    const VR2 = VEHICLE_INTEREST_RADIUS * VEHICLE_INTEREST_RADIUS;
    for (const v of this.vehicles.values()) {
      // Occupied hulls replicate through their driver's player entity.
      if (v.occupant >= 0 || v.respawnAtTick >= 0) continue;
      const dx = v.x - px, dy = v.y - py, dz = v.z - pz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > VR2) continue;
      vehicleWithDist.push({
        d2,
        v: {
          id: v.id, type: v.type, variant: v.variant,
          transportRoute: v.transportRoute,
          x: v.x, y: v.y, z: v.z,
          heading: v.heading, health: v.health,
        },
      });
    }
    vehicleWithDist.sort((a, b) => a.d2 - b.d2 || a.v.id - b.v.id);
    const vehicleList = vehicleWithDist
      .slice(0, MAX_SNAPSHOT_VEHICLES)
      .map((entry) => entry.v);

    const myVehicle = this.vehicles.get(p.vehicleId);
    const snap: Snapshot = {
      tick: this.tick,
      lastSeq: p.lastProcessedSeq,
      you: {
        jumpAscent: p.state.jumpAscent,
        airlift: p.state.airlift,
        px: p.state.px, py: p.state.py, pz: p.state.pz,
        vx: p.state.vx, vy: p.state.vy, vz: p.state.vz,
        grounded: p.state.grounded,
        alive: p.state.alive,
        dodgeCd: p.state.dodgeCd,
        health: p.health,
        weapon: p.weapon,
        cooldown: p.fireCd,
        ammo: p.ammo,
        reloadWeapon: p.reloadWeapon,
        reloadCooldown: p.reloadCd,
        reloadHeld: p.reloadHeld,
        vehicle: p.state.vehicle, vehicleVariant: p.state.vehicleVariant,
        seat: p.state.seat, vehicleId: p.state.vehicleId,
        transportRoute: p.state.transportRoute,
        heading: p.state.heading,
        vehiclePitch: p.state.vehiclePitch, vehicleRoll: p.state.vehicleRoll,
        vehicleRotation: p.state.vehicleRotation,
        boosting: p.state.boosting,
        airSeconds: p.state.airSeconds, swimming: p.state.swimming, submerged: p.state.submerged,
        boostFuel: p.state.boostFuel,
        vehicleHealth: myVehicle && p.state.vehicle !== VEHICLE.NONE
          ? Math.max(0, myVehicle.health)
          : 0,
        lockState: p.lockState,
        aircraftThreat: aircraftThreatFor(p, this.players, this.projectiles, this.vehicles, (a, b) => this.areEnemies(a, b)),
      },
      ents,
      pickups: pickupDist.slice(0, 64).map((entry) => entry.p),
      vehicles: vehicleList,
      creatures: this.wildlife.snapshot(px, py, pz),
    };
    const w = new ByteWriter(
      128 + ents.length * 27 + Math.min(64, pickupDist.length) * 16 + vehicleList.length * 20 + 360,
    );
    encodeSnapshot(w, snap);
    return w.finish();
  }

  areEnemies(a: ServerPlayer, b: ServerPlayer): boolean {
    return a.id !== b.id && (!this.frontier || (a.faction !== 0 && b.faction !== 0 && a.faction !== b.faction));
  }

  private rebuildInterest(): void {
    this.playerIndex.clear(); this.projectileIndex.clear(); this.ownedArtillery.clear();
    for (const p of this.players.values()) this.playerIndex.insert(p, p.state.px, p.state.pz);
    for (const r of this.projectiles.values()) {
      this.projectileIndex.insert(r, r.x, r.z);
      if (r.weapon === 213) {
        let shells = this.ownedArtillery.get(r.owner);
        if (!shells) this.ownedArtillery.set(r.owner, shells = []);
        shells.push(r);
      }
    }
    this.playerIndex.compact(); this.projectileIndex.compact();
  }

  private *snapshotProjectiles(p: ServerPlayer): IterableIterator<Projectile> {
    for (const r of this.projectileIndex.query(p.state.px, p.state.pz, NET.INTEREST_RADIUS)) {
      if (r.weapon !== 213 || r.owner !== p.id) yield r;
    }
    yield* this.ownedArtillery.get(p.id) ?? [];
  }

  private broadcast(): void {
    this.rebuildInterest();
    const events = this.events;
    this.events = [];
    for (const p of this.players.values()) {
      if (!p.sink) continue;
      for (const ev of events) {
        if (ev.radius !== undefined && ev.alwaysFor !== p.id) {
          const dx = (ev.x ?? 0) - p.state.px;
          const dz = (ev.z ?? 0) - p.state.pz;
          if (dx * dx + dz * dz > ev.radius * ev.radius) continue;
        }
        p.sink.send(ev.bytes);
      }
      p.sink.send(this.buildSnapshotFor(p, true));
      if (this.frontier && this.tick % 60 === 0) this.frontier.send(p, this.playerIndex.query(p.state.px, p.state.pz, NET.INTEREST_RADIUS), this.tick);
    }
  }

  private buildScores(): Uint8Array {
    const rows = [...this.players.values()].map((p) => ({
      id: p.id, frags: p.frags, deaths: p.deaths, ping: p.ping,
    }));
    rows.sort((a, b) => b.frags - a.frags);
    return encodeScores(rows.slice(0, 64));
  }

  private broadcastScores(): void {
    const bytes = this.buildScores();
    for (const p of this.players.values()) {
      if (p.sink) p.sink.send(bytes);
    }
  }
}

/** RFC-1982-style comparison for wrapping uint32 input sequence numbers. */
function seqNewer(next: number, previous: number): boolean {
  const delta = ((next >>> 0) - (previous >>> 0)) >>> 0;
  return delta !== 0 && delta < 0x80000000;
}

/** Collision-free for hash cells inside the authoritative world border. */
function pickupPlayerCellKey(cellX: number, cellZ: number): number {
  return (cellX + PICKUP_PLAYER_GRID_OFFSET) * PICKUP_PLAYER_GRID_STRIDE +
    cellZ + PICKUP_PLAYER_GRID_OFFSET;
}
