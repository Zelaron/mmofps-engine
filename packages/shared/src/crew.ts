import { viewDir, clamp } from './math.js';
import { vehicleQuaternion, rotateVector, type VehicleOrientation } from './rotation.js';
import { VEHICLE, VEHICLE_VARIANT, validVehicleVariant } from './vehicle-identity.js';

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

type AirframePoint = Readonly<{ x: number; y: number; z: number }>;
/** A gun position aboard the Condor, in airframe coordinates (+x to the right
 * wing, +y up, +z toward the tail). `yaw` and `pitch` turn the nose direction
 * onto `dir`, the axis of the station's field of fire. */
export interface AircrewStation {
  readonly name: string;
  readonly yaw: number;
  readonly pitch: number;
  readonly dir: AirframePoint;
  readonly eye: AirframePoint;
  readonly muzzle: AirframePoint;
}
/** Each gun swings about 69 degrees off its station's axis. */
export const CONDOR_STATION_CONE = 1.2;
/** A player's `station` counts from 1 and indexes this list less one; 0 or
 * undefined is the hull's ordinary gunner seat. */
export const CONDOR_STATIONS: readonly AircrewStation[] = [
  { name: 'Ventral', yaw: 0, pitch: -Math.PI / 2, dir: { x: 0, y: -1, z: 0 },
    eye: { x: 0, y: .62, z: 3 }, muzzle: { x: 0, y: .12, z: 3.25 } },
  { name: 'Dorsal', yaw: 0, pitch: Math.PI / 2, dir: { x: 0, y: 1, z: 0 },
    eye: { x: 0, y: 4.4, z: -5 }, muzzle: { x: 0, y: 4.9, z: -5.4 } },
  { name: 'Left waist', yaw: Math.PI / 2, pitch: 0, dir: { x: -1, y: 0, z: 0 },
    eye: { x: -1.1, y: 2.65, z: 6.5 }, muzzle: { x: -2, y: 2.25, z: 6.5 } },
  { name: 'Right waist', yaw: -Math.PI / 2, pitch: 0, dir: { x: 1, y: 0, z: 0 },
    eye: { x: 1.1, y: 2.65, z: 6.5 }, muzzle: { x: 2, y: 2.25, z: 6.5 } },
  { name: 'Tail', yaw: Math.PI, pitch: 0, dir: { x: 0, y: 0, z: 1 },
    eye: { x: 0, y: 3.05, z: 10.3 }, muzzle: { x: 0, y: 2.85, z: 11.2 } },
];

/** The Condor gun position this crew member occupies, if any. */
export function condorStation(state: { vehicle?: number; vehicleVariant?: number; seat?: number; station?: number }): AircrewStation | undefined {
  if (state.seat !== 1 || !state.station || state.vehicle !== VEHICLE.JET ||
    validVehicleVariant(state.vehicle, state.vehicleVariant) !== VEHICLE_VARIANT.CONDOR) return undefined;
  return CONDOR_STATIONS[state.station - 1];
}

/** Keep a Condor gunner's aim inside their station's field of fire. */
export function condorStationAim(state: VehicleOrientation, station: AircrewStation, yaw: number, pitch: number): { yaw: number; pitch: number } {
  const q = vehicleQuaternion(state), aim = viewDir(yaw, pitch), axis = station.dir;
  const local = rotateVector({ x: -q.x, y: -q.y, z: -q.z, w: q.w }, aim.x, aim.y, aim.z);
  const along = clamp(local.x * axis.x + local.y * axis.y + local.z * axis.z, -1, 1);
  if (Math.acos(along) <= CONDOR_STATION_CONE) return { yaw, pitch };
  let ox = local.x - axis.x * along, oy = local.y - axis.y * along, oz = local.z - axis.z * along;
  const off = Math.hypot(ox, oy, oz);
  // Aiming straight back along the axis has no nearest rim point; any will do.
  if (off < 1e-9) { ox = axis.y; oy = axis.z; oz = axis.x; } else { ox /= off; oy /= off; oz /= off; }
  const c = Math.cos(CONDOR_STATION_CONE), s = Math.sin(CONDOR_STATION_CONE);
  const world = rotateVector(q, axis.x * c + ox * s, axis.y * c + oy * s, axis.z * c + oz * s);
  return { yaw: Math.atan2(-world.x, -world.z), pitch: Math.atan2(world.y, Math.hypot(world.x, world.z)) };
}
