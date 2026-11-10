import { CONDOR_CARPET, jetBombBay, vehicleLocalOffset, type MoveState, type World } from '@shared/index';

/** Where a bomb released now comes down: the same launch as the server's carpet
 * and a free fall solved in closed form, refined against the ground it lands on.
 * Writes the point to `out` and returns false only for a hull with no drop. */
export function bombImpactPoint(world: Pick<World, 'groundY'>, s: MoveState, out: { set(x: number, y: number, z: number): unknown }): boolean {
  const gravity = CONDOR_CARPET.gravity ?? 22, bay = jetBombBay(s.vehicleVariant);
  const release = vehicleLocalOffset(s, bay.x, bay.y, bay.z), eject = vehicleLocalOffset(s, 0, -4, 0);
  const ox = s.px + release.x, oy = s.py + release.y, oz = s.pz + release.z;
  const vx = s.vx * .85 + eject.x, vy = Math.min(0, s.vy) + eject.y, vz = s.vz * .85 + eject.z;
  let x = ox, z = oz, ground = world.groundY(ox, oz);
  if (oy <= ground) return false;
  for (let i = 0; i < 4; i++) {
    const t = (vy + Math.sqrt(vy * vy + 2 * gravity * Math.max(0, oy - ground))) / gravity;
    x = ox + vx * t; z = oz + vz * t; ground = world.groundY(x, z);
  }
  out.set(x, ground, z);
  return true;
}
