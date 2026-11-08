import { BTN, type InputCmd, type MoveState } from './movement.js';
import { clamp } from './math.js';
import { vehicleDefinition, boatDraft, hullKeel } from './vehicles.js';
import { sphereFieldContact } from './physics.js';
import type { World } from './worldgen.js';

export function stepBoat(world: World, s: MoveState, cmd: InputCmd, dt: number): number {
  const def = vehicleDefinition(s.vehicle, s.vehicleVariant), b = cmd.buttons;
  if (!def) return 0;
  const draft = boatDraft(s.vehicleVariant);
  const fluid = world.liquidAt(s.px, s.py + draft - .08, s.pz);
  const throttle = Number((b & BTN.FORWARD) !== 0) - Number((b & BTN.BACK) !== 0);
  const steer = Number((b & BTN.LEFT) !== 0) - Number((b & BTN.RIGHT) !== 0);
  const speed = Math.hypot(s.vx, s.vz);
  s.heading += steer * def.turnRate * clamp(.22 + speed / 9, 0, 1) * dt;
  const fx = -Math.sin(s.heading), fz = -Math.cos(s.heading);
  if (fluid) {
    const target = throttle * (throttle < 0 ? def.reverseSpeed : def.maxSpeed), forward = s.vx * fx + s.vz * fz;
    const next = forward + clamp(target - forward, -def.accel * dt, def.accel * dt);
    const grip = Math.min(1, dt * 2.4);
    s.vx = fx * next + (s.vx - fx * forward) * (1 - grip);
    s.vz = fz * next + (s.vz - fz * forward) * (1 - grip);
    // Buoyancy uses the sampled river/lake level, never a global sea plane.
    s.vy = clamp((fluid.surfaceY - draft - s.py) * 9, -5, 5);
    s.vehiclePitch = Math.sin((s.simulationTick ?? 0) * .025) * .006;
    s.vehicleRoll = -steer * Math.min(.055, speed * .002);
  } else { s.vy -= 20 * dt; s.vx *= Math.max(0, 1 - dt * 1.8); s.vz *= Math.max(0, 1 - dt * 1.8); }
  s.boosting = false; s.grounded = false;
  let impact = 0;
  // A long hull meets land and quays with spheres at its bow, midships and
  // stern (local -z is the bow); a gunboat is one sphere at its origin.
  const keel = hullKeel(s.vehicle, s.vehicleVariant);
  const steps = Math.max(1, Math.ceil(Math.hypot(s.vx, s.vy, s.vz) * dt / .65));
  for (let i = 0; i < steps; i++) {
    s.px += s.vx * dt / steps; s.py += s.vy * dt / steps; s.pz += s.vz * dt / steps;
    for (const along of keel) {
      for (let iter = 0; iter < 4; iter++) {
        const c = sphereFieldContact(world, s.px + Math.sin(s.heading) * along, s.py + def.radius,
          s.pz + Math.cos(s.heading) * along, def.radius);
        if (!c) break;
        s.px += c.mx * c.depth; s.py += c.my * c.depth; s.pz += c.mz * c.depth;
        const vn = s.vx * c.nx + s.vy * c.ny + s.vz * c.nz;
        if (vn < 0) { if (c.ny < .5) impact = Math.max(impact, -vn); s.vx -= vn * c.nx; s.vy -= vn * c.ny; s.vz -= vn * c.nz; }
        if (c.ny > .5) s.grounded = true;
      }
    }
  }
  return impact;
}
