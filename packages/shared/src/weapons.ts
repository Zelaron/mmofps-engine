import { hash3i, unit } from './rng.js';
import { viewDir, TAU } from './math.js';
import { BTN } from './movement.js';

export type WeaponKind = 'hitscan' | 'projectile';
export type ProjectileStyle = 'rocket' | 'grenade';

export interface WeaponDef {
  id: number;
  name: string;
  kind: WeaponKind;
  /** Seconds between shots. */
  interval: number;
  /** Deliberate shot groups; the pause follows each completed burst. */
  burstSize?: number;
  burstPause?: number;
  /** Damage per pellet (hitscan) or direct hit (projectile). */
  damage: number;
  pellets: number;
  /** Cone half-angle in radians. */
  spread: number;
  /** Radius of an authoritative broad hitscan beam (ordinary rays omit it). */
  beamRadius?: number;
  /** Max hitscan distance / projectile lifetime distance in meters. */
  range: number;
  /** Impulse applied to victims (and self for splash). */
  knockback: number;
  /** Rounds loaded after spawning or completing a full reload. */
  magazineSize: number;
  /** Spare rounds granted on spawn, separate for every weapon. */
  reserveSize: number;
  /**
   * Reloads never consume or require reserve ammunition. The replicated
   * reserve counter remains the finite integer `reserveSize` (normally zero)
   * so infinity never needs a special wire representation.
   */
  infiniteReserve?: boolean;
  /** Seconds required to transfer reserve rounds into the magazine. */
  reloadTime: number;
  /** Visual/physical family for projectile weapons. */
  projectile?: ProjectileStyle;
  speed?: number;
  splashRadius?: number;
  splashMax?: number;
  /** Peak radial velocity impulse at the center of an explosion. */
  splashImpulse?: number;
  /** Upward bias added to the normalized radial blast direction. */
  splashLift?: number;
  projRadius?: number;
  /** Downward acceleration in m/s^2. Omitted/zero means straight flight. */
  gravity?: number;
  /** Seconds before an in-flight projectile detonates. */
  fuse?: number;
  /** Whether terrain impacts ricochet instead of detonating immediately. */
  bounces?: boolean;
  /**
   * Seconds after launch during which terrain impacts ricochet. Player hits
   * still detonate immediately; once this window ends, the next terrain
   * contact detonates normally. A resting projectile detonates as it arms.
   */
  terrainBounceTime?: number;
  /**
   * Detonates only on player/terrain contact. Fuse or distance exhaustion
   * retires the projectile silently instead of creating a mid-air blast.
   */
  impactOnly?: boolean;
  /** Normal velocity retained after a terrain impact. */
  bounce?: number;
  /** Tangential velocity retained after a terrain impact. */
  bounceFriction?: number;
  /**
   * Players spawn with ZERO ammo for this weapon: it must be found in the
   * world. Also excluded from death-loot crates and bot ammo regeneration.
   * Death still wipes it - found weapons are earned per life.
   */
  spawnEmpty?: boolean;
}

/**
 * The indefinite-ricochet switch remains available for a future weapon. The
 * grenade launcher instead uses a finite terrain-arming window below.
 */
export const BOUNCY_GRENADES = false;

export const WEAPONS: readonly WeaponDef[] = [
  {
    id: 0, name: 'Sidearm', kind: 'hitscan',
    // Deliberately modest and imprecise, but always available as a fallback.
    interval: 0.32, damage: 20, pellets: 1, spread: 0.052, range: 240, knockback: 1.1,
    magazineSize: 12, reserveSize: 0, infiniteReserve: true, reloadTime: 1.45,
  },
  {
    id: 1, name: 'Pulse Rifle', kind: 'hitscan',
    // Restored from the original loadout: accurate, fully automatic fire.
    interval: 0.105, damage: 11, pellets: 1, spread: 0.0175, range: 420, knockback: 1.4,
    magazineSize: 30, reserveSize: 120, reloadTime: 1.8,
  },
  {
    id: 2, name: 'Scattergun', kind: 'hitscan',
    interval: 0.92, damage: 9, pellets: 9, spread: 0.108, range: 80, knockback: 2.6,
    magazineSize: 8, reserveSize: 32, reloadTime: 2.25,
  },
  {
    id: 3, name: 'Rocket Launcher', kind: 'projectile', projectile: 'rocket',
    interval: 0.95, damage: 92, pellets: 1, spread: 0, range: 600, knockback: 0,
    speed: 48, splashRadius: 4.6, splashMax: 72,
    splashImpulse: 24, splashLift: 0.45, projRadius: 0.16,
    bounces: false,
    // Forty rockets total: six ready to fire and thirty-four in reserve.
    magazineSize: 6, reserveSize: 34, reloadTime: 2.8,
  },
  {
    id: 4, name: 'Grenade Launcher', kind: 'projectile', projectile: 'grenade',
    // Single-shot impact artillery. A clean 45-degree launch travels roughly
    // 380m on level ground. The 840m path budget conservatively covers the
    // ~829m longest arc across the world's full declared vertical span
    // (MAX_HEIGHT 280 down to the cave floor).
    // The magazine itself enforces the real cadence. This is only a brief
    // post-shot action lock before the mandatory reload may continue.
    interval: 0.18, damage: 125, pellets: 1, spread: 0, range: 840, knockback: 0,
    speed: 78, splashRadius: 12.8, splashMax: 130,
    splashImpulse: 30, splashLift: 0.65, projRadius: 0.24,
    gravity: 16, bounces: BOUNCY_GRENADES, terrainBounceTime: 1, impactOnly: true,
    // A miss deflects clearly but sheds enough energy to avoid a rubber-ball
    // return into close combat.
    bounce: 0.42, bounceFriction: 0.72,
    magazineSize: 1, reserveSize: 9, reloadTime: 3.6,
  },
  {
    id: 5, name: 'Gauss Rifle', kind: 'hitscan',
    // Cave loot. Devastating on a direct hit; a terrain miss plants a
    // RAIL_CHARGE at the impact point that detonates into a huge shockwave
    // a few seconds later (handled server-side in fireHitscan).
    // Range stays inside structure/vegetation render coverage (~880m).
    interval: 1.4, damage: 150, pellets: 1, spread: 0, range: 820, knockback: 3,
    magazineSize: 20, reserveSize: 20, reloadTime: 2.4, spawnEmpty: true,
  },
  {
    id: 6, name: 'Nuke Launcher', kind: 'hitscan',
    // Cave loot. Fires an instant designator: the impact point becomes a
    // NUKE_MARKER beacon visible to everyone, and ~8 seconds later a
    // NUKE_BOMB falls out of the sky onto it (server-side).
    // Range stays inside NET.INTEREST_RADIUS so the placed marker is
    // always replicated back to the player who painted it.
    interval: 2.5, damage: 0, pellets: 1, spread: 0, range: 700, knockback: 0,
    magazineSize: 5, reserveSize: 5, reloadTime: 3.2, spawnEmpty: true,
  },
  {
    id: 7, name: 'Burst Carbine', kind: 'hitscan',
    // Accurate three-round groups trade sustained DPS for range and control.
    // Releasing the trigger can interrupt a group; ammunition is its phase.
    interval: .095, burstSize: 3, burstPause: .48,
    damage: 17, pellets: 1, spread: .008, range: 560, knockback: 1.6,
    magazineSize: 24, reserveSize: 72, reloadTime: 2.05, spawnEmpty: true,
  },
  {
    id: 8, name: 'Flechette Repeater', kind: 'hitscan',
    // Fast four-dart salvos excel nearby but disperse outside skirmish range.
    interval: .2, damage: 7, pellets: 4, spread: .045, range: 150, knockback: 1.25,
    magazineSize: 20, reserveSize: 60, reloadTime: 2.3, spawnEmpty: true,
  },
  {
    id: 9, name: 'Prism Projector', kind: 'projectile', projectile: 'rocket',
    // A quick, slightly falling plasma bolt. Compact splash rewards leading
    // moving targets without replacing the launchers' large explosions.
    interval: .52, damage: 48, pellets: 1, spread: 0, range: 460, knockback: 0,
    speed: 68, gravity: 3.5, splashRadius: 3.2, splashMax: 40,
    splashImpulse: 9, splashLift: .25, projRadius: .13, bounces: false,
    magazineSize: 8, reserveSize: 24, reloadTime: 2.65, spawnEmpty: true,
  },
];

export const ROCKET_LAUNCHER_ID = 3;
export const RAILGUN_ID = 5;
export const NUKE_LAUNCHER_ID = 6;
export const BURST_CARBINE_ID = 7;
export const FLECHETTE_REPEATER_ID = 8;
export const PRISM_PROJECTOR_ID = 9;

/** Ammo-derived burst phase survives prediction replay without another wire
 * field. Full reloads start a fresh group; ordinary guns keep their cadence. */
export function shotInterval(def: WeaponDef, magazineAfterShot: number): number {
  if (def.burstSize && def.burstPause && (def.magazineSize - magazineAfterShot) % def.burstSize === 0) {
    return def.burstPause;
  }
  return def.interval;
}

// ---- Auxiliary (non-selectable) weapons ------------------------------------
//
// Ids 100..199: projectiles/blasts spawned BY weapons, never held. Kept
// below the vehicle namespace (>= 200) and above the handheld slots.

/** Planted by a railgun terrain miss; the fuse pops a massive shockwave. */
export const RAIL_CHARGE: WeaponDef = {
  id: 100, name: 'Rail Charge', kind: 'projectile', projectile: 'grenade',
  interval: 1, damage: 0, pellets: 1, spread: 0, range: 50, knockback: 0,
  magazineSize: 1, reserveSize: 0, reloadTime: 1,
  speed: 0, gravity: 0, fuse: 1.6, splashRadius: 17, splashMax: 45,
  splashImpulse: 85, splashLift: 0.75, projRadius: 0.2,
  bounces: false, terrainBounceTime: 0,
};

/** The designated ground zero: a stationary beacon everyone can see. */
export const NUKE_MARKER: WeaponDef = {
  id: 101, name: 'Nuke Marker', kind: 'projectile', projectile: 'grenade',
  interval: 1, damage: 0, pellets: 1, spread: 0, range: 50, knockback: 0,
  magazineSize: 1, reserveSize: 0, reloadTime: 1,
  speed: 0, gravity: 0, fuse: 8, splashRadius: 0, splashMax: 0,
  projRadius: 0.2, bounces: false, terrainBounceTime: 0, impactOnly: true,
};

/** Falls out of the sky onto the marker; detonates on ground impact. */
export const NUKE_BOMB: WeaponDef = {
  id: 102, name: 'Nuke', kind: 'projectile', projectile: 'rocket',
  interval: 1, damage: 300, pellets: 1, spread: 0, range: 4000, knockback: 0,
  magazineSize: 1, reserveSize: 0, reloadTime: 1,
  speed: 0, gravity: 14, fuse: 30, splashRadius: 190, splashMax: 320,
  splashImpulse: 60, splashLift: 0.65, projRadius: 0.5,
  bounces: false, terrainBounceTime: 0,
};

export const AUX_WEAPONS: readonly WeaponDef[] = [RAIL_CHARGE, NUKE_MARKER, NUKE_BOMB];

export interface WeaponAmmo {
  magazine: number;
  reserve: number;
}

/**
 * Mutable combat state shared by server authority and client prediction.
 * Keeping the complete transition in this package makes snapshot replay
 * exact: acknowledged shots cannot be accidentally restored by an older
 * snapshot, and reload edges behave identically under packet starvation.
 */
export interface WeaponState {
  weapon: number;
  fireCd: number;
  /** Weapon being reloaded, or -1 when no reload is active. */
  reloadWeapon: number;
  reloadCd: number;
  reloadHeld: boolean;
  ammo: WeaponAmmo[];
}

export interface WeaponStepResult {
  /** Weapon that fired this tick, or -1. */
  firedWeapon: number;
  /** Weapon whose reload began this tick, or -1. */
  reloadStartedWeapon: number;
  /** Weapon whose reload completed this tick, or -1. */
  reloadCompletedWeapon: number;
  /** Empty weapon that clicked this tick, or -1. */
  dryFireWeapon: number;
  switched: boolean;
}

const EMPTY_WEAPON_STEP: Readonly<WeaponStepResult> = {
  firedWeapon: -1,
  reloadStartedWeapon: -1,
  reloadCompletedWeapon: -1,
  dryFireWeapon: -1,
  switched: false,
};

export function idleWeaponStep(): WeaponStepResult {
  return { ...EMPTY_WEAPON_STEP };
}

export function createFullAmmoLoadout(): WeaponAmmo[] {
  return WEAPONS.map((def) => ({
    magazine: def.spawnEmpty ? 0 : def.magazineSize,
    reserve: def.spawnEmpty ? 0 : def.reserveSize,
  }));
}

export function createWeaponState(weapon = 0, fireCd = 0): WeaponState {
  return {
    weapon,
    fireCd,
    reloadWeapon: -1,
    reloadCd: 0,
    reloadHeld: false,
    ammo: createFullAmmoLoadout(),
  };
}

export function refillWeaponAmmo(state: WeaponState): void {
  state.ammo = createFullAmmoLoadout();
  state.reloadWeapon = -1;
  state.reloadCd = 0;
  state.reloadHeld = false;
}

export function cancelReload(state: WeaponState): void {
  state.reloadWeapon = -1;
  state.reloadCd = 0;
}

/**
 * spawnEmpty weapons are invisible to selection until actually carried:
 * they must be found in the world, and death takes them away again.
 */
export function isWeaponSelectable(ammo: readonly WeaponAmmo[], weapon: number): boolean {
  const def = WEAPONS[weapon];
  if (!def) return false;
  if (!def.spawnEmpty) return true;
  const a = ammo[weapon];
  return !!a && a.magazine + a.reserve > 0;
}

function canReload(state: WeaponState, weapon: number): boolean {
  const def = WEAPONS[weapon];
  const ammo = state.ammo[weapon];
  return !!def &&
    !!ammo &&
    ammo.magazine < def.magazineSize &&
    (def.infiniteReserve === true || ammo.reserve > 0);
}

function beginReload(state: WeaponState, weapon: number, out: WeaponStepResult): void {
  state.reloadWeapon = weapon;
  state.reloadCd = WEAPONS[weapon].reloadTime;
  out.reloadStartedWeapon = weapon;
}

/**
 * Advance weapon selection, cooldown, ammunition and reload state by one
 * fixed simulation step. The caller invokes the actual shot only when
 * `firedWeapon >= 0`.
 *
 * Reloads finish atomically and are cancelled without consuming reserve ammo
 * when the player changes weapon. Pulling the trigger on an empty magazine
 * starts an automatic reload; R also supports tactical reloads.
 */
export function stepWeaponState(
  state: WeaponState,
  requestedWeapon: number,
  buttons: number,
  dt: number,
): WeaponStepResult {
  const out = idleWeaponStep();
  const reloadDown = (buttons & BTN.RELOAD) !== 0;
  const reloadPressed = reloadDown && !state.reloadHeld;
  state.reloadHeld = reloadDown;

  if (Number.isInteger(requestedWeapon) &&
      requestedWeapon >= 0 &&
      requestedWeapon < WEAPONS.length &&
      requestedWeapon !== state.weapon &&
      isWeaponSelectable(state.ammo, requestedWeapon)) {
    state.weapon = requestedWeapon;
    state.fireCd = Math.max(state.fireCd, 0.25);
    cancelReload(state);
    out.switched = true;
  }

  state.fireCd = Math.max(0, state.fireCd - dt);

  if (state.reloadWeapon >= 0) {
    // A changed selection cancels the old reload before reaching this branch.
    state.reloadCd = Math.max(0, state.reloadCd - dt);
    if (state.reloadCd <= 1e-9) {
      const weapon = state.reloadWeapon;
      const def = WEAPONS[weapon];
      const ammo = state.ammo[weapon];
      if (def && ammo) {
        const transfer = def.infiniteReserve
          ? def.magazineSize - ammo.magazine
          : Math.min(def.magazineSize - ammo.magazine, ammo.reserve);
        ammo.magazine += Math.max(0, transfer);
        if (!def.infiniteReserve) ammo.reserve -= Math.max(0, transfer);
      }
      cancelReload(state);
      out.reloadCompletedWeapon = weapon;
    }
    // Completing a reload and firing in the same tick makes prediction highly
    // sensitive to event ordering, so the first possible shot is next tick.
    return out;
  }

  if (reloadPressed && canReload(state, state.weapon)) {
    beginReload(state, state.weapon, out);
    return out;
  }

  const fireDown = (buttons & BTN.FIRE) !== 0;
  const weapon = state.weapon;
  const ammo = state.ammo[weapon];

  // Do not make a held trigger wait out the previous shot's cooldown before
  // beginning an empty-magazine reload. This runs on the simulation step after
  // the last round fired, matching an explicit R press without combining a
  // shot and reload transition in one step.
  if (fireDown && (!ammo || ammo.magazine <= 0)) {
    if (canReload(state, weapon)) {
      beginReload(state, weapon, out);
    } else if (state.fireCd <= 0) {
      // Throttle the dry click while FIRE remains held.
      state.fireCd = 0.35;
      out.dryFireWeapon = weapon;
    }
    return out;
  }

  if (fireDown && state.fireCd <= 0) {
    if (ammo && ammo.magazine > 0) {
      ammo.magazine--;
      state.fireCd = shotInterval(WEAPONS[weapon], ammo.magazine);
      out.firedWeapon = weapon;
    }
  }

  return out;
}

/**
 * Deterministic direction for pellet #i of shot #seq by shooter #shooterId.
 * Client and server derive identical pellet patterns from the same inputs,
 * so predicted tracers match what the server actually resolves.
 */
export function pelletDir(
  seed: number, shooterId: number, seq: number, i: number,
  yaw: number, pitch: number, spread: number,
): { x: number; y: number; z: number } {
  const f = viewDir(yaw, pitch);
  if (spread <= 0) return f;

  // Orthonormal basis around f: camera right (pitch-independent in YXZ) and
  // up = cross(right, forward).
  const rx = Math.cos(yaw), rz = -Math.sin(yaw);
  const cx = -rz * f.y;
  const cy = rz * f.x - rx * f.z;
  const cz = rx * f.y;

  const u1 = unit(hash3i(seed ^ 0xf17e5eed, shooterId, seq, i * 2));
  const u2 = unit(hash3i(seed ^ 0xf17e5eed, shooterId, seq, i * 2 + 1));
  const rad = Math.tan(spread) * Math.sqrt(u1);
  const ang = u2 * TAU;
  const ca = Math.cos(ang) * rad, sa = Math.sin(ang) * rad;

  const dx = f.x + rx * ca + cx * sa;
  const dy = f.y + cy * sa;
  const dz = f.z + rz * ca + cz * sa;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return { x: dx / len, y: dy / len, z: dz / len };
}
