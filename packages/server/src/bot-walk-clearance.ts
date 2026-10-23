import { PLAYER } from '@shared/constants';
import { VehicleCollisionSelection } from '@shared/vehicle-collision';
import type { KinState } from '@shared/physics';
import type { World } from '@shared/worldgen';

/** Steering uses the same rotated hulls as pedestrian collision, including
 * a short projected pose for moving convoys. Physical resolution stays in
 * the ordinary controller; this prevents repeatedly walking into a fender. */
export function walkingHullClearance(world:World,state:KinState,tick:number):(heading:number)=>boolean {
  const current=world.vehicleCollisions?.select(state,.05,tick);
  if(!current)return()=>true;
  const moving=current.hulls.some(h=>Math.hypot(h.hull.vx,h.hull.vy,h.hull.vz)>.1);
  const future=moving?world.vehicleCollisions?.select(state,.05,tick+6):undefined;
  const hulls=future?new VehicleCollisionSelection([...current.hulls,...future.hulls]):current;
  const distance=4,margin=.18,limit=distance+margin;
  const clearance=(x:number,z:number)=>Math.min(
    hulls.distance(x,state.py+PLAYER.RADIUS,z,limit+PLAYER.RADIUS),
    hulls.distance(x,state.py+PLAYER.HEIGHT*.5,z,limit+PLAYER.RADIUS),
    hulls.distance(x,state.py+PLAYER.HEIGHT-PLAYER.RADIUS,z,limit+PLAYER.RADIUS))-PLAYER.RADIUS;
  const start=clearance(state.px,state.pz);
  // Exact box distances are metric; a hull farther away than this entire
  // route cannot touch any of its capsule samples, including overhead jets.
  if(start>=limit)return()=>true;
  return heading=>{
    const dx=-Math.sin(heading),dz=-Math.cos(heading);let previous=start;
    for(let i=1;i<=12;i++){
      const along=distance*i/12,next=clearance(state.px+dx*along,state.pz+dz*along);
      // A bot already touching a hull must be allowed to escape. Until it
      // clears the margin, accept only routes that move out of the contact.
      if(previous<margin?next<previous-.02:next<margin)return false;
      if(i===1&&start<margin&&next<start+.025)return false;
      previous=next;
    }
    return previous>=margin&&previous>Math.min(start,margin)-.001;
  };
}
