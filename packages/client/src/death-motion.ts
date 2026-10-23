import type { DeathMotion } from '@shared/protocol';
import type { World } from '@shared/worldgen';

export const DEATH_CAMERA_SECONDS = 1.8;
export interface CorpseMotion extends DeathMotion { age: number; grounded: boolean; airborne: boolean }

export function createCorpseMotion(motion: DeathMotion): CorpseMotion {
  return { ...motion, y: motion.y + .9, age: 0, grounded: false, airborne: motion.vy > 4 || Math.hypot(motion.vx, motion.vz) > 14 };
}

/** Cosmetic body motion starts with the authoritative lethal impulse. It
 * cannot push living actors or modify the server's respawn position. */
export function stepCorpseMotion(body: CorpseMotion, world: Pick<World, 'trace'>, seconds: number): void {
  const span = Math.min(.1, Math.max(0, seconds)), steps = Math.max(1, Math.ceil(span / .02)), dt = span / steps;
  for (let i = 0; i < steps; i++) {
    body.age += dt;
    if (body.grounded) {
      body.vx *= Math.exp(-8 * dt); body.vz *= Math.exp(-8 * dt);
    } else body.vy -= 18 * dt;
    const dx = body.vx * dt, dy = body.vy * dt, dz = body.vz * dt, distance = Math.hypot(dx, dy, dz);
    if (distance < 1e-7) {
      // A lift or moving platform can leave a settled body behind.
      const floor = world.trace(body.x, body.y, body.z, 0, -1, 0, .44);
      body.grounded = floor.hit && floor.ny > .55;
      continue;
    }
    const hit = world.trace(body.x, body.y, body.z, dx / distance, dy / distance, dz / distance, distance + .36);
    if (hit.hit) {
      const travel = Math.max(0, hit.dist - .37);
      body.x += dx / distance * travel; body.y += dy / distance * travel; body.z += dz / distance * travel;
      const normalSpeed = body.vx * hit.nx + body.vy * hit.ny + body.vz * hit.nz;
      if (normalSpeed < 0) {
        const bounce = body.age < .7 && normalSpeed < -7 ? 1.15 : 1;
        body.vx -= normalSpeed * hit.nx * bounce; body.vy -= normalSpeed * hit.ny * bounce; body.vz -= normalSpeed * hit.nz * bounce;
      }
      if (hit.ny > .55 && Math.abs(body.vy) < 3) { body.grounded = true; body.vy = 0; }
    } else {
      body.x += dx; body.y += dy; body.z += dz;
      const floor = world.trace(body.x, body.y, body.z, 0, -1, 0, .44);
      body.grounded = floor.hit && floor.ny > .55 && body.vy <= 0;
      if (body.grounded) { body.y = floor.y + .37; body.vy = 0; }
    }
  }
}
