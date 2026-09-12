import { viewDir, clamp } from './math.js';
import { vehicleQuaternion, rotateVector, type VehicleOrientation } from './rotation.js';

/** A 40 degree full cone centered on the aircraft's local underside. */
export const CREW_CONE_HALF_ANGLE = Math.PI / 9;
export function aircraftCrewAim(state: VehicleOrientation, yaw: number, pitch: number): { yaw: number; pitch: number } {
  const q = vehicleQuaternion(state), aim = viewDir(yaw, pitch);
  const local = rotateVector({ x: -q.x, y: -q.y, z: -q.z, w: q.w }, aim.x, aim.y, aim.z);
  const angle = Math.acos(clamp(-local.y, -1, 1));
  if (angle > CREW_CONE_HALF_ANGLE) {
    const length = Math.hypot(local.x, local.z);
    const scale = Math.sin(CREW_CONE_HALF_ANGLE) / Math.max(1e-9, length);
    local.x = length > 1e-9 ? local.x * scale : 0;
    local.z = length > 1e-9 ? local.z * scale : -Math.sin(CREW_CONE_HALF_ANGLE);
    local.y = -Math.cos(CREW_CONE_HALF_ANGLE);
  }
  const world = rotateVector(q, local.x, local.y, local.z);
  return { yaw: Math.atan2(-world.x, -world.z), pitch: Math.atan2(world.y, Math.hypot(world.x, world.z)) };
}
