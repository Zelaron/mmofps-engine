import { PLAYER } from './constants.js';
import { capsuleClearance, type KinState } from './physics.js';
import type { CityLiftSite } from './cities.js';
import { World } from './worldgen.js';

export const LIFT_SPEED = 4;
export const LIFT_DWELL = 6;
const SKIN = .006;
const LIFT_CELL = 64;
const NO_LIFTS: readonly CityLiftSite[] = [];
type LiftGrid = Map<number, Map<number, CityLiftSite[]>>;
const liftGrids = new WeakMap<readonly CityLiftSite[], LiftGrid | null>();

/** Generated lift sites are static. Keep their original order within every
 * cell so overlapping decks still resolve exactly as in the full scan.
 * Custom collectors can return mutable fixtures and retain that full scan. */
function liftSitesAt(world: World, x: number, z: number): readonly CityLiftSite[] {
  const sites = world.collectCityLifts();
  if (sites.length <= 8 || world.collectCityLifts !== World.prototype.collectCityLifts ||
      !Number.isFinite(x) || !Number.isFinite(z)) return sites;
  let grid = liftGrids.get(sites);
  if (grid === undefined) {
    grid = buildLiftGrid(sites);
    liftGrids.set(sites, grid);
  }
  return grid === null ? sites : grid.get(Math.floor(x / LIFT_CELL))?.get(Math.floor(z / LIFT_CELL)) ?? NO_LIFTS;
}

function buildLiftGrid(sites: readonly CityLiftSite[]): LiftGrid | null {
  const grid: LiftGrid = new Map();
  const margin = PLAYER.RADIUS * .5 + 1e-7;
  for (const site of sites) {
    const minX = Math.floor((site.x - site.hx - margin) / LIFT_CELL);
    const maxX = Math.floor((site.x + site.hx + margin) / LIFT_CELL);
    const minZ = Math.floor((site.z - site.hz - margin) / LIFT_CELL);
    const maxZ = Math.floor((site.z + site.hz + margin) / LIFT_CELL);
    // Keep unusual custom world data conservative without allocating an
    // unbounded grid or changing how the existing contact test treats it.
    if (![minX, maxX, minZ, maxZ].every(Number.isSafeInteger) ||
        minX > maxX || minZ > maxZ || (maxX - minX + 1) * (maxZ - minZ + 1) > 1024) return null;
    for (let cx = minX; cx <= maxX; cx++) {
      let column = grid.get(cx);
      if (!column) { column = new Map(); grid.set(cx, column); }
      for (let cz = minZ; cz <= maxZ; cz++) {
        let bucket = column.get(cz);
        if (!bucket) { bucket = []; column.set(cz, bucket); }
        bucket.push(site);
      }
    }
  }
  return grid;
}

export interface LiftPose { y: number; velocity: number; waiting: boolean; untilDeparture: number }

/** Shared clock-driven motion: no platform packets, wall clocks or integration
 * drift. Energy decks pause at both landings and support riders from above. */
export function cityLiftPose(site: CityLiftSite, seconds: number): LiftPose {
  const speed = site.top - site.bottom > 80 ? Math.min(12, (site.top - site.bottom) / 10) : LIFT_SPEED;
  const travel = Math.max(0, site.top - site.bottom) / speed;
  const dwell = site.dwell ?? LIFT_DWELL;
  const period = 2 * (travel + dwell);
  const t = ((seconds + site.phase) % period + period) % period;
  if (t < dwell) return { y: site.bottom, velocity: 0, waiting: true, untilDeparture: dwell - t };
  if (t < dwell + travel) return { y: site.bottom + (t - dwell) * speed, velocity: speed, waiting: false, untilDeparture: 0 };
  if (t < 2 * dwell + travel) return { y: site.top, velocity: 0, waiting: true, untilDeparture: 2 * dwell + travel - t };
  return { y: site.top - (t - 2 * dwell - travel) * speed, velocity: -speed, waiting: false, untilDeparture: 0 };
}

export function insideLift(site: CityLiftSite, x: number, z: number): boolean {
  // Contact follows the capsule footprint, not an inset test of its center.
  // Otherwise the small clearance gap between a shaft rim and its deck is
  // enough for the feet to fall below the one-way plane before boarding.
  return Math.abs(x - site.x) <= site.hx + PLAYER.RADIUS * .5 &&
    Math.abs(z - site.z) <= site.hz + PLAYER.RADIUS * .5;
}

export interface LiftContact { site: CityLiftSite; from: LiftPose; to: LiftPose }
export interface LiftApproach { x: number; z: number; grounded: boolean; velocityY: number }

/** Carry already-grounded feet before ordinary horizontal movement. A
 * blocked shaft releases the rider instead of forcing them into a ceiling. */
export function carryCityLift(world: World, state: KinState, before: number, now: number): LiftContact | null {
  if (!state.grounded || state.vy > .1 || !world.collectCityLifts) return null;
  for (const site of liftSitesAt(world, state.px, state.pz)) {
    if (!insideLift(site, state.px, state.pz)) continue;
    const from = cityLiftPose(site, before);
    if (Math.abs(state.py - from.y - SKIN) > .08) continue;
    const to = cityLiftPose(site, now), y = state.py + to.y - from.y;
    if (Math.abs(to.y - from.y) > .001 && capsuleClearance(world, state.px, y, state.pz) < -.01) return null;
    state.py = y;
    return { site, from, to };
  }
  return null;
}

/** One-way force decks have no opaque collision hull underneath. Sweeping
 * relative feet/deck motion catches fast falls and rising platforms alike. */
export function landOnCityLift(world: World, state: KinState, previousFeet: number,
  before: number, now: number, carried: LiftContact | null, jumped: boolean, approach?: LiftApproach): number {
  let impact = 0;
  if (!world.collectCityLifts) return impact;
  for (const site of liftSitesAt(world, state.px, state.pz)) {
    if (!insideLift(site, state.px, state.pz)) continue;
    const to = cityLiftPose(site, now);
    const from = carried?.site.id === site.id ? carried.from : cityLiftPose(site, before);
    const ride = carried?.site.id === site.id && !jumped;
    const startGap = previousFeet - from.y - SKIN, endGap = state.py - to.y - SKIN;
    // Decide contact from the swept relative positions, never the velocity
    // left by static collision. A landing rim or downhill snap can zero vy
    // after the feet have already crossed a descending energy deck.
    const fraction = Math.max(0, Math.min(1, startGap / Math.max(1e-9, startGap - endGap)));
    const crossingInside = !approach || insideLift(site,
      approach.x + (state.px - approach.x) * fraction, approach.z + (state.pz - approach.z) * fraction);
    const fallingThrough = !jumped && startGap >= -.03 && endGap <= 0 && endGap < startGap && crossingInside;
    // Match ordinary downhill ground snap when walking off a landing. The
    // deck may move downward faster than a just-grounded player's first
    // gravity step; boarding it should immediately establish moving support.
    const walkingBoarding = !!approach?.grounded && !jumped && approach.velocityY <= .5 &&
      startGap >= -.08 && endGap >= -.08 && endGap <= PLAYER.GROUND_SNAP;
    // A shaft's necessary side clearance can leave a few unsupported
    // centimeters before the capsule overlaps the deck. Permit that shallow
    // edge step, but never pull a rising player up through its underside.
    const edgeBoarding = !!approach && !jumped && !insideLift(site, approach.x, approach.z) &&
      approach.velocityY <= .5 && approach.velocityY >= -3 && startGap >= -.2 && endGap >= -.2 && endGap <= .08;
    const boarding = walkingBoarding || edgeBoarding;
    if ((!ride && !fallingThrough && !boarding) || (!boarding && state.py > to.y + .12)) continue;
    if (!ride && capsuleClearance(world, state.px, to.y + SKIN, state.pz) < -.01) continue;
    impact = ride || boarding ? 0 : Math.max(0, -(approach?.velocityY ?? state.vy) + to.velocity);
    state.py = to.y + SKIN; state.vy = 0; state.grounded = true;
    break;
  }
  return impact;
}
