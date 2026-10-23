import type { World } from '@shared/index';

/** Bounded forward hull probes include the roof and shoulders. A clear pilot
 * eye ray alone can lead a tank into a low arcade or clip a roadside pier.
 * Ground-facing contacts are driveable slopes, not walls to steer away from. */
export function vehicleCourseBlocked(world: World, x: number, y: number, z: number,
  heading: number, radius: number, look: number): boolean {
  const fx = -Math.sin(heading), fz = -Math.cos(heading), rx = Math.cos(heading), rz = -Math.sin(heading);
  const distance = Math.max(0, look) + radius * .65;
  const probes = [[0, 0], [-.93, 0], [.93, 0], [0, .96], [-.66, .66], [.66, .66],
    [-.8, -.45], [.8, -.45]] as const;
  for (const [side, up] of probes) {
    const hit = world.trace(x + rx * side * radius, y + radius * (1 + up), z + rz * side * radius,
      // Steering feelers sample at most 15 cm apart near a grazing surface.
      // All eight hull probes remain; actual hull movement and weapon rays
      // retain the canonical fine collision queries.
      fx, 0, fz, distance, true, .15);
    if (hit.hit && hit.ny < .55) return true;
  }
  return false;
}
