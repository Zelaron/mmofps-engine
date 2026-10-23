import { PLAYER } from '@shared/constants';
import type { KinState } from '@shared/physics';
import type { VehicleCollisionSelection } from '@shared/vehicle-collision';

/** Narrow the ordinary controller's deliberately wide moving-hull broad phase
 * only when the complete bodies cannot meet during the deferred interval.
 * Keep the model's orientation-independent radius: a turning wing or turret
 * must not disappear merely because its current narrow side faces the bot. */
export function movingHullCanReach(selection:VehicleCollisionSelection|undefined,state:KinState,dt:number):boolean {
  if(!selection)return false;
  const capsuleRadius=PLAYER.HEIGHT/2,cy=state.py+capsuleRadius;
  const footSpeed=Math.max(PLAYER.RUN_SPEED,Math.hypot(state.vx,state.vy,state.vz));
  // 300 m/s² exceeds ordinary combined pedestrian/hull acceleration, with
  // another 35 cm for contact skin and integration error. HYPER/action edges
  // are excluded by the caller; current high velocities are included here.
  const margin=.5*300*dt*dt+.35;
  for(const active of selection.hulls){
    const hull=active.hull,speed=Math.hypot(hull.vx,hull.vy,hull.vz);
    if(speed<=1)continue; // Preserve the existing stationary-hull policy.
    const reach=hull.radius+capsuleRadius+(footSpeed+speed)*dt+margin,reachSq=reach*reach;
    // Previous support may still carry the actor even when the current hull
    // origin has moved away. Both endpoints and the full travel budget remain
    // covered; this predicate is re-evaluated from live poses every tick.
    if((state.px-active.x)**2+(cy-active.y)**2+(state.pz-active.z)**2<=reachSq||
      (state.px-active.beforeX)**2+(cy-active.beforeY)**2+(state.pz-active.beforeZ)**2<=reachSq)return true;
  }
  return false;
}
