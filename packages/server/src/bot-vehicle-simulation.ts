import { PLAYER, TICK_RATE } from '@shared/constants';
import { BTN, stepMove, type InputCmd, type MoveState, type StepResult } from '@shared/movement';
import { JEEP_BOOST_ACCEL, JEEP_BOOST_REGEN, VEHICLE, vehicleDefinition, vehicleEyeOffset } from '@shared/vehicles';
import { transitDistance } from '@shared/transit-motion';
import type { World } from '@shared/worldgen';
import type { ServerPlayer, ServerVehicle } from './game.js';

const MAX_MOVEMENT_DT = 4 / TICK_RATE;
const BOT_COMBAT_RADIUS = 150;
const CLOSE_INTERACTION_RADIUS = 20;
interface CrewState { hull: number; seat: number; health: number; hurtUntil: number; changedAt: number }
const stepStats={batches:0,blocked:0,substeps:0,stationary:0,reusedContact:0};
const remoteStates=new WeakSet<MoveState>();
const motionButtons=BTN.FORWARD|BTN.BACK|BTN.LEFT|BTN.RIGHT|BTN.ALTFIRE|BTN.USE|BTN.JUMP|BTN.DODGE;
interface RestContact {world:World;x:number;y:number;z:number;heading:number;vehicle:number;variant:number;buttons:number;expires:number}
const restContacts=new WeakMap<MoveState,RestContact>();

/** A pending remote remainder can be promoted by damage, boarding interest or
 * a boost edge. Resolve unsafe promoted motion at ordinary bounded steps. */
export function stepBotGroundVehicle(world: World, state: MoveState, command: InputCmd, dt: number, tick: number): StepResult {
  stepStats.batches++;
  const x=state.px,y=state.py,z=state.pz;
  const def = vehicleDefinition(state.vehicle,state.vehicleVariant)!;
  const heading=state.heading,buttons=command.buttons&motionButtons,rest=restContacts.get(state);
  if(rest&&remoteStates.has(state)&&rest.world===world&&tick<=rest.expires&&rest.buttons===buttons&&
    rest.heading===heading&&rest.vehicle===state.vehicle&&rest.variant===state.vehicleVariant&&state.grounded&&
    Math.hypot(x-rest.x,y-rest.y,z-rest.z)<.002&&Math.hypot(state.vx,state.vy,state.vz)<.02){
    const eye=vehicleEyeOffset(state);
    if(!world.liquidAt(x+eye.x,y+eye.y,z+eye.z)&&
      !world.collectCityLifts().some(l=>Math.abs(l.x-x)<l.hx+def.radius&&Math.abs(l.z-z)<l.hz+def.radius)&&
      transitDistance(world,tick/TICK_RATE,x,y+def.radius,z,24)>=24){
      // Shared physics just proved this unchanged ground/wall contact. Only
      // the held-input timers can change before its short revalidation.
      state.vx=0;state.vy=0;state.vz=0;state.simulationTick=tick;world.motionTime=tick/TICK_RATE;
      state.jumpHeld=(command.buttons&BTN.JUMP)!==0;state.jumpAscent=false;
      state.dodgeCd=Math.max(0,state.dodgeCd-dt);state.boosting=false;state.submerged=false;state.swimming=false;
      state.airSeconds=Math.min(18,(state.airSeconds??18)+dt*5);
      if(state.vehicle===VEHICLE.JEEP)state.boostFuel=Math.min(1,state.boostFuel+JEEP_BOOST_REGEN*dt);
      stepStats.reusedContact++;
      return{impact:0,transitImpact:0,jumped:false,dodged:false};
    }
  }
  restContacts.delete(state);
  const acceleration = Math.max(def.accel,command.buttons & BTN.ALTFIRE ? JEEP_BOOST_ACCEL : 0)+PLAYER.GRAVITY;
  const travel = (Math.hypot(state.vx,state.vy,state.vz)+acceleration*dt)*dt;
  const speed=Math.hypot(state.vx,state.vz),ux=speed>.01?state.vx/speed:-Math.sin(state.heading),uz=speed>.01?state.vz/speed:-Math.cos(state.heading);
  // The canonical sphere solver samples its shell. A very thin wall can
  // fall between those endpoint samples even when travel is below a radius.
  // Trace the leading shell and its flanks across this short pending step;
  // near geometry, keep exactly the ordinary contact cadence.
  const blocked=dt>1/TICK_RATE+.000001&&[0,-.707,.707].some(side=>{
    const ahead=Math.sqrt(1-side*side)*def.radius,lateral=side*def.radius;
    return world.trace(state.px+ux*ahead-uz*lateral,state.py+def.radius,
      state.pz+uz*ahead+ux*lateral,ux,0,uz,travel,false).hit;
  });
  const steps = blocked || travel > def.radius*.75 || !state.grounded || state.boosting || command.buttons & BTN.ALTFIRE
    ? Math.max(Math.ceil(dt*TICK_RATE-.000001),Math.ceil(travel/(def.radius*.75))) : 1;
  const result: StepResult = {impact:0,transitImpact:0,jumped:false,dodged:false};
  if(blocked)stepStats.blocked++;stepStats.substeps+=steps;
  for(let i=0;i<steps;i++) {
    // Distant admitted convoys follow the contact slope without the arcade
    // crest-launch impulse. Default and promoted steps retain that assistance;
    // no World or replicated-state flag can leak into another actor's physics.
    const allowCrestLaunch=!remoteStates.has(state)||!state.grounded||state.boosting||
      Math.abs(state.vy)>3||!!(command.buttons&BTN.ALTFIRE);
    const next=stepMove(world,state,command,dt/steps,tick-(steps-i-1)*dt/steps*TICK_RATE,allowCrestLaunch);
    result.impact=Math.max(result.impact,next.impact);result.transitImpact=Math.max(result.transitImpact,next.transitImpact);
    result.jumped ||= next.jumped;result.dodged ||= next.dodged;
  }
  if(Math.hypot(state.px-x,state.py-y,state.pz-z)<.002){
    stepStats.stationary++;
    if(remoteStates.has(state)&&state.grounded&&Math.hypot(state.vx,state.vy,state.vz)<.02&&state.heading===heading)
      restContacts.set(state,{world,x:state.px,y:state.py,z:state.pz,heading,vehicle:state.vehicle,
        variant:state.vehicleVariant,buttons,expires:tick+12});
  }
  return result;
}

/** Only distant bot crews use a coarser steering/ground-motion cadence.
 * Human occupants, nearby fights and all aircraft retain ordinary physics.
 * The scheduler never handles weapons, damage, crew attachment or cooldowns. */
export class BotVehicleSimulation {
  readonly stats = { thoughtDeferred: 0, movementEligible: 0, movementChecks: 0,
    movementThree:0,movementFour:0,reasons: {} as Record<string, number>,steps:stepStats };
  private tick = -1;
  private enabled = false;
  private readonly factionActors: ServerPlayer[][] = [[],[],[],[]];
  private humans: readonly ServerPlayer[] = [];
  private readonly hullsById = new Map<number,ServerVehicle>();
  private readonly crew = new WeakMap<ServerPlayer, CrewState>();

  prepare(tick: number, enabled: boolean, actors: readonly ServerPlayer[], humans: readonly ServerPlayer[], hulls: readonly ServerVehicle[]): void {
    this.tick = tick; this.enabled = enabled; this.humans = humans;
    // Bot allegiance is assigned before admission/import and does not change
    // during the synchronous controller pass. Human enlistment is handled
    // between passes; nearby humans always promote independently of faction.
    // Rebuild on every prepare, even an explicit repeat at the same tick.
    for (const group of this.factionActors) group.length=0;
    for (const actor of actors) this.factionActors[actor.faction].push(actor);
    this.hullsById.clear();
    for (const hull of hulls) this.hullsById.set(hull.id,hull);
  }

  reset(player: ServerPlayer): void { this.crew.delete(player);remoteStates.delete(player.state);restContacts.delete(player.state); }

  private state(player: ServerPlayer): CrewState | undefined {
    const hull = this.hullsById.get(player.vehicleId);
    if (!hull || hull.respawnAtTick >= 0 || hull.health <= 0) return;
    let record = this.crew.get(player);
    if (!record || record.hull !== hull.id || record.seat !== (player.state.seat ?? 0)) {
      record = { hull: hull.id, seat: player.state.seat ?? 0, health: hull.health, hurtUntil: -1, changedAt: this.tick };
      this.crew.set(player, record);
    }
    if (hull.health < record.health) record.hurtUntil = this.tick + TICK_RATE;
    record.health = hull.health;
    return record;
  }

  /** -1 requires full updates; 0 is quiet; 1 is distant bot combat. */
  private remoteCombat(player: ServerPlayer, radius: number): -1|0|1 {
    const s = player.state;
    if (!this.enabled || !player.isBot || !s.alive || !s.vehicle || s.vehicle === VEHICLE.JET || s.airlift || player.airlift || s.submerged) return -1;
    const nearHumans=this.humans;
    // Keep each pass's length snapshot and live reads without query callbacks.
    for(let i=0,length=nearHumans.length;i<length;i++) {
      if(!(i in nearHumans))continue;
      const h=nearHumans[i];
      if((h.state.px-s.px)**2+(h.state.pz-s.pz)**2 < radius*radius)return -1;
    }
    // An allied human crew member is authoritative even if its previous pose
    // has not yet been copied from a newly boarded or relocated driver.
    const crewHumans=this.humans;
    for(let i=0,length=crewHumans.length;i<length;i++) {
      if(!(i in crewHumans))continue;
      const h=crewHumans[i];
      if(h.vehicleId >= 0 && h.vehicleId === player.vehicleId)return -1;
    }
    const record = this.state(player);
    if (!record || record.hurtUntil > this.tick || record.changedAt >= this.tick) return -1;
    let combat:0|1=0;
    for (let faction=1;faction<this.factionActors.length;faction++) {
      if (faction===player.faction) continue;
      const actors=this.factionActors[faction];
      for(let i=0;i<actors.length;i++) {
        const other=actors[i];
        if (!other.faction || other.faction === player.faction || !other.state.alive || Math.abs(other.state.py-s.py) >= 80) continue;
        const distance2=(other.state.px-s.px)**2+(other.state.pz-s.pz)**2;
        if (distance2 < CLOSE_INTERACTION_RADIUS**2) return -1;
        if (distance2 < BOT_COMBAT_RADIUS**2) combat=1;
      }
    }
    return combat;
  }

  shouldThink(player: ServerPlayer, humanRadius: number): boolean {
    const combat=this.remoteCombat(player,humanRadius);
    if (combat<0 || player.state.boosting || player.lastCmd && player.lastCmd.buttons & (BTN.USE|BTN.JUMP|BTN.DODGE) ||
      player.state.vehicle !== VEHICLE.GUNBOAT && (!player.state.grounded || Math.abs(player.state.vy) > 3)) return true;
    const interval=combat||player.lastCmd&&(player.lastCmd.buttons&(BTN.FIRE|BTN.ALTFIRE))?6:12;
    const think = (this.tick+(player.botRosterIndex??player.id))%interval === 0;
    if (!think) this.stats.thoughtDeferred++;
    return think;
  }

  movementEligible(player: ServerPlayer, command: InputCmd, dt: number, humanRadius: number): boolean {
    return this.movementCadence(player,command,dt,humanRadius)>0;
  }

  movementCadence(player: ServerPlayer, command: InputCmd, dt: number, humanRadius: number): 0|3|4 {
    this.stats.movementChecks++;
    const s=player.state;
    const def=vehicleDefinition(s.vehicle,s.vehicleVariant);
    let cadence:3|4=4;
    let reason: string | undefined;
    if (s.vehicle!==VEHICLE.JEEP && s.vehicle!==VEHICLE.TANK || (s.seat??0)!==0) reason='type/crew';
    else if (this.remoteCombat(player,humanRadius)<0) reason='interest/combat';
    else if (!s.grounded || s.jumpAscent || Math.abs(s.vy)>3 || s.boosting) reason='air/boost';
    else if (command.buttons & (BTN.USE|BTN.ALTFIRE) || Math.abs(dt-1/TICK_RATE)>.000001) reason='input/substep';
    else {
      // stepVehicle integrates once before its sphere contact, so the full
      // deferred displacement must stay well inside the hull radius. Fast
      // boosts and airborne arcs cannot use this bounded ground cadence.
      const speed=Math.hypot(s.vx,s.vy,s.vz),acceleration=def!.accel+PLAYER.GRAVITY;
      const distance=(speed+acceleration*MAX_MOVEMENT_DT)*MAX_MOVEMENT_DT;
      if(distance>def!.radius*.75){
        // A normal cruising jeep can retain its existing three-tick cadence
        // even when four ticks would exceed the same collision bound.
        const shorter=3/TICK_RATE;
        if((speed+acceleration*shorter)*shorter<=def!.radius*.75)cadence=3;
        else reason='sweep distance';
      }
    }
    if (reason) { remoteStates.delete(s);restContacts.delete(s);this.stats.reasons[reason]=(this.stats.reasons[reason]??0)+1; return 0; }
    remoteStates.add(s);
    this.stats.movementEligible++;
    if(cadence===4)this.stats.movementFour++;else this.stats.movementThree++;
    return cadence;
  }
}
