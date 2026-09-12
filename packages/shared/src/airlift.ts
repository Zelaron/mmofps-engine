import { TICK_RATE } from './constants.js';
import { clamp, lerp } from './math.js';
import type { TransportPlan, TransportPoint } from './transport.js';

export interface AirliftFlight { source: number; destination: number; startTick: number; durationTicks: number }
export const AIRLIFT_CHARGE_SECONDS = 3;
export const AIRLIFT_CRUISE_HEIGHT = 1800;
export function airliftDuration(a: TransportPoint, b: TransportPoint): number {
  return clamp(12 + Math.hypot(b.x-a.x,b.z-a.z)/900,14,30);
}
const ease = (a: number,b: number,t: number) => {
  const x=clamp((t-a)/(b-a),0,1);return x*x*x*(x*(x*6-15)+10);
};
/** A server-authored launch, high cruise and soft descent. The complete
 * trajectory is reproduced from eight bytes of snapshot state on reconnect. */
export function airliftPose(plan: Pick<TransportPlan,'pods'>, flight: AirliftFlight, tick: number) {
  const a=plan.pods.find(p=>p.id===flight.source), b=plan.pods.find(p=>p.id===flight.destination);
  if(!a||!b||flight.durationTicks<=0)return undefined;
  const progress=clamp((tick-flight.startTick)/flight.durationTicks,0,1);
  const point=(t: number) => {
    if(t<=0)return {x:a.x,y:a.y+.08,z:a.z};
    if(t>=1)return {x:b.x,y:b.y+.08,z:b.z};
    const travel=ease(.16,.84,t), rise=ease(0,.23,t), descend=ease(.77,1,t);
    return {x:lerp(a.x,b.x,travel),y:lerp(a.y,b.y,travel)+.08+AIRLIFT_CRUISE_HEIGHT*rise*(1-descend),z:lerp(a.z,b.z,travel)};
  };
  const p=point(progress), delta=.001, before=point(Math.max(0,progress-delta)), after=point(Math.min(1,progress+delta));
  const span=(Math.min(1,progress+delta)-Math.max(0,progress-delta))*flight.durationTicks/TICK_RATE;
  const moving=progress>0&&progress<1?1:0;
  return {...p,vx:(after.x-before.x)/span*moving,vy:(after.y-before.y)/span*moving,vz:(after.z-before.z)/span*moving,
    progress,heading:Math.atan2(a.x-b.x,a.z-b.z),remaining:Math.max(0,(flight.startTick+flight.durationTicks-tick)/TICK_RATE)};
}
