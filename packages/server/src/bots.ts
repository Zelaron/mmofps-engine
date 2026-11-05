import { readCrewBoard, type CrewAim, type CrewBoard, type CrewScanner, type CrewScanPolicy,
  type EnemySensingState } from './bot-crew-spotting.js';
import {
  VEHICLE, vehicleDefinition, CREATURE_DEFS, LOCK_RANGE, LOCK_LOCKED, BOT_AA_LAUNCH_INTERVAL,
  mulberry32, clamp, TAU, wrapAngle, WORLD,
  quantYaw, unquantYaw, quantPitch, unquantPitch,
  viewDir, WEAPONS, TICK_DT, TICK_RATE,
  PLAYER, NET, BTN, PICKUP_HEALTH, PICKUP_AMMO, PICKUP_WEAPON, probeGroundBelowPoint, type InputCmd, type WeaponAmmo,
} from '@shared/index';
import type { Game, ServerPlayer, ServerPickup, ServerVehicle } from './game.js';
import type { Creature } from './wildlife.js';
import type { CampaignOrder, Territory } from '@shared/frontier';
import { campaignCaveExitRoute, campaignRoadRoute, type CampaignWaypoint } from './bot-navigation.js';
import { vehicleCourseBlocked } from './bot-vehicle-clearance.js';
import { walkingHullClearance } from './bot-walk-clearance.js';
import { GroundDetour, supportedTerrainRise } from './bot-ground-navigation.js';
import { DeckNavigation } from './bot-deck-navigation.js';
import { botCampaignRole, botRoleId, campaignTravelOrders as travelOrders } from './bot-campaign-state.js';
export { botCampaignRole, botRoleId } from './bot-campaign-state.js';

// Server-side bots. They produce InputCmds and go through the exact same
// input pipeline as human players, so they continuously exercise movement,
// collision, lag comp and weapons - and give a lone player something to shoot.

export interface BallisticVec3 {
  x: number;
  y: number;
  z: number;
}

export interface BallisticIntercept {
  direction: BallisticVec3;
  /** Seconds from launch until the predicted intercept. */
  time: number;
  yaw: number;
  pitch: number;
}

export interface BallisticInterceptParams {
  origin: BallisticVec3;
  target: BallisticVec3;
  targetVelocity: BallisticVec3;
  speed: number;
  gravity: number;
  /** Distance in front of `origin` at which the projectile is spawned. */
  muzzleOffset?: number;
  /** Latest permitted intercept time, bounded by aiming policy. */
  maxTime: number;
}

/**
 * Solve a fixed-speed ballistic intercept against a linearly moving target.
 *
 * The projectile starts `muzzleOffset` metres along its launch direction and
 * then follows constant downward acceleration. The resulting equation is a
 * quartic for a moving target. Sampling it into sign brackets and bisecting
 * those brackets is inexpensive at bot scale, finds both low and high arcs,
 * and is considerably less fragile near maximum range than iterative lead.
 */
export function solveBallisticIntercept(params: BallisticInterceptParams): BallisticIntercept[] {
  const {
    origin, target, targetVelocity,
    speed, gravity, maxTime,
  } = params;
  const muzzleOffset = Math.max(0, params.muzzleOffset ?? 0);
  if (
    !(speed > 0) || !(maxTime > 0) || !(gravity >= 0) ||
    !finiteVec(origin) || !finiteVec(target) || !finiteVec(targetVelocity)
  ) {
    return [];
  }

  const residual = (t: number): number => {
    const rx = target.x + targetVelocity.x * t - origin.x;
    const ry = target.y + targetVelocity.y * t - origin.y + 0.5 * gravity * t * t;
    const rz = target.z + targetVelocity.z * t - origin.z;
    const travel = muzzleOffset + speed * t;
    return rx * rx + ry * ry + rz * rz - travel * travel;
  };

  // Half-tick sampling comfortably brackets the two ordinary roots. Retain a
  // minimum density for callers using a short custom maxTime in unit tests.
  const samples = Math.max(96, Math.ceil(maxTime / (TICK_DT * 0.5)));
  const roots: number[] = [];
  let loT = 1e-5;
  let loF = residual(loT);

  for (let i = 1; i <= samples; i++) {
    const hiT = maxTime * i / samples;
    const hiF = residual(hiT);

    if (Number.isFinite(loF) && Number.isFinite(hiF)) {
      if (loF === 0) addRoot(roots, loT);
      if (hiF === 0) addRoot(roots, hiT);
      if ((loF < 0 && hiF > 0) || (loF > 0 && hiF < 0)) {
        let a = loT, b = hiT;
        let fa = loF;
        for (let j = 0; j < 42; j++) {
          const mid = (a + b) * 0.5;
          const fm = residual(mid);
          if ((fa < 0 && fm > 0) || (fa > 0 && fm < 0)) {
            b = mid;
          } else {
            a = mid;
            fa = fm;
          }
        }
        addRoot(roots, (a + b) * 0.5);
      }
    }
    loT = hiT;
    loF = hiF;
  }

  const out: BallisticIntercept[] = [];
  for (const time of roots) {
    const rx = target.x + targetVelocity.x * time - origin.x;
    const ry = target.y + targetVelocity.y * time - origin.y + 0.5 * gravity * time * time;
    const rz = target.z + targetVelocity.z * time - origin.z;
    const len = Math.sqrt(rx * rx + ry * ry + rz * rz);
    if (!(len > 1e-8)) continue;
    const direction = { x: rx / len, y: ry / len, z: rz / len };
    out.push({
      direction,
      time,
      yaw: Math.atan2(-direction.x, -direction.z),
      pitch: Math.atan2(direction.y, Math.hypot(direction.x, direction.z)),
    });
  }
  return out;
}

function finiteVec(v: BallisticVec3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

function addRoot(roots: number[], t: number): void {
  if (!(t > 0) || !Number.isFinite(t)) return;
  if (roots.some((r) => Math.abs(r - t) < 1e-4)) return;
  roots.push(t);
}

export interface BallisticTerrain {
  trace(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxDist: number,
    computeNormal?: boolean,
  ): { hit: boolean; dist: number };
}

export interface BallisticClearanceParams {
  origin: BallisticVec3;
  direction: BallisticVec3;
  speed: number;
  gravity: number;
  muzzleOffset: number;
  flightTime: number;
  projectileRadius: number;
}

/**
 * Validate the quantized launch direction with conservative two-tick chords.
 * The small radius inflation covers the maximum gravitational sag between a
 * two-tick chord and the authoritative one-tick chords. Any terrain contact
 * rejects this direct arc so bots do not blindly fire artillery into cave
 * walls.
 */
export function ballisticArcClear(
  terrain: BallisticTerrain,
  params: BallisticClearanceParams,
): boolean {
  const {
    origin, direction, speed, gravity,
    muzzleOffset, flightTime, projectileRadius,
  } = params;
  if (
    !(speed > 0) || !(flightTime > 0) || gravity < 0 ||
    !finiteVec(origin) || !finiteVec(direction)
  ) {
    return false;
  }

  const pointAt = (t: number): BallisticVec3 => {
    const travel = muzzleOffset + speed * t;
    return {
      x: origin.x + direction.x * travel,
      y: origin.y + direction.y * travel - 0.5 * gravity * t * t,
      z: origin.z + direction.z * travel,
    };
  };

  // Check the short muzzle offset too. The server intentionally spawns there,
  // but a bot should not fire if that spawn point is already behind terrain.
  let previous = origin;
  let t = 0;
  const spawn = pointAt(0);
  if (!traceSegmentClear(terrain, previous, spawn, projectileRadius)) return false;
  previous = spawn;

  const traceStep = TICK_DT * 2;
  const chordSag = gravity * traceStep * traceStep / 8;
  const clearanceRadius = projectileRadius + chordSag + 0.01;
  while (t < flightTime - 1e-9) {
    t = Math.min(flightTime, t + traceStep);
    const next = pointAt(t);
    if (!traceSegmentClear(terrain, previous, next, clearanceRadius)) return false;
    previous = next;
  }
  return true;
}

/**
 * Chord distance consumed by the authoritative 60Hz projectile integrator.
 * Ballistic flight time cannot be bounded by range / launchSpeed: ascent slows
 * the projectile, so a valid high arc may remain airborne longer while still
 * consuming less than its path budget.
 */
export function ballisticPathDistance(
  direction: BallisticVec3,
  speed: number,
  gravity: number,
  flightTime: number,
): number {
  if (
    !finiteVec(direction) ||
    !(speed > 0) ||
    !(gravity >= 0) ||
    !(flightTime >= 0)
  ) {
    return Infinity;
  }
  let vx = direction.x * speed;
  let vy = direction.y * speed;
  let vz = direction.z * speed;
  let remaining = flightTime;
  let distance = 0;
  while (remaining > 1e-9) {
    const dt = Math.min(TICK_DT, remaining);
    const sx = vx * dt;
    const sy = vy * dt - 0.5 * gravity * dt * dt;
    const sz = vz * dt;
    distance += Math.sqrt(sx * sx + sy * sy + sz * sz);
    vy -= gravity * dt;
    remaining -= dt;
  }
  return distance;
}

function traceSegmentClear(
  terrain: BallisticTerrain,
  a: BallisticVec3,
  b: BallisticVec3,
  radius: number,
): boolean {
  const sx = b.x - a.x, sy = b.y - a.y, sz = b.z - a.z;
  const len = Math.sqrt(sx * sx + sy * sy + sz * sz);
  if (len < 1e-9) return true;
  const th = terrain.trace(a.x, a.y, a.z, sx / len, sy / len, sz / len, len + radius, false);
  if (!th.hit) return true;
  return Math.max(0, th.dist - radius) > len;
}

const BOT_NAMES = [
  'Steven Seagull', 'Bruise Lee', 'Spruce Willis', 'Snackie Chan',
  'Jason Mimosa', 'Harrison Sword', 'John Lambo', 'Duck Norris',
  'Sylvester Calzone', 'Lint Eastwood', 'Rat Damon', 'Tom Booze',
  'Roger Boar', 'Russell Dough', 'Orlando Broom',
];

const SIDEARM_WEAPON = 0;
const PULSE_RIFLE_WEAPON = 1;
const SCATTERGUN_WEAPON = 2;
const ROCKET_WEAPON = 3;
const GRENADE_WEAPON = 4;
const GRENADE_MIN_RANGE = 60;
const GRENADE_PREFERRED_MIN = 100;
const GRENADE_PREFERRED_MAX = 330;
const GRENADE_MAX_RANGE = 370;
const GRENADE_MAX_FLIGHT_TIME = 12;
/** Long artillery traces are expensive; 200 ms remains modest beside an 11.5 m blast. */
const GRENADE_PLAN_TICKS = 12;
const BOT_ACQUIRE_RANGE = 390;
/** Enemies this close are engaged even when they are not on the march route. */
const MARCH_ENGAGE_RANGE = 120;
/** First shot at a newly acquired soldier waits 0.3–0.65 s. */
const BOT_REACTION_MIN_TICKS = 18;
const BOT_REACTION_SPREAD_TICKS = 21;
/** Aim settles from 2.4× to 1× its miss radius over 1.2 s of tracking. */
const BOT_AIM_SETTLE_TICKS = 72;
/** Faction AA teams share a short firing slot, preserving a jet's escape window. */
const antiAirShots = new WeakMap<Game, Map<number, number>>();
const vehicleClaims = new WeakMap<Game, Map<number, {player:number;until:number}>>();
const passengerClaims = new WeakMap<Game, Map<number, {player:number;until:number}>>();

interface BotCombatState {
  ammo?: WeaponAmmo[];
  reloadWeapon?: number;
  reloadCd?: number;
  reloadHeld?: boolean;
}

function combatState(player: ServerPlayer): BotCombatState {
  return player as ServerPlayer & BotCombatState;
}

function weaponAmmo(player: ServerPlayer, weapon: number): WeaponAmmo {
  return combatState(player).ammo?.[weapon] ?? {
    magazine: WEAPONS[weapon]?.magazineSize ?? 1,
    reserve: WEAPONS[weapon]?.reserveSize ?? 0,
  };
}

function weaponLoaded(player: ServerPlayer, weapon: number): boolean {
  return weaponAmmo(player, weapon).magazine > 0;
}

function weaponHasAmmo(player: ServerPlayer, weapon: number): boolean {
  const ammo = weaponAmmo(player, weapon);
  return WEAPONS[weapon]?.infiniteReserve === true ||
    ammo.magazine > 0 ||
    ammo.reserve > 0;
}

function weaponCanReload(player: ServerPlayer, weapon: number): boolean {
  const ammo = weaponAmmo(player, weapon);
  const def = WEAPONS[weapon];
  return !!def &&
    ammo.magazine < def.magazineSize &&
    (def.infiniteReserve === true || ammo.reserve > 0);
}

function activeReloadWeapon(player: ServerPlayer): number {
  return combatState(player).reloadWeapon ?? -1;
}

function reloadInputHeld(player: ServerPlayer): boolean {
  return combatState(player).reloadHeld ?? false;
}

function weaponCoversDistance(
  weapon: number,
  dist: number,
  grenadeMaxRange = GRENADE_MAX_RANGE,
): boolean {
  if (!Number.isFinite(dist)) return true;
  if (weapon === GRENADE_WEAPON) {
    return dist >= GRENADE_MIN_RANGE && dist <= grenadeMaxRange;
  }
  const def = WEAPONS[weapon];
  return !!def && dist <= def.range;
}

interface GrenadeAim {
  yaw: number;
  pitch: number;
}

export function botName(i: number): string {
  const base = BOT_NAMES[i % BOT_NAMES.length];
  return i < BOT_NAMES.length ? base : `${base}-${Math.floor(i / BOT_NAMES.length) + 1}`;
}

export class Bot {
  private rng: () => number;
  private seq = 0;

  private targetX = 0;
  private targetZ = 0;
  private repathAtTick = 0;

  private strafeDir = 1;
  private strafeFlipAt = 0;
  private fireCycleAt = 0;
  private firing = false;

  private stuckCheckAt = 0;
  private stuckX = 0;
  private stuckZ = 0;

  private weaponPickAt = 0;
  private weapon = 0;

  private enemyId = -1;
  private aimTargetId = -1;
  private aimSince = 0;
  private fireReadyAt = 0;
  private losCheckAt = 0;
  private losOk = false;
  private losCursor = 0;
  private losStarted = false;
  private remotePerception = false;
  private perception: { alive:boolean;vehicle:number;hull:number;seat:number;health:number;regen:number;hullHealth:number;hurtUntil:number;
    target:number;targetHull:number;targetVehicle:number;targetFaction:number } | undefined;
  private readonly losObstructions = new Map<number, { fraction: number; x: number; y: number; z: number; tick: number }>();
  private seekCheckAt = 0;

  private lastUseTick = -1e9;
  private enterScanAt = 0;
  private reverseUntil = -1;
  private grenadeAim: GrenadeAim | null = null;
  private grenadeAimEnemyId = -1;
  private grenadeAimUntil = 0;
  private wasAlive = true;
  private pickupId = -1;
  private pickupWeapon = -1;
  private pickupScanAt = 0;
  private pickupUntil = 0;
  private failedPickupId = -1;
  private failedPickupUntil = 0;
  private vehicleGoal = -1;
  private failedVehicleId = -1;
  private failedVehicleUntil = 0;
  private obstacleScanAt = 0;
  private avoidUntil = 0;
  private avoidDir = 1;
  private flightGround = 0;
  private boardedHull = -1;
  private pickupWaitUntil = 0;
  private pickupWaitAgainAt = 0;
  private passengerScanAt = 0;
  private boardingPassenger = -1;
  private disembarkedUntil = 0;
  private disembarkedTarget = '';
  private aaScanAt = 0;
  private aaTargetId = -1;
  private aaUntil = 0;
  private creatureScanAt = 0;
  private creatureTargetId = -1;
  private evasiveUntil = 0;
  private evasionAgainAt = 0;
  private evasiveSign = 1;
  private routeGoal = '';
  private route: readonly CampaignWaypoint[] = [];
  private routeIndex = 0;
  private navigationAt = 0;
  private airliftScanAt = 0;
  private airliftSource = -1;
  private airliftDestination = -1;
  private readonly walkSafety=new DeckNavigation();
  private walkDeckLegacy=true;
  private walkScanAt = 0;
  private walkAvoidUntil = 0;
  private walkAvoidYaw = 0;
  private walkProgress: { x:number; z:number; best:number; at:number; seen:number } | undefined;
  private walkEscape: { goal:string; points:readonly CampaignWaypoint[]; index:number; until:number } | undefined;
  private readonly groundDetour = new GroundDetour();
  private navalRoute: readonly {x:number;z:number}[] = [];
  private navalGoal = '';
  private navalIndex = 0;
  private navalDirection = 1;
  private vehicleSupportAhead = true;
  private campaignState: { order?: CampaignOrder; objective: Territory | null } | undefined;
  private readonly companionOrders = new Map<number, CampaignOrder | undefined>();
  private lastThought: InputCmd | undefined;
  private thoughtTick = -1;
  private crewSpotting: CrewBoard | undefined;
  private crewRevision = -1;
  private readonly crewScanner: CrewScanner = (game,spotter,state,policy) => this.acquireEnemyWith(game,spotter,state,policy);

  private vehicleEnemy(game:Game):CrewAim|null {
    return this.crewSpotting ? this.crewSpotting.observation : this.acquireEnemy(game);
  }

  get intent() { return {pickupId:this.pickupId,vehicleId:this.vehicleGoal,x:this.targetX,z:this.targetZ}; }

  constructor(readonly player: ServerPlayer, seed: number) {
    this.rng = mulberry32(seed ^ Math.imul(player.id % 0x1_0000_0000, 7919));
    this.weapon = player.weapon;
  }

  /** An expedition still uses the ordinary road, vehicle and combat brain
   * while gathering at a physical orbital terminal. */
  setTravelWaypoint(point: {id:string;x:number;y:number;z:number} | null): void {
    this.invalidateThought();
    this.walkProgress = this.walkEscape = undefined;
    this.groundDetour.clear(0);
    if (!point) { travelOrders.delete(this.player); return; }
    const objective: Territory = { ...point, baseId: point.id, name: 'Orbital rendezvous', kind: 'relay',
      radius: 3, owner: this.player.faction, influence: 1, contested: false };
    travelOrders.set(this.player, { objective, order: { baseId: point.id, targetId: point.id,
      name: 'Assemble orbital expedition', x: point.x, z: point.z, phase: 'attack',
      squad: Math.floor((botRoleId(this.player)-1)/18), staging: {x:point.x,y:point.y,z:point.z} } });
    this.routeGoal = ''; this.enterScanAt = 0;
  }

  invalidateThought(): void { this.lastThought = undefined; }

  /** Cheap live promotion runs before cached input can return. This changes
   * remote visibility latency only; weapon traces and physics stay current. */
  private refreshPerception(game:Game):boolean {
    const p=this.player,s=p.state,previous=this.perception;
    const eligible=game.remoteGroundPerception?.(p,BOT_ACQUIRE_RANGE)===true;
    if(!eligible&&!previous){this.remotePerception=false;return false;}
    const enemy=this.enemyId>=0?game.players.get(this.enemyId):undefined,es=enemy?.state;
    const dx=es?es.px-s.px:0,dy=es?es.py-s.py:0,dz=es?es.pz-s.pz:0;
    const invalid=this.enemyId>=0&&(!enemy||!es!.alive||!game.areEnemies(p,enemy)||
      p.vehicleId>=0&&enemy.vehicleId===p.vehicleId||!(dx*dx+dy*dy+dz*dz<BOT_ACQUIRE_RANGE**2));
    const remote=eligible&&(!enemy||!invalid&&enemy.isBot&&!enemy.airlift&&!es!.airlift&&
      es!.vehicle!==VEHICLE.JET&&es!.vehicle!==VEHICLE.GUNBOAT&&
      Number.isFinite(es!.vx+es!.vy+es!.vz)&&es!.vx**2+es!.vy**2+es!.vz**2<=100**2&&dx*dx+dz*dz>=20**2);
    const hullHealth=game.vehicles.get(p.vehicleId)?.health??0;
    const lifecycle=!!previous&&(previous.alive!==s.alive||previous.vehicle!==s.vehicle||previous.hull!==p.vehicleId||previous.seat!==(s.seat??0));
    const damage=!!previous&&(p.health<previous.health||p.regenBlockUntil>previous.regen||hullHealth<previous.hullHealth);
    // A first remote hit wakes immediately. Sustained fire uses ordinary LOS
    // deadlines until a full second without new damage, rather than tracing
    // faster than the baseline every time an MG advances the regen deadline.
    const damageWake=damage&&game.tick>=previous!.hurtUntil;
    const hurtUntil=damage?game.tick+TICK_RATE:previous?.hurtUntil??-1;
    const targetChanged=!!previous&&previous.target===this.enemyId&&!!enemy&&
      (previous.targetHull!==enemy.vehicleId||previous.targetVehicle!==es!.vehicle||previous.targetFaction!==enemy.faction);
    const wake=!!previous&&(!remote||lifecycle||damageWake||invalid||targetChanged);
    this.remotePerception=remote&&game.tick>=hurtUntil;
    if(invalid||lifecycle){this.enemyId=-1;this.losOk=false;this.losObstructions.clear();}
    if(wake)this.losCheckAt=game.tick;
    if(remote){
      const record=this.perception??={alive:s.alive,vehicle:s.vehicle,hull:p.vehicleId,seat:s.seat??0,health:p.health,regen:p.regenBlockUntil,hullHealth,hurtUntil,
        target:this.enemyId,targetHull:enemy?.vehicleId??-1,targetVehicle:es?.vehicle??0,targetFaction:enemy?.faction??0};
      record.alive=s.alive;record.vehicle=s.vehicle;record.hull=p.vehicleId;record.seat=s.seat??0;
      record.health=p.health;record.regen=p.regenBlockUntil;record.hullHealth=hullHealth;record.hurtUntil=hurtUntil;
      record.target=this.enemyId;record.targetHull=enemy?.vehicleId??-1;record.targetVehicle=es?.vehicle??0;record.targetFaction=enemy?.faction??0;
    }else this.perception=undefined;
    return wake;
  }

  think(game: Game): InputCmd {
    const previousCrew=this.crewSpotting;
    const crew=readCrewBoard(game,this.player,BOT_ACQUIRE_RANGE,this.crewScanner);
    const crewWake=crew!==previousCrew || !!crew&&crew.revision!==this.crewRevision;
    if(crew!==previousCrew){
      this.enemyId=-1;this.losOk=false;this.losCheckAt=game.tick;this.losStarted=false;
      this.losObstructions.clear();this.perception=undefined;this.remotePerception=false;
    }
    this.crewSpotting=crew;
    if(crew){
      this.enemyId=crew.observation?.id??-1;this.losOk=!!crew.observation;
      this.losCheckAt=crew.nextScanAt;this.perception=undefined;this.remotePerception=false;
    }
    const perceptionWake=crew?false:this.refreshPerception(game);
    const travelState=this.player.state;
    const travelTarget=this.walkSafety.goal?.kind==='pickup'?game.pickups.get(Number(this.walkSafety.goal.id)):
      this.walkSafety.goal?.kind==='vehicle'?game.vehicles.get(Number(this.walkSafety.goal.id)):undefined;
    const walkingWake=this.walkSafety.wake(travelState,game.tick,travelTarget,game.world);
    if(!travelState.alive||travelState.vehicle!==VEHICLE.NONE||this.player.airlift||travelState.airlift)this.walkSafety.reset();
    const thoughtEdges=BTN.USE|BTN.RELOAD|BTN.DODGE|(this.player.state.swimming?0:BTN.JUMP);
    if (!crewWake && !perceptionWake && !walkingWake && this.lastThought && this.thoughtTick !== game.tick && this.wasAlive === this.player.state.alive &&
      !(this.lastThought.buttons & thoughtEdges) && game.shouldThinkBot?.(this.player) === false) return this.lastThought;
    this.thoughtTick = game.tick;
    const command=this.thinkFresh(game);
    if(this.perception){
      const enemy=game.players.get(this.enemyId);
      this.perception.target=this.enemyId;this.perception.targetHull=enemy?.vehicleId??-1;
      this.perception.targetVehicle=enemy?.state.vehicle??0;this.perception.targetFaction=enemy?.faction??0;
    }
    this.crewRevision=crew?.revision??-1;
    return this.lastThought = command;
  }

  private thinkFresh(game: Game): InputCmd {
    this.campaignState = undefined;
    this.companionOrders.clear();
    const p = this.player;
    const s = p.state;
    const tick = game.tick;
    if(!s.alive||s.vehicle!==VEHICLE.NONE||p.airlift||s.airlift)this.groundDetour.clear(tick);
    if(this.stuckCheckAt===0){this.stuckCheckAt=tick+54;this.stuckX=s.px;this.stuckZ=s.pz;}
    let buttons = 0;
    let yaw = p.lastCmd ? p.lastCmd.yaw : 0;
    let pitch = 0;

    if (s.alive && !this.wasAlive) {
      this.weapon = p.weapon;
      this.weaponPickAt = 0;
      this.grenadeAim = null;
      this.grenadeAimEnemyId = -1;
      this.grenadeAimUntil = 0;
      this.losObstructions.clear();
      this.firing = false;
      this.fireCycleAt = tick + 12;
      this.pickupId = this.vehicleGoal = -1;
      this.pickupScanAt = this.enterScanAt = 0;
      this.repathAtTick = 0;
      this.boardedHull = -1;
      this.disembarkedUntil = this.aaUntil = 0;
      this.routeGoal = '';
      this.walkProgress = this.walkEscape = undefined;
      this.airliftSource = this.airliftDestination = -1;
      this.stuckCheckAt=tick+90;this.stuckX=s.px;this.stuckZ=s.pz;
      this.failedVehicleId=this.failedPickupId=-1;
    }

    const reloadAtStart = activeReloadWeapon(p);
    const wasReloading = reloadAtStart >= 0;
    if (wasReloading) this.weapon = p.weapon;

    // ---- Vehicles: keep driving an occupied hull.
    if (s.alive && s.vehicle !== VEHICLE.NONE) {
      this.walkProgress = this.walkEscape = undefined;
      const drive = this.driveVehicle(game, tick);
      this.wasAlive = s.alive;
      this.seq++;
      return {
        seq: this.seq,
        buttons: drive.buttons,
        weapon: this.weapon,
        yaw: unquantYaw(quantYaw(drive.yaw)),
        pitch: unquantPitch(quantPitch(clamp(drive.pitch, -1.4, 1.4))),
        renderTick: Math.max(0, tick - NET.INTERP_TICKS),
        renderFrac: 0,
      };
    }

    if (s.alive) {
      if(p.airlift || s.airlift) {
        this.wasAlive=true;
        return {seq:++this.seq,buttons:0,weapon:this.weapon,yaw,pitch:0,renderTick:Math.max(0,tick-NET.INTERP_TICKS),renderFrac:0};
      }
      const enemy = this.acquireEnemy(game);
      if(enemy)this.groundDetour.clear(tick);
      const enemyDistance = enemy ? Math.hypot(enemy.state.px-s.px,enemy.state.pz-s.pz) : Infinity;
      // Creatures are local obstacles and threats, never campaign objectives.
      const creature = this.acquireCreature(game);
      const reaction = creature && (!enemy || Math.hypot(creature.x-s.px,creature.z-s.pz)<Math.min(18,enemyDistance))
        ? this.defendAgainstCreature(game,creature)
        : enemyDistance>30 ? this.antiAir(game) : null;
      if (reaction) {
        this.walkSafety.reset();
        this.groundDetour.clear(tick);
        this.wasAlive=s.alive;
        return {seq:++this.seq,buttons:reaction.buttons,weapon:this.weapon,
          yaw:unquantYaw(quantYaw(reaction.yaw)),pitch:unquantPitch(quantPitch(clamp(reaction.pitch,-1.4,1.4))),
          renderTick:Math.max(0,tick-NET.INTERP_TICKS),renderFrac:0};
      }
      const duty=botCampaignRole(botRoleId(p));
      const dutyVehicle=duty==='pilot'||duty==='aircrew'?VEHICLE.JET:duty==='sailor'||duty==='navalcrew'?VEHICLE.GUNBOAT:0;
      const replacement=game.frontier && dutyVehicle && [...game.vehicles.values()].find(v=>v.type===dutyVehicle &&
        v.campaignFaction===p.faction && v.respawnAtTick>=0 && v.campaignHome &&
        Math.hypot(v.campaignHome.x-s.px,v.campaignHome.z-s.pz)<80);
      if(replacement) {
        this.vehicleGoal=-1;this.wasAlive=true;
        this.stuckCheckAt=tick+90;this.stuckX=s.px;this.stuckZ=s.pz;
        return {seq:++this.seq,buttons:0,weapon:this.weapon,yaw,pitch:0,renderTick:Math.max(0,tick-NET.INTERP_TICKS),renderFrac:0};
      }
      const boardingDuty=!!game.frontier && dutyVehicle!==0 && [...game.vehicles.values()].some(v=>v.type===dutyVehicle &&
        v.respawnAtTick<0 && v.campaignFaction===p.faction && Math.hypot(v.x-s.px,v.z-s.pz)<120 &&
        (v.occupant<0 || (v.gunner??-1)<0));
      // Assigned flight/naval crews board before browsing a nearby ammo
      // cache; otherwise the pilot departs while the gunner is still looting.
      const pickup = boardingDuty ? null : this.seekPickup(game,tick);
      const pickupDetour = !!pickup && (!enemy || (enemyDistance>45 && Math.hypot(pickup.x-s.px,pickup.z-s.pz)<32));
      const routePickup = !enemy || pickupDetour ? pickup : null;
      // A visible opponent is the usual arena state. Take nearby armor during
      // that fight instead of waiting for a rare completely peaceful moment.
      // Keep close firefights local and preserve an already short approach.
      const boardingRange = enemyDistance > 35 ? Math.min(55,enemyDistance*.55) : 12;
      const vehicleInput = enemy && !pickupDetour ? this.maybeEnterVehicle(game,tick,boardingRange) : 0;
      const detour = pickupDetour || this.vehicleGoal >= 0 || (vehicleInput & BTN.USE) !== 0;
      if (enemy && !detour) {
        this.walkSafety.reset();
        const ex = enemy.state.px - s.px;
        const ey = (enemy.state.py + 1.2) - (s.py + PLAYER.EYE_HEIGHT);
        const ez = enemy.state.pz - s.pz;
        const distXZ = Math.sqrt(ex * ex + ez * ez);
        const dist = Math.sqrt(ex * ex + ey * ey + ez * ez);

        // Burst fire with pauses so bots are beatable.
        if (tick >= this.fireCycleAt) {
          this.firing = !this.firing;
          this.fireCycleAt = tick + Math.floor((this.firing ? 30 : 18) + this.rng() * 20);
        }

        const grenadeMaxRange = this.grenadeMaxRange(enemy);

        // Weapon choice by range and ammunition, re-evaluated occasionally.
        // Do not abandon an almost-complete reload just because the random
        // range scorer woke up this tick.
        if (!wasReloading && tick >= this.weaponPickAt) {
          this.weaponPickAt = tick + 120;
          this.weapon = this.chooseCombatWeapon(p, dist, grenadeMaxRange);
        }

        let reloadQueued = false;

        // An empty weapon never receives FIRE. Once a reload has begun, commit
        // to it: repeatedly cancelling a finite reload for another loaded gun
        // can livelock when that fallback is unsuitable for the current range.
        if (wasReloading) {
          this.weapon = p.weapon;
        } else if (!weaponLoaded(p, this.weapon)) {
          // Rechamber the one-shot grenade launcher while its target remains
          // inside the artillery envelope. If the fight has moved too close
          // or too far away, use an immediately useful loaded fallback.
          if (
            this.weapon === GRENADE_WEAPON &&
            weaponCoversDistance(
              GRENADE_WEAPON,
              dist,
              grenadeMaxRange,
            ) &&
            weaponCanReload(p, GRENADE_WEAPON)
          ) {
            reloadQueued = true;
            if (!reloadInputHeld(p)) buttons |= BTN.RELOAD;
            this.firing = false;
            this.fireCycleAt = tick + 12;
          } else {
            const fallback = this.loadedFallback(p, dist, this.weapon);
            if (fallback >= 0) {
              this.weapon = fallback;
              this.weaponPickAt = Math.min(this.weaponPickAt, tick + 60);
            } else {
              const reloadable = this.reloadableFallback(p, dist, this.weapon);
              if (reloadable >= 0) {
                this.weapon = reloadable;
                if (!reloadInputHeld(p)) {
                  buttons |= BTN.RELOAD;
                  reloadQueued = true;
                  this.firing = false;
                  this.fireCycleAt = tick + 12;
                }
              }
            }
          }
        }

        let grenadeReady = false;
        if (
          this.weapon === GRENADE_WEAPON &&
          !wasReloading &&
          !reloadQueued &&
          weaponLoaded(p, GRENADE_WEAPON)
        ) {
          if (dist < GRENADE_MIN_RANGE || dist > grenadeMaxRange) {
            this.grenadeAim = null;
          } else if (
            this.grenadeAimEnemyId !== enemy.id ||
            tick >= this.grenadeAimUntil
          ) {
            this.grenadeAim = this.planGrenadeAim(game, enemy);
            this.grenadeAimEnemyId = enemy.id;
            this.grenadeAimUntil = tick + GRENADE_PLAN_TICKS;
          }

          if (this.grenadeAim) {
            yaw = this.grenadeAim.yaw;
            pitch = this.grenadeAim.pitch;
            grenadeReady = true;
          } else {
            // Never lob at an unreachable or terrain-blocked target. Choose a
            // loaded, range-appropriate conventional fallback instead.
            const fallback = this.loadedFallback(p, dist, GRENADE_WEAPON);
            this.weapon = fallback >= 0 ? fallback : this.reloadableFallback(p, dist, GRENADE_WEAPON);
            if (this.weapon < 0) this.weapon = p.weapon;
            if (!weaponLoaded(p, this.weapon) &&
                weaponCanReload(p, this.weapon) &&
                !reloadInputHeld(p)) {
              buttons |= BTN.RELOAD;
              reloadQueued = true;
              this.firing = false;
              this.fireCycleAt = tick + 12;
            }
            this.weaponPickAt = Math.min(this.weaponPickAt, tick + 30);
          }
        }

        // A fresh target needs a human-like reaction before the first shot,
        // and aim tightens while the bot keeps tracking the same soldier.
        if (enemy.id !== this.aimTargetId) {
          this.aimTargetId = enemy.id; this.aimSince = tick;
          this.fireReadyAt = tick + BOT_REACTION_MIN_TICKS + Math.floor(this.rng() * BOT_REACTION_SPREAD_TICKS);
        }
        if (this.weapon !== GRENADE_WEAPON) {
          const settle = Math.min(1, (tick - this.aimSince) / BOT_AIM_SETTLE_TICKS);
          const targetSpeed = Math.min(1, Math.hypot(enemy.state.vx, enemy.state.vz) / PLAYER.RUN_SPEED);
          // Lateral miss radius in metres: a body-sized cone that widens
          // slowly with range, for a moving target and while unsettled.
          const miss = (0.5 + distXZ * 0.011) * (2.4 - 1.4 * settle) * (1 + targetSpeed * 0.35) * (this.player.state.grounded ? 1 : 1.5);
          const cone = miss / Math.max(4, dist);
          yaw = Math.atan2(-ex, -ez) + (this.rng() - 0.5) * 2 * cone;
          pitch = Math.atan2(ey, distXZ) + (this.rng() - 0.5) * 1.4 * cone;
        }
        const mayFire =
          !wasReloading &&
          !reloadQueued &&
          // Projectiles already give their target flight time to react.
          (tick >= this.fireReadyAt || WEAPONS[this.weapon]?.kind === 'projectile') &&
          weaponLoaded(p, this.weapon) &&
          (this.weapon !== GRENADE_WEAPON || grenadeReady);
        if (this.firing && mayFire) buttons |= BTN.FIRE;
        // Having opened fire on this soldier (e.g. with artillery), the bot has
        // already reacted; a weapon switch does not restart the reaction time.
        if (buttons & BTN.FIRE) this.fireReadyAt = Math.min(this.fireReadyAt, tick);

        // Movement while fighting. Attackers keep pushing onto their nearby
        // objective (that is how controls change hands); otherwise hold a
        // weapon-appropriate range and strafe instead of charging blindly.
        if (tick >= this.strafeFlipAt) {
          this.strafeDir = this.rng() < 0.5 ? -1 : 1;
          this.strafeFlipAt = tick + Math.floor(40 + this.rng() * 60);
        }
        const { objective: pushObjective } = this.campaign(game);
        const objectiveDistance = pushObjective ? Math.hypot(pushObjective.x - s.px, pushObjective.z - s.pz) : Infinity;
        const holding = !!pushObjective && objectiveDistance < (pushObjective.radius ?? 30) * .7;
        const [nearRange, farRange] = this.weapon === SCATTERGUN_WEAPON ? [5, 16] : this.weapon === SIDEARM_WEAPON ? [9, 30]
          : this.weapon === ROCKET_WEAPON ? [24, 75] : [12, 48];
        let wishX = 0, wishZ = 0;
        if (pushObjective && !holding && objectiveDistance < 240 && this.player.health > 30) {
          wishX = (pushObjective.x - s.px) / objectiveDistance; wishZ = (pushObjective.z - s.pz) / objectiveDistance;
        } else if (distXZ > farRange) { wishX = ex / distXZ; wishZ = ez / distXZ; }
        else if (distXZ < nearRange || this.player.health <= 30) { wishX = -ex / Math.max(1, distXZ); wishZ = -ez / Math.max(1, distXZ); }
        // Express the wish direction in the aim frame (forward = -sin/-cos yaw).
        const forwardAxis = -wishX * Math.sin(yaw) - wishZ * Math.cos(yaw), rightAxis = wishX * Math.cos(yaw) - wishZ * Math.sin(yaw);
        if (forwardAxis > .38) buttons |= BTN.FORWARD; else if (forwardAxis < -.38) buttons |= BTN.BACK;
        if (rightAxis > .38) buttons |= BTN.RIGHT; else if (rightAxis < -.38) buttons |= BTN.LEFT;
        if (!(buttons & (BTN.LEFT | BTN.RIGHT))) buttons |= this.strafeDir > 0 ? BTN.RIGHT : BTN.LEFT;

        if (this.rng() < 0.004) buttons |= BTN.JUMP;
        if (this.rng() < 0.006 && s.dodgeCd <= 0) buttons |= BTN.DODGE;
      } else {
        // Follow the resource approach, or seek toward the nearest human
        // (fall back to the nearest bot) so fights find the players.
        // NOTE: linear scan is fine at MVP scale; at thousands of players
        // this becomes a spatial-grid nearest query.
        if (!this.campaign(game).objective && !routePickup && this.vehicleGoal<0 && tick >= this.seekCheckAt) {
          this.seekCheckAt = tick + 150 + Math.floor(this.rng() * 60);
          let best: ServerPlayer | null = null;
          let bestD2 = Infinity;
          for (const q of game.players.values()) {
            if (!game.areEnemies(p, q) || !q.state.alive) continue;
            const dx = q.state.px - s.px, dz = q.state.pz - s.pz;
            let d2 = dx * dx + dz * dz;
            if (q.isBot) d2 *= 9; // strongly prefer humans
            if (d2 < bestD2) { bestD2 = d2; best = q; }
          }
          if (best) {
            // Head to a point near them, not on top of them.
            this.targetX = best.state.px + (this.rng() - 0.5) * 60;
            this.targetZ = best.state.pz + (this.rng() - 0.5) * 60;
            this.repathAtTick = tick + 20 * 60;
          }
        }
        const objective = this.campaign(game).objective;
        if (objective && !routePickup && this.vehicleGoal < 0) {
          this.campaignCourse(game,objective);
          this.repathAtTick = tick + 120;
        }
        // Wander between (seeked or random) ground points.
        const dx = this.targetX - s.px;
        const dz = this.targetZ - s.pz;
        if (!objective && (tick >= this.repathAtTick || dx * dx + dz * dz < 9)) {
          const ang = this.rng() * TAU;
          const r = 40 + this.rng() * 120;
          this.targetX = clamp(s.px + Math.cos(ang) * r, -WORLD.BORDER+150, WORLD.BORDER-150);
          this.targetZ = clamp(s.pz + Math.sin(ang) * r, -WORLD.BORDER+150, WORLD.BORDER-150);
          this.repathAtTick = tick + 12 * 60;
        }
        if(routePickup) {this.targetX=routePickup.x;this.targetZ=routePickup.z;this.repathAtTick=tick+120;}
        else buttons |= enemy ? vehicleInput : this.maybeEnterVehicle(game, tick);
        const airlift = objective && !routePickup && this.vehicleGoal<0 && !enemy ? this.seekAirlift(game,objective) : false;
        if(routePickup||this.vehicleGoal>=0||airlift||(buttons&BTN.USE)!==0)this.groundDetour.clear(tick);
        yaw = Math.atan2(-(this.targetX - s.px), -(this.targetZ - s.pz)) + (objective || routePickup || this.vehicleGoal>=0 ? 0 : (this.rng() - 0.5) * 0.2);
        const advancing = !airlift && Math.hypot(this.targetX-s.px,this.targetZ-s.pz)>(routePickup?0.5:this.groundDetour.active?1:3);
        if(!airlift) {
          this.walkDeckLegacy=!!objective&&!routePickup&&this.vehicleGoal<0;
          this.walkSafety.target(routePickup?'pickup':this.vehicleGoal>=0?'vehicle':'course',
            routePickup?.id??(this.vehicleGoal>=0?this.vehicleGoal:objective?.id??'wander'),this.targetX,this.targetZ);
          if(advancing)yaw=this.walkCourse(game,yaw);
          // Settled defenders need no forward clearance probes. On departure,
          // check the new course immediately instead of reviving an old detour.
          else {this.walkAvoidUntil=this.walkScanAt=0;this.walkSafety.reset();}
        }
        pitch = 0;
        if(advancing&&!this.walkSafety.hold)buttons |= BTN.FORWARD;
        if(this.walkSafety.abandon){
          if(routePickup){this.failedPickupId=routePickup.id;this.failedPickupUntil=tick+600;this.pickupId=-1;this.pickupUntil=0;this.pickupScanAt=tick+12;}
          if(this.vehicleGoal>=0){const id=this.vehicleGoal;this.failedVehicleId=id;this.failedVehicleUntil=tick+600;
            if(vehicleClaims.get(game)?.get(id)?.player===p.id)vehicleClaims.get(game)!.delete(id);
            if(passengerClaims.get(game)?.get(id)?.player===p.id)passengerClaims.get(game)!.delete(id);
            this.vehicleGoal=-1;this.enterScanAt=tick+12;}
          this.navigationAt=this.repathAtTick=0;this.route=[];this.routeIndex=0;this.walkSafety.reset();
          buttons&=~(BTN.FORWARD|BTN.JUMP|BTN.DODGE);
        }

        // Quiet moments are the right time to top off. If the current weapon
        // is completely dry, first move to a loaded general-purpose option;
        // otherwise queue one reload edge while continuing to navigate.
        if (!wasReloading) {
          if (!weaponHasAmmo(p, this.weapon)) {
            const fallback = this.loadedFallback(p, Infinity, this.weapon);
            if (fallback >= 0) this.weapon = fallback;
          }
          const ammo = weaponAmmo(p, this.weapon);
          const def = WEAPONS[this.weapon];
          const usefulPartial =
            !!def &&
            (def.infiniteReserve === true || ammo.reserve > 0) &&
            ammo.magazine < Math.ceil(def.magazineSize * 0.7);
          if (usefulPartial && !reloadInputHeld(p)) {
            buttons |= BTN.RELOAD;
            this.firing = false;
            this.fireCycleAt = tick + 12;
          }
          // Travel with a ready conventional weapon instead of acquiring
          // incidental rocket locks along the route. Finish topping off the
          // launcher first; combat and AA reactions select their own weapon.
          if (!enemy && this.weapon === ROCKET_WEAPON && weaponLoaded(p, ROCKET_WEAPON) &&
              !usefulPartial && !(buttons & BTN.RELOAD)) {
            const ready = weaponLoaded(p, PULSE_RIFLE_WEAPON) ? PULSE_RIFLE_WEAPON
              : weaponLoaded(p, SIDEARM_WEAPON) ? SIDEARM_WEAPON : -1;
            if (ready >= 0) {
              this.weapon = ready;
              this.weaponPickAt = tick;
            }
          }
        }

        // Stuck? Hop and consider a new target.
        if (tick >= this.stuckCheckAt) {
          const moved = Math.hypot(s.px - this.stuckX, s.pz - this.stuckZ);
          if (moved < 0.6 && s.grounded && (buttons&BTN.FORWARD)!==0 && (!this.walkSafety.lease||this.walkSafety.lease.mode==='wall')) {
            buttons |= BTN.JUMP;
            if(this.pickupId>=0){this.failedPickupId=this.pickupId;this.failedPickupUntil=tick+600;this.pickupId=-1;}
            if(this.vehicleGoal>=0){this.failedVehicleId=this.vehicleGoal;this.failedVehicleUntil=tick+600;this.vehicleGoal=-1;}
            if (this.rng() < 0.5) this.repathAtTick = 0;
          }
          this.stuckX = s.px;
          this.stuckZ = s.pz;
          this.stuckCheckAt = tick + 54;
        }
      }
    }

    this.wasAlive = s.alive;
    this.seq++;
    // Grenade plans already contain wire-quantized angles. Quantizing all
    // paths here remains harmless and preserves the bot/client input invariant.
    return {
      seq: this.seq,
      buttons,
      weapon: this.weapon,
      yaw: unquantYaw(quantYaw(yaw)),
      pitch: unquantPitch(quantPitch(clamp(pitch, -1.4, 1.4))),
      renderTick: Math.max(0, tick - NET.INTERP_TICKS),
      renderFrac: 0,
    };
  }

  private acquireCreature(game: Game): Creature | null {
    const creatures=game.wildlife?.creatures;
    if(!creatures)return null;
    const s=this.player.state;
    const eligible=(c:Creature):boolean=>{
      const def=CREATURE_DEFS[c.species];
      if(!def || def.damage<=0 || c.health<=0 || c.dead || c.deadUntil>0)return false;
      if(def.temperament==='defensive' && !c.alert)return false;
      // Stay with the squad. A visible monster across the valley is scenery
      // until it attacks or physically blocks this bot's immediate route.
      return Math.hypot(c.x-s.px,c.z-s.pz)<(c.alert?42:14)+def.radius && Math.abs(c.y-s.py)<12+def.height;
    };
    let retained=creatures.get(this.creatureTargetId);
    if(game.tick<this.creatureScanAt)return retained&&eligible(retained)?retained:null;
    this.creatureScanAt=game.tick+18+(this.player.id%5);
    this.creatureTargetId=-1;
    const candidates=[...creatures.values()].filter(eligible).sort((a,b)=>
      Math.hypot(a.x-s.px,a.z-s.pz)-Math.hypot(b.x-s.px,b.z-s.pz));
    for(const c of candidates.slice(0,2)) {
      const def=CREATURE_DEFS[c.species],dx=c.x-s.px,dy=c.y+def.height*.55-s.py-PLAYER.EYE_HEIGHT,dz=c.z-s.pz;
      const distance=Math.hypot(dx,dy,dz),hit=game.world.trace(s.px,s.py+PLAYER.EYE_HEIGHT,s.pz,dx/distance,dy/distance,dz/distance,distance,false);
      if(!hit.hit || hit.dist>distance-def.radius) {this.creatureTargetId=c.id;return c;}
    }
    return null;
  }

  private defendAgainstCreature(game:Game,creature:Creature):{buttons:number;yaw:number;pitch:number} {
    const p=this.player,s=p.state,def=CREATURE_DEFS[creature.species];
    const dx=creature.x-s.px,dy=creature.y+def.height*.55-s.py-PLAYER.EYE_HEIGHT,dz=creature.z-s.pz,distance=Math.hypot(dx,dz);
    const reloading=activeReloadWeapon(p)>=0;
    if(reloading)this.weapon=p.weapon;
    else this.weapon=([distance<14?SCATTERGUN_WEAPON:PULSE_RIFLE_WEAPON,PULSE_RIFLE_WEAPON,SIDEARM_WEAPON].find(w=>weaponHasAmmo(p,w)))??SIDEARM_WEAPON;
    let buttons=distance<Math.max(def.radius+8,(def.reach??1.7)+4)?BTN.BACK:0;
    if((creature.windupUntil??0)>game.tick && distance<(def.reach??1.7)+3 && s.dodgeCd<=0)buttons|=BTN.DODGE;
    if(!reloading) {
      if(weaponLoaded(p,this.weapon))buttons|=BTN.FIRE;
      else if(weaponCanReload(p,this.weapon)&&!reloadInputHeld(p))buttons|=BTN.RELOAD;
    }
    // Never advance toward wildlife: local defense must not turn the whole
    // faction into a boss-hunting party or drag it away from the control point.
    return {buttons,yaw:Math.atan2(-dx,-dz),pitch:Math.atan2(dy,distance)};
  }

  /** Dedicated AA sentries aim steadily for the real two-second lock. Range
   * jitter and artillery selection in the infantry brain would never lock. */
  private antiAir(game:Game):{buttons:number;yaw:number;pitch:number}|null {
    const p=this.player,s=p.state,tick=game.tick;
    if(!game.vehicles || !weaponHasAmmo(p,ROCKET_WEAPON))return null;
    // Every third soldier carries AA duty; other members keep capturing and
    // covering the squad while it tracks aircraft.
    if(game.frontier?Math.floor(Math.max(0,botRoleId(p)-1)/3)%3!==1:p.id%3!==1)return null;
    if(tick>=this.aaScanAt) {
      this.aaScanAt=tick+18+(p.id%7);
      this.aaTargetId=-1;
      const candidates=[...game.players.values()].filter(q=>{
        if(!q.state.alive||q.state.vehicle!==VEHICLE.JET||q.state.seat===1||!game.areEnemies(p,q))return false;
        const hull=game.vehicles.get(q.vehicleId);
        return hull?.occupant===q.id && hull.respawnAtTick<0 && hull.health>0 &&
          Math.hypot(q.state.px-s.px,q.state.py-s.py,q.state.pz-s.pz)<LOCK_RANGE-15;
      }).sort((a,b)=>Math.hypot(a.state.px-s.px,a.state.pz-s.pz)-Math.hypot(b.state.px-s.px,b.state.pz-s.pz));
      for(const q of candidates.slice(0,2)) {
        const radius=vehicleDefinition(q.state.vehicle,q.state.vehicleVariant)!.radius;
        const dx=q.state.px-s.px,dy=q.state.py+radius-s.py-PLAYER.EYE_HEIGHT,dz=q.state.pz-s.pz,distance=Math.hypot(dx,dy,dz);
        if(distance<18)continue;
        const hit=game.world.trace(s.px,s.py+PLAYER.EYE_HEIGHT,s.pz,dx/distance,dy/distance,dz/distance,distance,false);
        if(!hit.hit||hit.dist>distance-radius-.5){this.aaTargetId=q.id;this.aaUntil=tick+150;break;}
      }
    }
    const target=game.players.get(this.aaTargetId);
    if(!target || !target.state.alive || target.state.vehicle!==VEHICLE.JET || tick>this.aaUntil)return null;
    let slots=antiAirShots.get(game);if(!slots){slots=new Map();antiAirShots.set(game,slots);}
    if((slots.get(target.vehicleId)??0)>tick)return null;
    this.weapon=activeReloadWeapon(p)>=0?p.weapon:ROCKET_WEAPON;
    const radius=vehicleDefinition(target.state.vehicle,target.state.vehicleVariant)!.radius;
    const dx=target.state.px-s.px,dy=target.state.py+radius-s.py-PLAYER.EYE_HEIGHT,dz=target.state.pz-s.pz;
    let buttons=0;
    if(activeReloadWeapon(p)<0) {
      if(!weaponLoaded(p,ROCKET_WEAPON)) {if(!reloadInputHeld(p))buttons|=BTN.RELOAD;}
      else if(p.lockState===LOCK_LOCKED && p.lockVehicleId===target.vehicleId && p.fireCd<=0) {
        buttons|=BTN.FIRE;slots.set(target.vehicleId,tick+BOT_AA_LAUNCH_INTERVAL);
      }
    }
    return {buttons,yaw:Math.atan2(-dx,-dz),pitch:Math.atan2(dy,Math.hypot(dx,dz))};
  }

  /** Resolve lazily at the same point the brain first needs its order. A foot
   * approach, driver and flight controller can each ask more than once, but
   * the strategy and actor state cannot change within this think invocation. */
  private campaign(game: Game): { order?: CampaignOrder; objective: Territory | null } {
    if (this.campaignState) return this.campaignState;
    const travel = travelOrders.get(this.player);
    if (travel) return this.campaignState = travel;
    const frontier = game.frontier, order = frontier?.order(this.player);
    return this.campaignState = { order, objective: frontier?.territories.find(site => site.id === order?.targetId) ?? null };
  }

  /** A distant firefight must not indefinitely pull a marching squad away
   * from its assignment. Fight immediate threats and clear the approach to
   * the assigned control; mounted crews can still fire while travelling. */
  private campaignThreat(game: Game, enemy: ServerPlayer): boolean {
    const { order, objective } = this.campaign(game);
    if (!objective) return true;
    const s = this.player.state, e = enemy.state;
    const ex = e.px - s.px, ez = e.pz - s.pz, distance = Math.hypot(ex, ez);
    // Soldiers fight what they run into on the march; the combat movement
    // keeps pushing toward a nearby objective while they do.
    if (distance <= MARCH_ENGAGE_RANGE) return true;
    if (this.player.regenBlockUntil > game.tick && distance < 200) return true;
    const destination = order?.phase === 'assemble' ? order.staging : objective;
    const dx = destination.x - s.px, dz = destination.z - s.pz, remaining = Math.hypot(dx, dz);
    const defenseRadius = Math.max(100, (objective.radius ?? 30) + 75);
    if (remaining < defenseRadius + 150 && Math.hypot(e.px - destination.x, e.pz - destination.z) < defenseRadius) return true;
    const ahead = remaining > 1 ? (ex * dx + ez * dz) / remaining : 0;
    const lateral = remaining > 1 ? Math.abs(ex * dz - ez * dx) / remaining : distance;
    return distance < 140 && ahead > 0 && ahead < remaining && lateral < 45;
  }

  private companionOrder(game: Game, player: ServerPlayer): CampaignOrder | undefined {
    if (player.id === this.player.id) return this.campaign(game).order;
    if (!this.companionOrders.has(player.id)) this.companionOrders.set(player.id, travelOrders.get(player)?.order ?? game.frontier?.order(player));
    return this.companionOrders.get(player.id);
  }

  /** Seats are shared by soldiers travelling to the same operation. A
   * nearby convoy heading to another region is not a useful ride. */
  private sharesOperation(game: Game, player: ServerPlayer): boolean {
    if (!player.isBot || !game.frontier) return true;
    const own = this.campaign(game).order, other = this.companionOrder(game, player);
    return !own || !other || own.targetId === other.targetId || (!!own.baseId && own.baseId === other.baseId);
  }

  private claimPlayer(game: Game, claims: Map<number, {player:number;until:number}> | undefined, hull: number): ServerPlayer | undefined {
    const claim = claims?.get(hull), player = claim && game.players.get(claim.player);
    return claim && claim.until > game.tick && player?.state.alive && player.faction === this.player.faction &&
      (player.state.vehicle === VEHICLE.NONE || player.vehicleId === hull) ? player : undefined;
  }

  /** Only a matching recruit can delay a convoy. Seat reservations avoid
   * several nearby drivers waiting for the same soldier, while the fallback
   * scan is staggered and bounded for large campaign populations. */
  private pickupPassenger(game: Game, hull: ServerVehicle, range: number): ServerPlayer | null {
    if ((hull.gunner ?? -1) >= 0 || hull.transportRoute) return null;
    const s = this.player.state;
    const reachable = (q: ServerPlayer | undefined): q is ServerPlayer => !!q && q.id !== this.player.id &&
      q.faction !== 0 && q.faction === this.player.faction && q.state.alive && q.state.vehicle === VEHICLE.NONE &&
      Math.abs(q.state.py - s.py) < 8 && (q.state.px - s.px) ** 2 + (q.state.pz - s.pz) ** 2 < range ** 2;
    const claims = passengerClaims.get(game), reserved = this.claimPlayer(game, claims, hull.id);
    if (reachable(reserved)) return this.sharesOperation(game, reserved) ? reserved : null;
    if (game.tick < this.passengerScanAt) {
      const retained = game.players.get(this.boardingPassenger);
      return reachable(retained) ? retained : null;
    }
    this.passengerScanAt = game.tick + 30 + this.player.id % 7;
    const candidates: ServerPlayer[] = [];
    for (const q of game.players.values()) if (reachable(q)) candidates.push(q);
    candidates.sort((a, b) => (a.state.px-s.px)**2+(a.state.pz-s.pz)**2 - ((b.state.px-s.px)**2+(b.state.pz-s.pz)**2));
    const candidate = candidates.slice(0,4).find(q => {
      if (claims) for (const [id, claim] of claims) if (id !== hull.id && claim.player === q.id && claim.until > game.tick) return false;
      return this.sharesOperation(game,q);
    });
    this.boardingPassenger = candidate?.id ?? -1;
    return candidate ?? null;
  }

  private campaignCourse(game:Game,objective:{id?:string;x:number;y?:number;z:number;radius?:number}):void {
    const p=this.player,s=p.state,tick=game.tick;
    const order=this.campaign(game).order;
    const destination=order?.phase==='assemble'?order.staging:objective;
    const angle=(Math.floor(Math.max(0,botRoleId(p)-1)/3)%6)*TAU/6,spread=Math.min(12,(objective.radius??32)*.4);
    const goal={x:destination.x+Math.sin(angle)*spread,y:destination.y,z:destination.z+Math.cos(angle)*spread};
    const key=`${objective.id??''}:${Math.round(goal.x/24)},${Math.round(goal.z/24)}`;
    const groundKey=`${objective.id??''}:${order?.phase}:${goal.x},${goal.z}`;
    if(s.vehicle===VEHICLE.NONE&&this.groundDetour.active){
      const next=this.groundDetour.follow(game.world,s,groundKey,tick);
      if(next){this.targetX=next.x;this.targetZ=next.z;return;}
      this.walkProgress=undefined;this.walkAvoidUntil=this.walkScanAt=0;
    }
    if (s.vehicle === VEHICLE.NONE && this.walkEscape) {
      const escape = this.walkEscape;
      if (escape.goal === key && tick < escape.until) {
        while (escape.index < escape.points.length && Math.hypot(s.px-escape.points[escape.index].x,s.pz-escape.points[escape.index].z) < 4) escape.index++;
        if (escape.index < escape.points.length) {
          this.targetX=escape.points[escape.index].x;this.targetZ=escape.points[escape.index].z;
          return;
        }
      }
      this.walkEscape=undefined;this.walkProgress=undefined;
      this.route=[];this.routeIndex=0;this.navigationAt=0;
    }
    if(tick>=this.navigationAt || this.routeGoal!==key) {
      this.navigationAt=tick+360+(p.id%6)*12;
      if(this.routeGoal!==key || this.routeIndex>=this.route.length ||
        Math.hypot(s.px-(this.route[this.routeIndex]?.x??s.px),s.pz-(this.route[this.routeIndex]?.z??s.pz))>350) {
        this.routeGoal=key;
        this.route=typeof game.world.collectRoadSegments==='function'?campaignRoadRoute(game.world,{x:s.px,y:s.py,z:s.pz},goal):[];
        this.routeIndex=0;
        // Shared cache may start behind this member of a moving squad.
        let best=Infinity;
        if(!this.route[0]?.street)for(let i=0;i<this.route.length;i++) {const d=Math.hypot(this.route[i].x-s.px,this.route[i].z-s.pz);if(d<best){best=d;this.routeIndex=i;}}
      }
    }
    // Narrow city bridge turns need the actor to reach the actual corner.
    // A vehicle's ordinary speed-scaled lookahead cuts diagonally into void.
    const reach=this.route[this.routeIndex]?.street?5:s.vehicle===VEHICLE.NONE?10:Math.max(14,Math.hypot(s.vx,s.vz)*.8);
    while(this.routeIndex<this.route.length && Math.hypot(this.route[this.routeIndex].x-s.px,this.route[this.routeIndex].z-s.pz)<reach)this.routeIndex++;
    const waypoint=this.route[this.routeIndex]??goal;
    this.targetX=waypoint.x;this.targetZ=waypoint.z;
    if (s.vehicle !== VEHICLE.NONE) { this.walkProgress=undefined; return; }
    const distance=Math.hypot(s.px-waypoint.x,s.pz-waypoint.z),progress=this.walkProgress;
    if (!progress || tick-progress.seen>60 || Math.hypot(progress.x-waypoint.x,progress.z-waypoint.z)>2 || distance<8) {
      this.walkProgress={x:waypoint.x,z:waypoint.z,best:distance,at:tick,seen:tick};
      return;
    }
    progress.seen=tick;
    // Side-to-side motion can pass the ordinary stuck-distance check while
    // making no progress toward the same route point for several seconds.
    if (distance<progress.best-4) { progress.best=distance;progress.at=tick; }
    if (tick-progress.at<180) return;
    progress.at=tick;
    const points=campaignCaveExitRoute(game.world,{x:s.px,y:s.py,z:s.pz},goal);
    if (!points.length) {
      if(!s.swimming&&this.groundDetour.begin(game.world,s,waypoint,groundKey,progress.best,tick)){
        const next=this.groundDetour.follow(game.world,s,groundKey,tick);
        if(next){this.targetX=next.x;this.targetZ=next.z;this.walkAvoidUntil=this.walkScanAt=0;}
      }
      return;
    }
    this.walkEscape={goal:key,points,index:0,until:tick+1200};
    this.walkAvoidUntil=this.walkScanAt=0;
    this.targetX=points[0].x;this.targetZ=points[0].z;
  }

  private walkCourse(game:Game,yaw:number):number {
    const s=this.player.state;
    const ordinaryCourse=this.walkDeckLegacy;
    if(this.groundDetour.active||this.walkEscape||s.swimming||!s.grounded||s.jumpAscent||s.boosting||s.submerged){
      this.walkSafety.reset();return ordinaryCourse?this.walkCourseLegacy(game,yaw):yaw;
    }
    const checked=this.walkSafety.steer(game.world,s,yaw,game.tick,this.player.id%2?1:-1);
    return checked??(ordinaryCourse?this.walkCourseLegacy(game,yaw):yaw);
  }
  private walkCourseLegacy(game:Game,yaw:number):number {
    const s=this.player.state,tick=game.tick;
    // campaignCourse has already checked this committed edge against live
    // hulls and the bounded support scan. Do not replace it with a new side.
    if(this.groundDetour.active)return yaw;
    const hullClear=walkingHullClearance(game.world,s,tick);
    const current=tick<this.walkAvoidUntil?this.walkAvoidYaw:yaw;
    if(hullClear(current)){
      if(tick<this.walkAvoidUntil)return this.walkAvoidYaw;
      if(tick<this.walkScanAt)return yaw;
    }
    this.walkScanAt=tick+24+(this.player.id%5);
    const clear=(heading:number):boolean=>{
      if(!hullClear(heading))return false;
      const d=viewDir(heading,0),distance=4;
      const hit=game.world.trace(s.px,s.py+1.05,s.pz,d.x,0,d.z,distance,false);
      if(hit.hit&&hit.dist<distance)return !s.swimming&&!this.walkEscape&&supportedTerrainRise(game.world,s,heading,hit,tick);
      const x=s.px+d.x*distance,z=s.pz+d.z*distance;
      if(s.swimming){
        const fluid=game.world.liquidAt(x,s.py+.72,z);
        if(fluid?.kind==='water'&&fluid.surfaceY-fluid.bottomY>.8)return true;
      }
      const floor=game.world.trace(x,s.py+2,z,0,-1,0,7);
      return floor.hit && floor.ny>.5 && !game.world.liquidAt(x,floor.y+.2,z);
    };
    if(clear(yaw))return yaw;
    const side=this.player.id%2?1:-1;
    for(const turn of [.7,-.7,1.4,-1.4,2.1,-2.1,Math.PI])if(clear(yaw+turn*side)) {
      this.walkAvoidYaw=yaw+turn*side;this.walkAvoidUntil=tick+32;return this.walkAvoidYaw;
    }
    return yaw;
  }

  /** Ferries already have validated water lanes; gunboats patrol those same
   * channels instead of attempting a straight-line shortcut across land. */
  private navalCourse(game:Game,objective:{x:number;z:number}):boolean {
    const s=this.player.state;
    const goal=`${Math.round(objective.x/32)},${Math.round(objective.z/32)}`;
    if(goal!==this.navalGoal){this.navalGoal=goal;this.navalRoute=[];this.navalIndex=0;}
    if(!this.navalRoute.length) {
      let best=Infinity;
      for(const route of game.world.collectTransportPlan().routes)if(route.kind==='ferry')for(const leg of route.legs) {
        for(let i=0;i<leg.points.length;i++) {
          const point=leg.points[i],approach=Math.hypot(point.x-s.px,point.z-s.pz);
          if(approach>300)continue;
          const first=leg.points[0],last=leg.points[leg.points.length-1];
          const firstDistance=Math.hypot(first.x-objective.x,first.z-objective.z),lastDistance=Math.hypot(last.x-objective.x,last.z-objective.z);
          const score=approach+Math.min(firstDistance,lastDistance)*.08;
          if(score<best){best=score;this.navalRoute=leg.points;this.navalIndex=i;this.navalDirection=lastDistance<firstDistance?1:-1;}
        }
      }
    }
    if(!this.navalRoute.length)return false;
    let point=this.navalRoute[this.navalIndex];
    if(Math.hypot(point.x-s.px,point.z-s.pz)<24) {
      if(this.navalIndex+this.navalDirection<0 || this.navalIndex+this.navalDirection>=this.navalRoute.length)this.navalDirection*=-1;
      this.navalIndex=Math.max(0,Math.min(this.navalRoute.length-1,this.navalIndex+this.navalDirection));
      point=this.navalRoute[this.navalIndex];
    }
    this.targetX=point.x;this.targetZ=point.z;return true;
  }

  private seekAirlift(game:Game,objective:{x:number;z:number}):boolean {
    const p=this.player,s=p.state,tick=game.tick;
    if(p.airlift || s.airlift)return true;
    if(Math.hypot(objective.x-s.px,objective.z-s.pz)<850){this.airliftSource=this.airliftDestination=-1;return false;}
    if(tick>=this.airliftScanAt) {
      this.airliftScanAt=tick+240+(p.id%9)*8;
      const pods=game.world.collectTransportPlan().pods;
      this.airliftSource=this.airliftDestination=-1;
      let best=Math.hypot(objective.x-s.px,objective.z-s.pz)-400;
      for(const source of pods) {
        const approach=Math.hypot(source.x-s.px,source.z-s.pz);
        if(approach>280 || Math.abs(source.y-s.py)>12)continue;
        for(const destination of pods) {
          if(source.id===destination.id)continue;
          const cost=approach+Math.hypot(destination.x-objective.x,destination.z-objective.z);
          if(cost<best){best=cost;this.airliftSource=source.id;this.airliftDestination=destination.id;}
        }
      }
    }
    if(this.airliftSource<0)return false;
    const source=game.world.collectTransportPlan().pods.find(pod=>pod.id===this.airliftSource);
    if(!source)return false;
    this.targetX=source.x;this.targetZ=source.z;
    if(Math.hypot(source.x-s.px,source.y-s.py,source.z-s.pz)<3) {
      return game.requestAirlift(p,this.airliftDestination);
    }
    return false;
  }

  private beginVehicleRecovery(tick:number,reverseTicks=24):void {
    // A new forward obstruction cannot restart the backing phase while an
    // existing maneuver is still turning. Otherwise 18-tick probes renew a
    // 24-tick straight reverse forever, with no chance to face a clear route.
    if(tick<this.avoidUntil)return;
    // Consecutive attempts at the same obstruction keep making the same
    // turn instead of cancelling each other out on a slow tank or boat.
    if(this.avoidUntil===0||tick-this.avoidUntil>60)this.avoidDir=this.rng()<.5?-1:1;
    this.reverseUntil=tick+reverseTicks;
    this.avoidUntil=this.reverseUntil+61;
  }

  /** Vehicle steering follows the assigned operation independently from
   * weapon aim. A separate flight controller handles aircraft attitude. */
  private driveVehicle(
    game: Game,
    tick: number,
  ): { buttons: number; yaw: number; pitch: number } {
    const p = this.player;
    const s = p.state;
    let buttons = 0;
    let yaw = s.heading;
    let pitch = 0;

    const hull = game.vehicles?.get(p.vehicleId);
    const def = vehicleDefinition(s.vehicle,s.vehicleVariant)!;
    const {order,objective}=this.campaign(game);
    const speed=Math.hypot(s.vx,s.vz);
    // City streets and entrances are infantry spaces. Deploy outside the
    // dense blocks, where jeeps become useful rally vehicles and armor can
    // cover the last approach instead of wedging a whole squad in a doorway.
    const deploymentRadius=objective?.kind==='city'?250:Math.max(18,(objective?.radius??24)*.75);
    const atObjective=order?.phase!=='assemble' && !!objective&&Math.hypot(objective.x-s.px,objective.z-s.pz)<deploymentRadius;
    if(this.boardedHull!==p.vehicleId) {
      this.boardedHull=p.vehicleId;this.pickupWaitUntil=tick+720;this.pickupWaitAgainAt=tick+1500;
      this.passengerScanAt=0;this.boardingPassenger=-1;
      this.routeGoal='';this.repathAtTick=0;
      this.reverseUntil=-1;this.avoidUntil=0;this.obstacleScanAt=0;
      this.vehicleSupportAhead=true;
    }
    if (hull && def && hull.health < def.maxHealth * 0.18 &&
        tick - this.lastUseTick > 90) {
      this.lastUseTick = tick;
      return { buttons: BTN.USE, yaw, pitch };
    }
    if(atObjective && speed<4 && s.vehicle!==VEHICLE.JET && s.vehicle!==VEHICLE.GUNBOAT &&
      (s.vehicle===VEHICLE.JEEP || s.seat===1 || travelOrders.has(p)) && tick-this.lastUseTick>150) {
      // Explicit expedition rendezvous/arrival duties require infantry at
      // the destination. Ordinary armor orders still park the driver in
      // cover, but that would prevent an orbital squad from ever charging.
      this.lastUseTick=tick;this.disembarkedUntil=tick+3600;this.disembarkedTarget=objective?.id??'';
      return {buttons:BTN.USE,yaw,pitch};
    }
    if((s.seat??0)>0) {
      const target=this.vehicleEnemy(game);
      const creature=this.acquireCreature(game);
      if(!target && creature) {
        const dx=creature.x-s.px,dz=creature.z-s.pz;
        return {buttons:BTN.FIRE,yaw:Math.atan2(-dx,-dz),pitch:Math.atan2(creature.y+CREATURE_DEFS[creature.species].height*.55-s.py-def.radius,Math.hypot(dx,dz))};
      }
      if(!target)return {buttons:0,yaw,pitch};
      const dx=target.state.px-s.px,dz=target.state.pz-s.pz;
      return {buttons:BTN.FIRE,yaw:Math.atan2(-dx,-dz),pitch:Math.atan2(target.state.py-s.py,Math.hypot(dx,dz))};
    }
    if(s.vehicle===VEHICLE.JET) {
      // Aircraft need the same boarding pause as ground transports, before
      // the flight controller opens the throttle and leaves the runway.
      if(hull && (hull.gunner??-1)<0 && speed<7 && tick<this.pickupWaitUntil &&
        (s.grounded || probeGroundBelowPoint(game.world,s.px,s.py+def.radius,s.pz,def.radius+1.2)) &&
        this.pickupPassenger(game,hull,60))
        return {buttons:0,yaw,pitch};
      return this.flyJet(game,tick);
    }

    const enemy = this.vehicleEnemy(game);
    let courseYaw=yaw;
    if (enemy) {
      const ex = enemy.state.px - s.px;
      const ey = (enemy.state.py + 1.2) - (s.py + def.radius + 0.9);
      const ez = enemy.state.pz - s.pz;
      const dist = Math.hypot(ex, ey, ez);
      yaw = Math.atan2(-ex, -ez);
      if (s.vehicle === VEHICLE.TANK) {
        // Crude ballistic hold-over for the cannon's arc.
        pitch = Math.atan2(ey, Math.hypot(ex, ez)) + dist * 0.0022;
        if (dist > 24) buttons |= BTN.FORWARD;
        if (dist < 340 && this.losOk) buttons |= BTN.FIRE;
        if (dist > 90 && dist < 320 && this.rng() < 0.015) buttons |= BTN.ALTFIRE;
      } else {
        pitch = Math.atan2(ey, Math.hypot(ex, ez));
        if (dist > 20) buttons |= BTN.FORWARD;
        if (dist < 250 && this.losOk) buttons |= BTN.FIRE;
        if (dist > 160 && this.rng() < 0.03) buttons |= BTN.ALTFIRE; // boost
      }
      // Refresh the shared LOS cache used by the on-foot brain.
      if (tick >= this.losCheckAt) {
        this.losCheckAt = tick + 12;
        const oy = s.py + def.radius + 0.9;
        const th = game.world.trace(
          s.px, oy, s.pz,
          ex / dist, ey / dist, ez / dist, dist, false,
        );
        this.losOk = !th.hit;
      }
    } else {
      // Follow the squad's campaign order, using the graded road network.
      const dx = this.targetX - s.px;
      const dz = this.targetZ - s.pz;
      const naval=!!objective && s.vehicle===VEHICLE.GUNBOAT && this.navalCourse(game,objective);
      if(objective && s.vehicle!==VEHICLE.GUNBOAT)this.campaignCourse(game,objective);
      else if (!naval && (tick >= this.repathAtTick || dx * dx + dz * dz < 160)) {
        const ang = this.rng() * TAU;
        const r = 120 + this.rng() * 240;
        this.targetX = clamp(s.px + Math.cos(ang) * r, -WORLD.BORDER+150, WORLD.BORDER-150);
        this.targetZ = clamp(s.pz + Math.sin(ang) * r, -WORLD.BORDER+150, WORLD.BORDER-150);
        this.repathAtTick = tick + 15 * 60;
      }
      yaw = Math.atan2(-(this.targetX - s.px), -(this.targetZ - s.pz));
      buttons |= BTN.FORWARD;
      if (s.vehicle === VEHICLE.JEEP && this.rng() < 0.02 && !objective) buttons |= BTN.ALTFIRE;
      const creature=this.acquireCreature(game);
      if(creature) {
        courseYaw=yaw;
        const ex=creature.x-s.px,ez=creature.z-s.pz;
        yaw=Math.atan2(-ex,-ez);pitch=Math.atan2(creature.y+CREATURE_DEFS[creature.species].height*.55-s.py-def.radius-.9,Math.hypot(ex,ez));
        if(s.vehicle!==VEHICLE.TANK || Math.hypot(ex,ez)>16)buttons|=BTN.FIRE;
      } else courseYaw=yaw;
    }
    if(enemy) {
      courseYaw=yaw;
      // Weapons can cover a passing battle while the hull keeps moving to
      // the squad's actual assignment instead of pursuing every target.
      if(objective) {
        const navigating=s.vehicle!==VEHICLE.GUNBOAT || this.navalCourse(game,objective);
        if(s.vehicle!==VEHICLE.GUNBOAT)this.campaignCourse(game,objective);
        if(navigating){courseYaw=Math.atan2(s.px-this.targetX,s.pz-this.targetZ);buttons|=BTN.FORWARD;}
      }
    }
    if(order?.phase==='assemble' && s.vehicle!==VEHICLE.GUNBOAT && Math.hypot(s.px-order.staging.x,s.pz-order.staging.z)<28)
      return {buttons:buttons&BTN.FIRE,yaw,pitch};

    if(atObjective && objective && s.vehicle!==VEHICLE.GUNBOAT) {
      // Holding cover is a successful arrival, not a stuck convoy. Neutral
      // throttle uses the ordinary ground controller's braking drag in both
      // travel directions, without eventually accelerating into reverse.
      // Weapons keep their current aim/fire command and physics remains live.
      this.reverseUntil=-1;this.avoidUntil=0;this.obstacleScanAt=0;
      this.vehicleSupportAhead=true;
      this.stuckX=s.px;this.stuckZ=s.pz;this.stuckCheckAt=tick+60;
      buttons&=~(BTN.FORWARD|BTN.BACK|BTN.LEFT|BTN.RIGHT|BTN.ALTFIRE);
      return {buttons,yaw,pitch};
    }

    // Drivers leave room for approaching allies to board. The timeout keeps
    // an indecisive human or obstructed recruit from immobilizing a convoy.
    const nearbyPassenger=hull && this.pickupPassenger(game,hull,90);
    if(nearbyPassenger && (!enemy || Math.hypot(enemy.state.px-s.px,enemy.state.pz-s.pz)>65)) {
      if(tick>=this.pickupWaitAgainAt && speed<14){this.pickupWaitUntil=tick+300;this.pickupWaitAgainAt=tick+1200;}
      if(tick<this.pickupWaitUntil)return {buttons:buttons&BTN.FIRE,yaw,pitch};
    }
    // Ground hulls steer with A/D (the aim yaw only points the weapons),
    // so press toward the desired course with a small deadband.
    const forward=viewDir(s.heading,0),look=clamp(speed*.6+5,7,23);
    if(tick>=this.obstacleScanAt) {
      this.obstacleScanAt=tick+18;
      // Active recovery cannot accept another solid-obstacle decision.
      // Keep its live shore/edge checks below, but defer the eight unused
      // hull feelers until the maneuver can actually be reassessed.
      const blocked=tick>=this.avoidUntil && vehicleCourseBlocked(game.world,s.px,s.py,s.pz,s.heading,def.radius,look);
      const nx=s.px+forward.x*look,nz=s.pz+forward.z*look;
      this.vehicleSupportAhead=s.vehicle===VEHICLE.GUNBOAT ? game.world.liquidAt(nx,s.py,nz)?.kind==='water'
        : probeGroundBelowPoint(game.world,nx,s.py+2,nz,5);
      if(blocked||!this.vehicleSupportAhead)this.beginVehicleRecovery(tick);
    }

    // Stuck against a cliff: give one complete reverse/turn maneuver time to
    // finish before retrying. Position and shore/edge checks stay live.
    if (tick >= this.stuckCheckAt) {
      const moved = Math.hypot(s.px - this.stuckX, s.pz - this.stuckZ);
      if (moved < 0.8) {
        this.beginVehicleRecovery(tick,45);
        this.repathAtTick = 0;
      }
      this.stuckX = s.px;
      this.stuckZ = s.pz;
      this.stuckCheckAt = tick + 60;
    }
    let steerErr = tick<this.avoidUntil ? this.avoidDir*.9 : wrapAngle(courseYaw-s.heading);
    if (tick < this.reverseUntil) {
      buttons &= ~(BTN.FORWARD | BTN.ALTFIRE);
      buttons |= BTN.BACK;
      // Cars reverse their yaw response when actually rolling backward;
      // boats retain their steering sign. Keep turning toward one chosen
      // escape side throughout braking, backing and the forward turn.
      if(s.vehicle!==VEHICLE.GUNBOAT && s.vx*forward.x+s.vz*forward.z<-.5)steerErr=-steerErr;
    }
    if (steerErr > 0.06) buttons |= BTN.LEFT;
    else if (steerErr < -0.06) buttons |= BTN.RIGHT;
    if(Math.abs(steerErr)>1.1&&speed>7){buttons&=~BTN.FORWARD;buttons|=BTN.BACK;}
    // Completing a turn does not make a dry shore or unsupported edge safe.
    // Keep steering, but wait for fresh water/support before forward thrust;
    // a blocking wall with supported ground still permits the escape turn.
    if(!this.vehicleSupportAhead)buttons&=~BTN.FORWARD;
    return { buttons, yaw, pitch };
  }

  private flyJet(game:Game,tick:number):{buttons:number;yaw:number;pitch:number} {
    const p=this.player,s=p.state;
    let buttons=BTN.THROTTLE as number;
    if(tick>=this.obstacleScanAt) {
      this.obstacleScanAt=tick+24;
      const f=viewDir(s.heading,0),distance=140;
      this.flightGround=Math.max(game.world.terrainHeight(s.px,s.pz),game.world.terrainHeight(s.px+f.x*distance,s.pz+f.z*distance));
      const hit=game.world.trace(s.px,s.py+2,s.pz,f.x,0,f.z,distance,false);
      if(hit.hit)this.flightGround=Math.max(this.flightGround,s.py+90);
      if(!s.grounded && tick>=this.evasionAgainAt) {
        const incoming=[...game.projectiles.values()].find(rocket=>rocket.homingVehicleId===p.vehicleId &&
          Math.hypot(rocket.x-s.px,rocket.y-s.py,rocket.z-s.pz)<550);
        const tracked=[...game.players.values()].find(q=>game.areEnemies(p,q)&&q.lockVehicleId===p.vehicleId&&q.lockTicks>75);
        if(incoming||tracked) {
          const threat=incoming?{x:incoming.x,z:incoming.z}:{x:tracked!.state.px,z:tracked!.state.pz};
          this.evasiveSign=(threat.x-s.px)*f.z-(threat.z-s.pz)*f.x>0?1:-1;
          this.evasiveUntil=tick+150;this.evasionAgainAt=tick+330;
        }
      }
    }
    if(tick>=this.repathAtTick || Math.hypot(this.targetX-s.px,this.targetZ-s.pz)<130) {
      const objective=this.campaign(game).objective;
      if(objective && !s.grounded && s.py>this.flightGround+24) {
        const angle=Math.atan2(s.px-objective.x,s.pz-objective.z)+.95;
        this.targetX=objective.x+Math.sin(angle)*320;this.targetZ=objective.z+Math.cos(angle)*320;
        this.repathAtTick=tick+240;
      } else {
        const heading=s.heading+(s.grounded?0:(this.rng()-.5)*1.4),f=viewDir(heading,0);
        this.targetX=clamp(s.px+f.x*900,-WORLD.BORDER+650,WORLD.BORDER-650);
        this.targetZ=clamp(s.pz+f.z*900,-WORLD.BORDER+650,WORLD.BORDER-650);
        this.repathAtTick=tick+(objective?120:600);
      }
    }
    const heading=Math.atan2(s.px-this.targetX,s.pz-this.targetZ),courseError=wrapAngle(heading-s.heading);
    const evading=!s.grounded && tick<this.evasiveUntil;
    const targetBank=s.grounded?0:evading?this.evasiveSign*.95:clamp(courseError*.85,-.65,.65);
    const bankError=wrapAngle(targetBank-s.vehicleRoll);
    if(s.grounded){if(courseError>.06)buttons|=BTN.LEFT;else if(courseError<-.06)buttons|=BTN.RIGHT;}
    else if(bankError>.045)buttons|=BTN.LEFT;else if(bankError<-.045)buttons|=BTN.RIGHT;
    const targetPitch=clamp((this.flightGround+75-s.py)/170+(evading?.18:0),-.22,.38);
    if(evading && Math.abs(s.vehicleRoll)>.65 && s.vehiclePitch<.48)buttons|=BTN.BACK;
    else if(s.vehiclePitch<targetPitch-.028)buttons|=BTN.BACK;
    else if(s.vehiclePitch>targetPitch+.028)buttons|=BTN.FORWARD;
    const enemy=this.acquireEnemy(game);
    if(enemy) {
      const dx=enemy.state.px-s.px,dy=enemy.state.py-s.py,dz=enemy.state.pz-s.pz,dist=Math.hypot(dx,dy,dz),f=viewDir(s.heading,s.vehiclePitch);
      if(dist>15&&dist<390&&(dx*f.x+dy*f.y+dz*f.z)/dist>.988)buttons|=BTN.FIRE;
      if(Math.hypot(dx,dz)<55&&-dy>32&&Math.abs(s.vehicleRoll)<.35)buttons|=BTN.ALTFIRE;
    }
    return {buttons,yaw:s.heading,pitch:s.vehiclePitch};
  }

  /** Short visible resource goals; no per-frame raycasts or global path search. */
  private seekPickup(game:Game,tick:number):ServerPickup|null {
    if(!game.pickups)return null;
    const p=this.player,s=p.state;
    const useful=(pk:ServerPickup):boolean=>{
      if(pk.availableAtTick>tick || pk.expiresAtTick<=tick)return false;
      if(pk.kind===PICKUP_HEALTH)return p.health<85;
      const def=WEAPONS[pk.weapon],ammo=p.ammo?.[pk.weapon];
      if(!def || !ammo)return false;
      return pk.kind===PICKUP_WEAPON ? !!def.spawnEmpty&&ammo.magazine<def.magazineSize :
        pk.kind===PICKUP_AMMO&&!def.infiniteReserve&&ammo.magazine+ammo.reserve<def.magazineSize+def.reserveSize;
    };
    const current=game.pickups.get(this.pickupId);
    if(current && tick<this.pickupUntil && useful(current))return current;
    if(this.pickupId>=0 && this.pickupWeapon>=0 && p.ammo?.[this.pickupWeapon]?.magazine>0){this.weapon=this.pickupWeapon;this.weaponPickAt=0;}
    this.pickupId=-1;
    if(tick<this.pickupScanAt)return null;
    this.pickupScanAt=tick+45+(p.id%7)*3;
    const candidates:{pickup:ServerPickup;score:number}[]=[];
    for(const pk of game.pickups.values()) {
      if(pk.id===this.failedPickupId&&tick<this.failedPickupUntil || !useful(pk))continue;
      const distance=Math.hypot(pk.x-s.px,pk.z-s.pz);
      if(distance>95 || Math.abs(pk.y-s.py)>9)continue;
      const priority=pk.kind===PICKUP_WEAPON?4:pk.kind===PICKUP_HEALTH?1+(100-p.health)/20:1;
      candidates.push({pickup:pk,score:priority/(distance+12)});
    }
    candidates.sort((a,b)=>b.score-a.score||a.pickup.id-b.pickup.id);
    for(const {pickup:pk}of candidates.slice(0,2)) {
      const dx=pk.x-s.px,dy=pk.y+.5-s.py-PLAYER.EYE_HEIGHT,dz=pk.z-s.pz,len=Math.hypot(dx,dy,dz);
      if(len>2){const hit=game.world.trace(s.px,s.py+PLAYER.EYE_HEIGHT,s.pz,dx/len,dy/len,dz/len,len,false);if(hit.hit&&hit.dist<len-.7)continue;}
      this.pickupId=pk.id;this.pickupWeapon=pk.weapon;this.pickupUntil=tick+Math.ceil((len/PLAYER.RUN_SPEED+3)/TICK_DT);
      return pk;
    }
    return null;
  }

  /** Approach an available allied seat and board through the normal USE command. */
  private maybeEnterVehicle(game: Game, tick: number, maxDistance?: number): number {
    const p=this.player,s=p.state,{order,objective}=this.campaign(game);
    const remaining=objective?Math.hypot(objective.x-s.px,objective.z-s.pz):Infinity;
    const longTrip=!!objective && remaining>350;
    if(tick<this.disembarkedUntil && (!longTrip || objective?.id===this.disembarkedTarget))return 0;
    if(tick-this.lastUseTick<120 || !game.vehicles)return 0;
    const role=botCampaignRole(botRoleId(p)),searchDistance=maxDistance??(longTrip?260:170);
    let claims=vehicleClaims.get(game);if(!claims){claims=new Map();vehicleClaims.set(game,claims);}
    let passengers=passengerClaims.get(game);if(!passengers){passengers=new Map();passengerClaims.set(game,passengers);}
    const driver=(v:ServerVehicle):ServerPlayer|undefined=>v.occupant>=0?game.players.get(v.occupant):this.claimPlayer(game,claims,v.id);
    const crewDuty=(v:ServerVehicle):boolean=>!!game.frontier && v.campaignFaction===p.faction &&
      ((role==='aircrew'&&v.type===VEHICLE.JET)||(role==='navalcrew'&&v.type===VEHICLE.GUNBOAT));
    const available=(v:ServerVehicle):boolean=>{
      if(v.respawnAtTick>=0 || v.health<vehicleDefinition(v.type,v.variant)!.maxHealth*.4)return false;
      if(game.frontier && v.campaignFaction && v.campaignFaction!==p.faction)return false;
      if(v.id===this.failedVehicleId && tick<this.failedVehicleUntil)return false;
      if(objective && order?.phase!=='assemble' && remaining<objective.radius+30 &&
        (v.type===VEHICLE.JEEP||v.type===VEHICLE.TANK))return false;
      const pilot=driver(v);
      if(pilot && pilot.id!==p.id) {
        const reserved=this.claimPlayer(game,passengers,v.id);
        return pilot.faction!==0 && pilot.faction===p.faction && pilot.state.alive && this.sharesOperation(game,pilot) &&
          (!reserved || reserved.id===p.id) && (v.gunner??-1)<0 && !v.transportRoute &&
          Math.hypot(pilot.state.vx,pilot.state.vz)<(v.type===VEHICLE.JET?7:14);
      }
      if(v.occupant>=0)return false;
      if(crewDuty(v)) {
        const reserved=this.claimPlayer(game,passengers,v.id);
        return !reserved || reserved.id===p.id;
      }
      if(game.frontier) {
        if(role==='infantry' && !(longTrip && v.type===VEHICLE.JEEP))return false;
        if(role==='aircrew'||role==='navalcrew')return false;
        if(v.type===VEHICLE.JET && role!=='pilot')return false;
        if(v.type===VEHICLE.GUNBOAT && role!=='sailor')return false;
      } else {
        if(p.id%3===0)return false;
        if(v.type===VEHICLE.JET && p.id%4!==0)return false;
      }
      return true;
    };
    const release=(id:number)=>{
      if(claims!.get(id)?.player===p.id)claims!.delete(id);
      if(passengers!.get(id)?.player===p.id)passengers!.delete(id);
    };
    const approach=(v:ServerVehicle):number=>{
      if(this.vehicleGoal!==v.id)release(this.vehicleGoal);
      this.vehicleGoal=v.id;this.targetX=v.x;this.targetZ=v.z;this.repathAtTick=tick+180;
      const def=vehicleDefinition(v.type,v.variant)!,pilot=driver(v);
      const riding=(pilot && pilot.id!==p.id)||crewDuty(v);
      (riding?passengers!:claims!).set(v.id,{player:p.id,until:tick+180});
      // Rendezvous beside the reserved hull before the driver boards; a
      // passenger must not accidentally steal its driver's seat via USE.
      if(riding && v.occupant<0) {
        if(Math.hypot(v.x-s.px,v.z-s.pz)<def.enterRange-.3){this.targetX=s.px;this.targetZ=s.pz;}
        return 0;
      }
      if(Math.hypot(v.x-s.px,v.z-s.pz)<def.enterRange-.3 && Math.abs(v.y-s.py)<def.radius+3 && this.driverInteractionClear(game,v.id)) {
        this.lastUseTick=tick;this.vehicleGoal=-1;return BTN.USE;
      }
      return 0;
    };
    const current=game.vehicles.get(this.vehicleGoal);
    if(current && available(current) && Math.hypot(current.x-s.px,current.z-s.pz)<=Math.max(20,searchDistance))return approach(current);
    release(this.vehicleGoal);this.vehicleGoal=-1;
    if(tick<this.enterScanAt)return 0;
    this.enterScanAt=tick+60+(p.id%5)*4;
    const candidates:{v:ServerVehicle;score:number}[]=[];
    for(const v of game.vehicles.values()) {
      const distance=Math.hypot(v.x-s.px,v.z-s.pz);
      if(distance>searchDistance || Math.abs(v.y-s.py)>8 || !available(v))continue;
      const pilot=driver(v),shared=pilot && pilot.id!==p.id;
      const preferred=(role==='pilot'&&v.type===VEHICLE.JET)||(role==='sailor'&&v.type===VEHICLE.GUNBOAT)||crewDuty(v);
      const squadMate=shared && order?.squad!==undefined && this.companionOrder(game,pilot)?.squad===order.squad;
      candidates.push({v,score:distance-(preferred?60:0)-(shared?55:0)-(squadMate?30:0)});
    }
    candidates.sort((a,b)=>a.score-b.score||a.v.id-b.v.id);
    for(const {v} of candidates.slice(0,2)) {
      const dx=v.x-s.px,dy=v.y+1-s.py-PLAYER.EYE_HEIGHT,dz=v.z-s.pz,len=Math.hypot(dx,dy,dz);
      const hit=game.world.trace(s.px,s.py+PLAYER.EYE_HEIGHT,s.pz,dx/Math.max(.001,len),dy/Math.max(.001,len),dz/Math.max(.001,len),len,false);
      if(len<vehicleDefinition(v.type,v.variant)!.enterRange+3 || !hit.hit || hit.dist>len-1)return approach(v);
    }
    return 0;
  }

  /** The USE command has no target ID. Approach closer before pressing it if
   * another hull would win the server's nearest-seat selection. */
  private driverInteractionClear(game: Game, targetId: number): boolean {
    const s = this.player.state;
    let nearestId = -1, nearestDistance = Infinity;
    for (const hull of game.vehicles.values()) {
      if (hull.respawnAtTick >= 0 || (hull.occupant >= 0 && ((hull.gunner ?? -1) >= 0 || hull.transportRoute))) continue;
      const pilot=game.players.get(hull.occupant);
      if(game.frontier && pilot && pilot.faction!==this.player.faction)continue;
      const def = vehicleDefinition(hull.type, hull.variant)!;
      const distance = (hull.x - s.px) ** 2 + (hull.y + def.radius - s.py - 1) ** 2 + (hull.z - s.pz) ** 2;
      if (distance <= def.enterRange ** 2 && distance < nearestDistance) { nearestDistance = distance; nearestId = hull.id; }
    }
    return nearestId === targetId;
  }

  private grenadeMaxRange(enemy: ServerPlayer): number {
    const targetSpeed = Math.hypot(enemy.state.vx, enemy.state.vz);
    // Constant-velocity prediction becomes increasingly speculative over a
    // multi-second flight. Still targets expose the full 370 m capability;
    // fast dodgers bring the practical cap back toward the 330 m sweet spot.
    return clamp(
      GRENADE_MAX_RANGE - Math.max(0, targetSpeed - 2) * 3.3,
      GRENADE_PREFERRED_MAX,
      GRENADE_MAX_RANGE,
    );
  }

  private chooseCombatWeapon(
    player: ServerPlayer,
    dist: number,
    grenadeMaxRange: number,
  ): number {
    // Found weapons participate only after a real pickup put ammunition in
    // their slot. Explosive discoveries retain room to avoid self-blasts.
    const found=this.foundWeaponOrder(dist).find(w=>(player.ammo?.[w]?.magazine??0)>0&&weaponCoversDistance(w,dist));
    if(found!==undefined)return found;
    const roll = this.rng();
    let order: number[];

    if (dist < 16) {
      order = roll < 0.6
        ? [
            SCATTERGUN_WEAPON,
            PULSE_RIFLE_WEAPON,
            SIDEARM_WEAPON,
            ROCKET_WEAPON,
            GRENADE_WEAPON,
          ]
        : [
            PULSE_RIFLE_WEAPON,
            SCATTERGUN_WEAPON,
            SIDEARM_WEAPON,
            ROCKET_WEAPON,
            GRENADE_WEAPON,
          ];
    } else if (dist < GRENADE_MIN_RANGE) {
      order = roll < 0.55
        ? [
            PULSE_RIFLE_WEAPON,
            ROCKET_WEAPON,
            SIDEARM_WEAPON,
            SCATTERGUN_WEAPON,
            GRENADE_WEAPON,
          ]
        : [
            ROCKET_WEAPON,
            PULSE_RIFLE_WEAPON,
            SIDEARM_WEAPON,
            SCATTERGUN_WEAPON,
            GRENADE_WEAPON,
          ];
    } else if (dist <= grenadeMaxRange) {
      const grenadeChance =
        dist < GRENADE_PREFERRED_MIN ? 0.28 :
        dist <= GRENADE_PREFERRED_MAX ? 0.62 :
        0.32;
      if (roll < grenadeChance) {
        order = [
          GRENADE_WEAPON,
          PULSE_RIFLE_WEAPON,
          ROCKET_WEAPON,
          SIDEARM_WEAPON,
          SCATTERGUN_WEAPON,
        ];
      } else if (dist < GRENADE_PREFERRED_MIN && roll < 0.82) {
        order = [
          ROCKET_WEAPON,
          PULSE_RIFLE_WEAPON,
          SIDEARM_WEAPON,
          GRENADE_WEAPON,
          SCATTERGUN_WEAPON,
        ];
      } else {
        order = [
          PULSE_RIFLE_WEAPON,
          GRENADE_WEAPON,
          ROCKET_WEAPON,
          SIDEARM_WEAPON,
          SCATTERGUN_WEAPON,
        ];
      }
    } else {
      order = [
        PULSE_RIFLE_WEAPON,
        ROCKET_WEAPON,
        SIDEARM_WEAPON,
        SCATTERGUN_WEAPON,
        GRENADE_WEAPON,
      ];
    }

    for (const weapon of order) {
      if (!weaponCoversDistance(weapon, dist, grenadeMaxRange)) continue;
      if (weaponHasAmmo(player, weapon)) return weapon;
    }
    return player.weapon;
  }

  private fallbackOrder(dist: number): number[] {
    // Artillery is never a blind fallback. It is selected by
    // chooseCombatWeapon(), then accepted only after planGrenadeAim() validates
    // both its range and complete terrain clearance. This prevents a loaded
    // grenade from cancelling a useful reload in close quarters or behind
    // cover.
    if (dist < 16) {
      return [...this.foundWeaponOrder(dist).filter(w=>(this.player.ammo?.[w]?.magazine??0)>0),
        SCATTERGUN_WEAPON,
        PULSE_RIFLE_WEAPON,
        SIDEARM_WEAPON,
        ROCKET_WEAPON,
      ];
    }
    if (dist < GRENADE_PREFERRED_MIN) {
      return [...this.foundWeaponOrder(dist).filter(w=>(this.player.ammo?.[w]?.magazine??0)>0),
        PULSE_RIFLE_WEAPON,
        ROCKET_WEAPON,
        SIDEARM_WEAPON,
        SCATTERGUN_WEAPON,
      ];
    }
    return [...this.foundWeaponOrder(dist).filter(w=>(this.player.ammo?.[w]?.magazine??0)>0),
      PULSE_RIFLE_WEAPON,
      ROCKET_WEAPON,
      SIDEARM_WEAPON,
      SCATTERGUN_WEAPON,
    ];
  }

  private foundWeaponOrder(dist:number):number[] {
    if(dist<22)return [8,7];
    if(dist<70)return [9,8,7];
    if(dist<180)return [7,9];
    return [5,6,7];
  }

  private loadedFallback(
    player: ServerPlayer,
    dist: number,
    exclude: number,
  ): number {
    for (const weapon of this.fallbackOrder(dist)) {
      if (
        weapon !== exclude &&
        weaponCoversDistance(weapon, dist) &&
        weaponLoaded(player, weapon)
      ) {
        return weapon;
      }
    }
    return -1;
  }

  private reloadableFallback(
    player: ServerPlayer,
    dist: number,
    preferred: number,
  ): number {
    if (
      weaponCoversDistance(preferred, dist) &&
      weaponCanReload(player, preferred)
    ) {
      return preferred;
    }
    for (const weapon of this.fallbackOrder(dist)) {
      if (
        weapon !== preferred &&
        weaponCoversDistance(weapon, dist) &&
        weaponCanReload(player, weapon)
      ) {
        return weapon;
      }
    }
    return -1;
  }

  private planGrenadeAim(game: Game, enemy: ServerPlayer): GrenadeAim | null {
    const def = WEAPONS[GRENADE_WEAPON];
    const speed = def.speed ?? 78;
    const gravity = def.gravity ?? 16;
    const projectileRadius = def.projRadius ?? 0.24;
    // Flight time is a policy bound, independent from path distance: gravity
    // slows ascent, so range / launchSpeed rejects valid steep trajectories.
    // Each candidate is checked against the actual authoritative chord budget
    // below before the more expensive terrain trace.
    const maxFlightTime = GRENADE_MAX_FLIGHT_TIME;
    const s = this.player.state;

    const origin = {
      x: s.px,
      y: s.py + PLAYER.EYE_HEIGHT,
      z: s.pz,
    };
    // Keep inaccuracy in target space and inside the expanded player capsule.
    // Angular jitter after solving could turn a clear arc into a cave-wall hit.
    const target = {
      x: enemy.state.px + (this.rng() - 0.5) * 1.6,
      y: enemy.state.py + 1.0 + (this.rng() - 0.5) * 0.5,
      z: enemy.state.pz + (this.rng() - 0.5) * 1.6,
    };
    const horizontalSpeed = Math.hypot(enemy.state.vx, enemy.state.vz);
    const velocityScale = horizontalSpeed > 16 ? 16 / horizontalSpeed : 1;
    const targetVelocity = {
      x: enemy.state.vx * velocityScale,
      y: enemy.state.grounded ? 0 : clamp(enemy.state.vy, -8, 8),
      z: enemy.state.vz * velocityScale,
    };

    const solutions = solveBallisticIntercept({
      origin,
      target,
      targetVelocity,
      speed,
      gravity,
      muzzleOffset: 0.5,
      maxTime: maxFlightTime,
    });

    // Earlier root is the low arc. If cover blocks it, the unrestricted high
    // arc gets a chance, while cave ceilings naturally reject that fallback.
    for (const solution of solutions) {
      if (solution.pitch < -1.4 || solution.pitch > 1.4) continue;
      const yaw = unquantYaw(quantYaw(solution.yaw));
      const pitch = unquantPitch(quantPitch(solution.pitch));
      const direction = viewDir(yaw, pitch);
      if (
        ballisticPathDistance(direction, speed, gravity, solution.time) >
        def.range + 1e-6
      ) {
        continue;
      }
      if (!ballisticArcClear(game.world, {
        origin,
        direction,
        speed,
        gravity,
        muzzleOffset: 0.5,
        flightTime: solution.time,
        projectileRadius,
      })) {
        continue;
      }
      return { yaw, pitch };
    }
    return null;
  }

  private acquireEnemy(game:Game):ServerPlayer|null {
    return this.acquireEnemyWith(game,this.player,this as unknown as EnemySensingState);
  }
  private acquireEnemyWith(game:Game,p:ServerPlayer,sensing:EnemySensingState,policy?:CrewScanPolicy):ServerPlayer|null {
    const s = p.state;

    // Re-check line of sight only a few times a second; traces aren't free.
    if (game.tick >= sensing.losCheckAt) {
      // Give each actor a different scan phase. A whole roster must not fire
      // all its expensive terrain traces on the same simulation tick.
      const remoteRepeat=sensing.losStarted&&sensing.remotePerception;
      sensing.losCheckAt = game.tick + (policy ? policy.interval : remoteRepeat ? 24 : sensing.losStarted ? 9 : 1 + p.id % 9);
      sensing.losStarted = true;
      const candidates: { player: ServerPlayer; d2: number }[] = [];
      for (const q of game.players.values()) {
        if (!game.areEnemies(p, q) || !q.state.alive) continue;
        if(p.vehicleId>=0&&q.vehicleId===p.vehicleId)continue;
        // Infantry delegates airborne aircraft to the coordinated AA policy.
        // Otherwise its ordinary burst-fire brain resumes during AA cooldown
        // and launches more rockets immediately, erasing the escape window.
        // Crewed guns still engage aircraft and taxiing hulls remain exposed.
        if(s.vehicle===VEHICLE.NONE && q.state.vehicle===VEHICLE.JET && !q.state.grounded)continue;
        const dx = q.state.px - s.px, dy = q.state.py - s.py, dz = q.state.pz - s.pz;
        const d2 = dx * dx + dy * dy + dz * dz;
        // Distant actors cannot enter this scan, so avoid evaluating their
        // campaign approach geometry before the existing exact range cutoff.
        if (!(d2 < BOT_ACQUIRE_RANGE * BOT_ACQUIRE_RANGE)) continue;
        if(s.vehicle===VEHICLE.NONE && !this.campaignThreat(game,q))continue;
        candidates.push({ player: q, d2 });
      }
      candidates.sort((a, b) => a.d2 - b.d2 || a.player.id - b.player.id);
      if (!candidates.length) sensing.losObstructions.clear();

      const retained = candidates.find(c => c.player.id === sensing.enemyId);
      sensing.losOk = false;
      sensing.enemyId = -1;
      // Keep a visible opponent; rotate through occluded candidates with at
      // most two probes per scan so a crowded city cannot monopolize a tick.
      // No candidate is permanently hidden behind a fixed nearest-N limit.
      const checks: typeof candidates = [];
      if (retained) checks.push(retained);
      for (let visited = 0; visited < candidates.length && checks.length < (policy?.maxChecks ?? 2); visited++) {
        const candidate = candidates[sensing.losCursor++ % candidates.length];
        if (candidate !== retained) checks.push(candidate);
      }
      sensing.losCursor %= Math.max(1, candidates.length);
      for (const candidate of checks) {
        const q = candidate.player;
        const ox = s.px, oy = s.py + PLAYER.EYE_HEIGHT, oz = s.pz;
        const tx = q.state.px, ty = q.state.py + 1.2, tz = q.state.pz;
        const dx = tx - ox, dy = ty - oy, dz = tz - oz;
        const dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dl < 1e-6) {
          sensing.losObstructions.delete(q.id);
          sensing.losOk = true;
          sensing.enemyId = q.id;
          break;
        }
        const limit = dl - .8, witness = sensing.losObstructions.get(q.id);
        // A crowded rotating roster can take several seconds to revisit a
        // target. Retain bounded hints for ten seconds, but prove cover anew
        // below on every use; retention never preserves an old LOS verdict.
        if (witness && typeof game.world.sdf === 'function' && game.tick >= witness.tick && game.tick - witness.tick <= 600) {
          const along = ((witness.x - ox) * dx + (witness.y - oy) * dy + (witness.z - oz) * dz) / dl;
          const projectedFraction = along / dl;
          const wx = ox + dx * projectedFraction, wy = oy + dy * projectedFraction, wz = oz + dz * projectedFraction;
          // Revalidate a point on the CURRENT ray, never an old visibility
          // decision. Actor movement, changing aim and removed/moving cover
          // all fall back to the full trace when this proof no longer holds.
          if (along >= 0 && along <= limit &&
              game.world.sdf(wx, wy, wz) <= 0) {
            witness.x = wx; witness.y = wy; witness.z = wz; witness.fraction = projectedFraction;
            witness.tick = game.tick;
            continue;
          }
          // Projection keeps a fixed wall's witness in place as target range
          // changes. The relative point also covers terrain moving with the
          // actors; it is only another freshly checked hint, not cached LOS.
          const relativeAlong = dl * witness.fraction;
          if (Math.abs(relativeAlong - along) > .05 && relativeAlong >= 0 && relativeAlong <= limit) {
            const rx = ox + dx * witness.fraction, ry = oy + dy * witness.fraction, rz = oz + dz * witness.fraction;
            if (game.world.sdf(rx, ry, rz) <= 0) {
              witness.x = rx; witness.y = ry; witness.z = rz; witness.tick = game.tick;
              continue;
            }
          }
        }
        const th = game.world.trace(ox, oy, oz, dx / dl, dy / dl, dz / dl, dl, false);
        if (!th.hit || th.dist > dl - 0.8) {
          sensing.losObstructions.delete(q.id);
          sensing.losOk = true;
          sensing.enemyId = q.id;
          break;
        }
        if (typeof game.world.sdf === 'function') {
          // An interior point is more robust than a surface endpoint when
          // either actor shifts slightly. Thin cover keeps the known-solid
          // trace endpoint; every later use still verifies its current sign.
          const inside = Math.min(th.dist + .5, (th.dist + limit) * .5);
          const fraction = inside > th.dist &&
            game.world.sdf(ox + dx * inside / dl, oy + dy * inside / dl, oz + dz * inside / dl) <= 0
            ? inside / dl : th.dist / dl;
          if (!sensing.losObstructions.has(q.id) && sensing.losObstructions.size >= 64)
            sensing.losObstructions.delete(sensing.losObstructions.keys().next().value!);
          sensing.losObstructions.set(q.id, { fraction, x: ox + dx * fraction, y: oy + dy * fraction, z: oz + dz * fraction, tick: game.tick });
        }
      }
      // Remote ground crews use a 24-tick LOS deadline. All other
      // actors keep the original 9/18-tick visible/occluded scan deadlines;
      // their ordinary brain cadence and current weapon collision are separate.
      if (!policy&&!sensing.losOk&&!remoteRepeat) sensing.losCheckAt += 9;
    }
    if (!sensing.losOk || sensing.enemyId < 0) return null;
    const enemy = game.players.get(sensing.enemyId);
    if (!enemy || !enemy.state.alive || !game.areEnemies(p, enemy)) return null;
    if(s.vehicle===VEHICLE.NONE && enemy.state.vehicle===VEHICLE.JET && !enemy.state.grounded)return null;
    if(s.vehicle===VEHICLE.NONE && !this.campaignThreat(game,enemy))return null;
    return enemy;
  }
}
