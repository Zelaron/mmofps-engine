import { LOCK_LOCKED, VEHICLE, vehicleDefinition, type AircraftThreat } from '@shared/index';
import type { Projectile, ServerPlayer, ServerVehicle } from './game.js';

/** Read authoritative locks rather than client interest-range entities: a
 * distant launcher must warn both seats even when it is not being rendered. */
export function aircraftThreatFor(
  player: ServerPlayer,
  players: ReadonlyMap<number, ServerPlayer>,
  projectiles: ReadonlyMap<number, Projectile>,
  vehicles: ReadonlyMap<number, ServerVehicle>,
  areEnemies: (a: ServerPlayer, b: ServerPlayer) => boolean,
): AircraftThreat | undefined {
  const hull = vehicles.get(player.vehicleId);
  if (!player.state.alive || player.state.vehicle !== VEHICLE.JET || !hull ||
      hull.health <= 0 || hull.respawnAtTick >= 0 ||
      (hull.occupant !== player.id && hull.gunner !== player.id)) return;
  const pilot = players.get(hull.occupant);
  if (!pilot?.state.alive || pilot.vehicleId !== hull.id) return;
  const s = pilot.state, y = s.py + vehicleDefinition(hull.type, hull.variant)!.radius;
  let threat: AircraftThreat | undefined, closest = Infinity;
  for (const shooter of players.values()) {
    if (!shooter.state.alive || shooter.weapon !== 3 || shooter.lockTicks <= 0 ||
        shooter.lockVehicleId !== hull.id || !areEnemies(player, shooter)) continue;
    const dx = shooter.state.px - s.px, dz = shooter.state.pz - s.pz;
    const distance = Math.hypot(dx, shooter.state.py - s.py, dz);
    const stage = shooter.lockState === LOCK_LOCKED ? 2 : 1;
    if (!threat || stage > threat.stage || (stage === threat.stage && distance < closest)) {
      threat = { stage, bearing: Math.atan2(-dx, -dz), eta: 0 };
      closest = distance;
    }
  }
  let soonest = Infinity;
  for (const rocket of projectiles.values()) {
    if (rocket.homingVehicleId !== hull.id || (rocket.homingTarget ?? -1) < 0) continue;
    const owner = players.get(rocket.owner);
    if (owner && !areEnemies(player, owner)) continue;
    const dx = rocket.x - s.px, dy = rocket.y - y, dz = rocket.z - s.pz;
    const distance = Math.hypot(dx, dy, dz);
    const closingSpeed = distance > .01
      ? -((rocket.vx - s.vx) * dx + (rocket.vy - s.vy) * dy + (rocket.vz - s.vz) * dz) / distance
      : Infinity;
    // Retain the warning during a break turn, even if closure briefly stops.
    const eta = Math.min(30, distance / Math.max(20, closingSpeed));
    if (eta < soonest) {
      soonest = eta;
      threat = { stage: 3, bearing: Math.atan2(-dx, -dz), eta };
    }
  }
  return threat;
}
