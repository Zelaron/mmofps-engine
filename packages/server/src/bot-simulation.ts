import { NET, PLAYER, TICK_RATE, WORLD } from '@shared/constants';
import { BTN, type InputCmd } from '@shared/movement';
import { capsuleClearance, capsulePenetrates } from '@shared/physics';
import { transitDistance } from '@shared/transit-motion';
import { SWIMMING } from '@shared/liquids';
import { clamp } from '@shared/math';
import { World, type Box, type Region } from '@shared/worldgen';
import type { ServerPlayer, ServerVehicle } from './game.js';
import { BotVehicleSimulation } from './bot-vehicle-simulation.js';
import { movingHullCanReach } from './bot-moving-hull.js';
import { VEHICLE } from '@shared/vehicles';

/** Supported ordinary-ground travel is an intentional server-only approximation.
 * Humans and hazardous movement retain the shared controller. Thoughts, deferred
 * movement and vehicles keep their 300 m full-rate protection; supported on-foot
 * travel may advance every tick outside 200 m. Weapons and timers stay at 60 Hz. */
export const BOT_FULL_SIM_RADIUS = 300;
export const BOT_SUPPORTED_GROUND_RADIUS = 200;
export const BOT_LOD_MIN_POPULATION = 48;
const HORIZON = 24, PATH_STEP = .24, SKIN = .10;
// Treat very slow residual wall/ground contact creep as stopped for at most
// 200 ms. This is confined to distant bots and never advances through solids.
const REST_DRIFT=.015,REST_SPEED=.3;
const perceptionTrace=World.prototype.trace,perceptionSdf=World.prototype.sdf;
const SPECIAL = BTN.JUMP | BTN.DODGE | BTN.USE;
interface GroundPath { x:number;z:number;dx:number;dz:number;length:number;heights:number[];expires:number;authored?:boolean;
  capital?:boolean;
  rectangle?:{x0:number;x1:number;z0:number;z1:number;y0:number;y1:number};
  collectRegion?:World['collectRegion'];sampleColumn?:World['sampleColumn'];column?:World['column'];plane?:boolean;
  collectCities?:World['collectCities'];collectCaveSites?:World['collectCaveSites'];
  collectTransportPlan?:World['collectTransportPlan'];collectJungleTemples?:World['collectJungleTemples'] }
interface RestPose { x:number;y:number;z:number;buttons:number;yaw:number;expires:number }
interface WaterSpace { x0:number;x1:number;y0:number;y1:number;z0:number;z1:number;expires:number }
interface Slot { path?:GroundPath; water?:WaterSpace; waterRetry?:number; retry:number; elapsed:number; observed?:RestPose; rest?:RestPose }
const DIRECTION=BTN.FORWARD|BTN.BACK|BTN.LEFT|BTN.RIGHT;
const overlaps=(b:Box,x0:number,x1:number,z0:number,z1:number,y0:number,y1:number)=>
  b.x+b.hx>=x0&&b.x-b.hx<=x1&&b.z+b.hz>=z0&&b.z-b.hz<=z1&&b.y+b.hy>=y0&&b.y-b.hy<=y1;

// A custom field can add solids absent the generated capital metadata. Keep
// the previous full-controller fallback for every replaced World provider.
const capitalWorldPrototype=World.prototype;
const capitalWorldProviders=Object.getOwnPropertyNames(capitalWorldPrototype)
  .filter(key=>key!=='constructor'&&typeof (capitalWorldPrototype as unknown as Record<string,unknown>)[key]==='function')
  .map(key=>[key,(capitalWorldPrototype as unknown as Record<string,unknown>)[key]] as const);
function nativeCapitalProviders(world:World):boolean {
  if(Object.getPrototypeOf(world)!==capitalWorldPrototype)return false;
  const providers=world as unknown as Record<string,unknown>;
  for(let i=0;i<capitalWorldProviders.length;i++)if(providers[capitalWorldProviders[i][0]]!==capitalWorldProviders[i][1])return false;
  return true;
}

const nativeTerrainProviders=World.prototype.hasNativeTerrainProviders;
function authoredRectangleContains(path:GroundPath,x:number,y:number,z:number):boolean {
  const b=path.rectangle,pad=PLAYER.RADIUS+.12;
  if(!path.authored||!b)return false;
  const height=path.heights[0]+SKIN;
  return x-pad>=b.x0&&x+pad<=b.x1&&z-pad>=b.z0&&z+pad<=b.z1&&
    Math.min(y,height)>=b.y0&&Math.max(y,height)+PLAYER.HEIGHT+.2<=b.y1;
}

export class BotSimulation {
  private readonly vehicleSimulation=new BotVehicleSimulation();
  readonly stats={groundTicks:0,authoredTicks:0,authoredChecks:0,planeTicks:0,waterTicks:0,waterChecks:0,rejectedWater:0,restTicks:0,fullTicks:0,pathChecks:0,rejectedPaths:0,regionBuilds:0,regionHits:0,batchedTicks:0,batchedSteps:0,reasons:{} as Record<string,number>,vehicles:this.vehicleSimulation.stats};
  private reject(reason:string):false {this.stats.reasons[reason]=(this.stats.reasons[reason]??0)+1;return false;}
  private tick=-1;
  private rosterSize=-1;
  private enabled=false;
  private botObserver=false;
  private humans:ServerPlayer[]=[];
  private vehicles:readonly ServerVehicle[]=[];
  private readonly slots=new WeakMap<ServerPlayer,Slot>();
  private readonly regions=new WeakMap<World,Map<string,Region>>();

  invalidateRoster():void { this.tick=-1; }
  prepare(tick:number,players:Iterable<ServerPlayer>,vehicles:Iterable<ServerVehicle>,rosterSize=-1):void {
    if(tick===this.tick&&rosterSize===this.rosterSize)return;
    this.tick=tick;this.rosterSize=rosterSize;this.humans=[];this.botObserver=false;let bots=0;const actors:ServerPlayer[]=[];
    for(const p of players){actors.push(p);if(p.isBot){bots++;if(p.sink)this.botObserver=true;}else this.humans.push(p);}
    this.enabled=bots>=BOT_LOD_MIN_POPULATION;this.vehicles=[...vehicles];
    this.vehicleSimulation.prepare(tick,this.enabled,actors,this.humans,this.vehicles);
  }
  /** Perception alone may retain a remote ground crew's LOS for 24 ticks.
   * The expanded radius protects every possible acquisition candidate too.
   * Reuse prepare's human list; no actor scan or geometry belongs in this gate. */
  remoteGroundPerception(world:World,p:ServerPlayer,acquireRange:number):boolean {
    const s=p.state;
    if(!this.enabled||this.botObserver||!p.isBot||!s.alive||
      (s.vehicle!==VEHICLE.JEEP&&s.vehicle!==VEHICLE.TANK)||!s.grounded||s.jumpAscent||s.submerged||s.boosting||
      p.airlift||s.airlift||Object.getPrototypeOf(world)!==World.prototype||
      world.trace!==perceptionTrace||world.sdf!==perceptionSdf||
      !Number.isFinite(s.px+s.py+s.pz+s.vx+s.vy+s.vz)||s.vx*s.vx+s.vy*s.vy+s.vz*s.vz>100**2)return false;
    const radius=NET.INTEREST_RADIUS+acquireRange;
    for(let i=0;i<this.humans.length;i++){
      const h=this.humans[i],hs=h.state;
      if(h.airlift||hs.airlift||(h.vehicleId>=0&&h.vehicleId===p.vehicleId)||
        !Number.isFinite(hs.px+hs.py+hs.pz+hs.vx+hs.vy+hs.vz)||
        hs.vx*hs.vx+hs.vy*hs.vy+hs.vz*hs.vz>256**2)return false;
      const dx=hs.px-s.px,dz=hs.pz-s.pz,d2=dx*dx+dz*dz;
      if(!Number.isFinite(d2)||!(d2>radius*radius))return false;
    }
    return true;
  }
  private remote(p:ServerPlayer):boolean {
    const s=p.state;
    return this.enabled&&p.isBot&&s.alive&&!s.vehicle&&!p.airlift&&!s.airlift&&
      !this.humans.some(h=>(h.state.px-s.px)**2+(h.state.pz-s.pz)**2<BOT_FULL_SIM_RADIUS**2);
  }
  /** Only the per-tick supported-ground solver uses this nearer interest edge.
   * Water, vehicles, rest observations and deferred shared steps retain remote(). */
  private supportedGroundInterest(p:ServerPlayer):boolean {
    const s=p.state;
    return this.enabled&&p.isBot&&s.alive&&!s.vehicle&&!p.airlift&&!s.airlift&&
      s.grounded&&!s.swimming&&!s.submerged&&
      !this.humans.some(h=>(h.state.px-s.px)**2+(h.state.pz-s.pz)**2<BOT_SUPPORTED_GROUND_RADIUS**2);
  }
  shouldThink(p:ServerPlayer):boolean {
    if(p.state.vehicle)return this.vehicleSimulation.shouldThink(p,BOT_FULL_SIM_RADIUS);
    const immediate=p.state.swimming?SPECIAL&~BTN.JUMP:SPECIAL;
    if(!this.remote(p)||!p.state.grounded&&!p.state.swimming||p.lastCmd&&(p.lastCmd.buttons&immediate))return true;
    const fighting=!!((p.lastCmd?.buttons??0)&(BTN.FIRE|BTN.ALTFIRE))||
      p.regenBlockUntil>this.tick+(PLAYER.REGEN_DELAY-1)*TICK_RATE;
    return (this.tick+(p.botRosterIndex??p.id))%(fighting?6:12)===0;
  }
  /** Boarding is an immediate input edge. Previously deferred on-foot travel
   * must never become extra driving time in the newly occupied hull. */
  resetMovement(p:ServerPlayer):void { this.slots.delete(p);this.vehicleSimulation.reset(p); }
  /** Record the starting pose of an actual shared-physics step. If that
   * controller leaves a grounded actor still, its unchanged static contact
   * can be reused briefly instead of resolving the same wall/floor again. */
  private notePhysics(p:ServerPlayer,cmd:InputCmd,tick:number):void {
    const slot=this.slots.get(p)!;
    slot.observed=this.remote(p)?{x:p.state.px,y:p.state.py,z:p.state.pz,
      buttons:cmd.buttons&DIRECTION,yaw:cmd.buttons&DIRECTION?cmd.yaw:0,expires:tick+3}:undefined;
  }
  /** Remote movement is resolved at least every fourth tick, using all elapsed
   * time and the shared swept collision controller. The actor stays alive and
   * participates in weapons, damage and captures on the intervening ticks.
   * Interest promotion and movement edges flush the bounded remainder now. */
  physicsDt(world:World,p:ServerPlayer,cmd:InputCmd,dt:number,tick:number):number {
    let slot=this.slots.get(p);if(!slot){slot={retry:0,elapsed:0};this.slots.set(p,slot);}
    const s=p.state;
    const water=!!(s.swimming||s.submerged),immediate=s.swimming?SPECIAL&~BTN.JUMP:SPECIAL;
    const cadence=s.vehicle?this.vehicleSimulation.movementCadence(p,cmd,dt,BOT_FULL_SIM_RADIUS):4;
    const eligible=s.vehicle?cadence>0:this.remote(p)&&(s.grounded||water)&&!s.jumpAscent&&Math.abs(s.vy)<(water?SWIMMING.SPEED+1:3)&&
      !(cmd.buttons&(immediate|BTN.HYPER))&&dt<=1/TICK_RATE+.00001&&
      p.regenBlockUntil<=this.tick+(PLAYER.REGEN_DELAY-1)*TICK_RATE&&
      !world.collectTransportPlan().pods.some(pod=>(pod.x-s.px)**2+(pod.z-s.pz)**2<20**2)&&
      transitDistance(world,tick/TICK_RATE,s.px,s.py+1,s.pz,24)>=24&&
      !movingHullCanReach(world.vehicleCollisions?.select(s,4/TICK_RATE,tick),s,4/TICK_RATE);
    slot.elapsed+=dt;
    if(eligible&&(this.tick+(p.botRosterIndex??p.id))%cadence!==0&&slot.elapsed<cadence/TICK_RATE-.000001){
      this.stats.batchedTicks++;return 0;
    }
    const elapsed=slot.elapsed;slot.elapsed=0;
    if(elapsed>dt+.000001)this.stats.batchedSteps++;
    this.notePhysics(p,cmd,tick);
    return elapsed;
  }
  /** A successful return commits one supported movement tick. Otherwise the
   * caller runs ordinary shared physics, preserving all collision hazards. */
  move(world:World,p:ServerPlayer,cmd:InputCmd,dt:number,movementTick:number):boolean {
    const s=p.state;let slot=this.slots.get(p);if(!slot){slot={retry:0,elapsed:0};this.slots.set(p,slot);}
    const full=()=>{slot.path=undefined;slot.water=undefined;this.stats.fullTicks++;return false;};
    const water=!!s.swimming,immediate=water?SPECIAL&~BTN.JUMP:SPECIAL;
    const remote=this.remote(p);
    const reason=!remote&&!this.supportedGroundInterest(p)?'interest/vehicle':slot.elapsed>0?'pending':p.regenBlockUntil>this.tick+(PLAYER.REGEN_DELAY-1)*TICK_RATE?'combat':!s.grounded&&!water?'air':s.jumpAscent||s.dodgeCd>0?'jump':Math.abs(s.vy)>(water?SWIMMING.SPEED+1:3)?'slope'
      :cmd.buttons&(immediate|BTN.HYPER)?'input':dt>1/TICK_RATE+.00001?'burst'
      :world.vehicleCollisions?.select(s,dt,movementTick)?.distance(s.px,s.py+PLAYER.HEIGHT/2,s.pz,2)!<2?'near vehicle':null;
    if(reason){this.reject(reason);return full();}
    if(!remote&&!nativeTerrainProviders.call(world)){this.reject('providers');return full();}
    if(transitDistance(world,movementTick/TICK_RATE,s.px,s.py+1,s.pz,24)<24){this.reject('moving transit');return full();}
    if(water){
      if(this.swim(world,p,cmd,dt,movementTick,slot))return true;
      this.reject('water');return full();
    }
    if(s.submerged){this.reject('water');return full();}
    // A human entering the 200-300 m band must not inherit remote rest/creep
    // reuse. Only the existing proven supported path may advance here.
    if(!remote){slot.observed=undefined;slot.rest=undefined;}
    const sameRest=(pose:RestPose)=>movementTick<=pose.expires&&pose.buttons===(cmd.buttons&DIRECTION)&&
      pose.yaw===(cmd.buttons&DIRECTION?cmd.yaw:0)&&Math.hypot(s.px-pose.x,s.py-pose.y,s.pz-pose.z)<REST_DRIFT&&
      Math.hypot(s.vx,s.vz)<REST_SPEED&&Math.abs(s.vy)<.1;
    if(!slot.rest||!sameRest(slot.rest)){
      slot.rest=undefined;
      if(slot.observed&&sameRest(slot.observed)){
        const col=world.sampleColumn(s.px,s.pz);
        // Orbital gantries are static contact. Charging/flight already fail
        // remote(), and moving approaches keep the pod guard in physicsDt.
        if(!col.templeSite&&!world.liquidAt(s.px,s.py+.25,s.pz)&&
          !world.collectCityLifts().some(l=>Math.abs(l.x-s.px)<l.hx+2&&Math.abs(l.z-s.pz)<l.hz+2))
          slot.rest={...slot.observed,x:s.px,y:s.py,z:s.pz,expires:movementTick+12};
      }
    }
    if(slot.rest){
      s.vx=0;s.vy=0;s.vz=0;s.simulationTick=movementTick;s.jumpHeld=false;s.jumpAscent=false;
      s.airSeconds=Math.min(18,(s.airSeconds??18)+dt*5);s.boosting=false;
      this.stats.restTicks++;return true;
    }
    slot.observed=undefined;
    if(this.tick<slot.retry){this.reject('retry');return full();}
    const forward=Number(!!(cmd.buttons&BTN.FORWARD))-Number(!!(cmd.buttons&BTN.BACK));
    const right=Number(!!(cmd.buttons&BTN.RIGHT))-Number(!!(cmd.buttons&BTN.LEFT));
    const sy=Math.sin(cmd.yaw),cy=Math.cos(cmd.yaw);
    let wx=-sy*forward+cy*right,wz=-cy*forward-sy*right;
    const wish=Math.hypot(wx,wz);if(wish){wx/=wish;wz/=wish;}
    let vx=s.vx,vz=s.vz;
    if(wish){let dx=wx*PLAYER.RUN_SPEED-vx,dz=wz*PLAYER.RUN_SPEED-vz;const distance=Math.hypot(dx,dz),limit=PLAYER.ACCEL*dt;
      if(distance>limit){dx=dx/distance*limit;dz=dz/distance*limit;}vx+=dx;vz+=dz;
    }else{const friction=Math.max(0,1-PLAYER.FRICTION*dt);vx*=friction;vz*=friction;}
    if(Math.hypot(vx,vz)>PLAYER.RUN_SPEED+.1)return full();
    const nx=s.px+vx*dt,nz=s.pz+vz*dt;
    const usable=(path:GroundPath)=>{
      const along=(nx-path.x)*path.dx+(nz-path.z)*path.dz;
      return movementTick<=path.expires&&along>=-.02&&along<=path.length&&
        (!path.capital||nativeCapitalProviders(world))&&
        (!path.authored||path.collectRegion===world.collectRegion&&path.sampleColumn===world.sampleColumn&&path.column===world.column)&&
        (!path.plane||path.collectCities===world.collectCities&&path.collectCaveSites===world.collectCaveSites&&
          path.collectTransportPlan===world.collectTransportPlan&&path.collectJungleTemples===world.collectJungleTemples)&&
        (Math.abs((nx-path.x)*path.dz-(nz-path.z)*path.dx)<.035||
          authoredRectangleContains(path,s.px,s.py,s.pz)&&authoredRectangleContains(path,nx,s.py,nz)&&nativeTerrainProviders.call(world));
    };
    if(!slot.path||!usable(slot.path)){
      const speed=Math.hypot(vx,vz),dx=speed>.05?vx/speed:wx||1,dz=speed>.05?vz/speed:wz;
      const path=this.path(world,s.px,s.py,s.pz,dx,dz,movementTick);
      if(!path){slot.retry=this.tick+6;this.stats.rejectedPaths++;return full();}
      slot.path=path;
    }
    const path=slot.path;if(!usable(path))return full();
    const along=Math.max(0,Math.min(path.length,(nx-path.x)*path.dx+(nz-path.z)*path.dz));
    const at=along/path.length*(path.heights.length-1),i=Math.min(path.heights.length-2,Math.floor(at));
    const height=path.heights[i]+(path.heights[i+1]-path.heights[i])*(at-i)+SKIN;
    if(Math.abs(height-s.py)>.22)return full();
    if(path.authored||!remote){
      // Generated support is immutable; camps and lift interactions must
      // still be observed on each authoritative movement tick.
      if(world.outposts.distance(nx,height+PLAYER.HEIGHT/2,nz,PLAYER.HEIGHT)<PLAYER.HEIGHT||
        world.collectCityLifts().some(l=>Math.abs(l.x-nx)<l.hx+PLAYER.RADIUS+.2&&Math.abs(l.z-nz)<l.hz+PLAYER.RADIUS+.2))return full();
    }
    if(path.authored){
      this.stats.authoredTicks++;
      if(path.plane)this.stats.planeTicks++;
    }
    s.px=nx;s.py=height;s.pz=nz;s.vx=vx;s.vz=vz;s.vy=0;s.grounded=true;
    s.jumpHeld=false;s.jumpAscent=false;s.dodgeCd=Math.max(0,s.dodgeCd-dt);s.simulationTick=movementTick;
    s.airSeconds=Math.min(18,(s.airSeconds??18)+dt*5);s.swimming=false;s.submerged=false;s.boosting=false;
    this.stats.groundTicks++;return true;
  }
  /** In a clear water interior the shared swimming controller has no solid
   * contact to resolve. Retain its ordinary per-tick current/buoyancy and air
   * integration, with a bounded empty prism covering the entire capsule.
   * Near the bed, banks, structures or changing transport we use shared
   * swept collision instead; no cached support is assumed underwater. */
  private swim(world:World,p:ServerPlayer,cmd:InputCmd,dt:number,tick:number,slot:Slot):boolean {
    const s=p.state,fluid=world.liquidAt(s.px,s.py+.72,s.pz);
    if(!fluid||fluid.kind!=='water'||fluid.surfaceY-fluid.bottomY<=.8||fluid.distance>-4)return false;
    if(world.collectCityLifts().some(l=>Math.abs(l.x-s.px)<l.hx+4&&Math.abs(l.z-s.pz)<l.hz+4)||
      world.collectTransportPlan().pods.some(pod=>(pod.x-s.px)**2+(pod.z-s.pz)**2<20**2)||
      world.vehicleCollisions?.select(s,dt,tick)?.distance(s.px,s.py+PLAYER.HEIGHT/2,s.pz,4)!<4)return false;
    const forward=Number(!!(cmd.buttons&BTN.FORWARD))-Number(!!(cmd.buttons&BTN.BACK));
    const right=Number(!!(cmd.buttons&BTN.RIGHT))-Number(!!(cmd.buttons&BTN.LEFT));
    const sy=Math.sin(cmd.yaw),cy=Math.cos(cmd.yaw),cp=Math.cos(cmd.pitch);
    let wx=-sy*forward*cp+cy*right,wz=-cy*forward*cp-sy*right;
    const length=Math.max(1,Math.hypot(wx,wz));wx/=length;wz/=length;
    const ascent=cmd.buttons&BTN.JUMP?1:cmd.buttons&BTN.BRAKE?-1:Math.sin(cmd.pitch)*forward;
    const targetY=ascent?ascent*SWIMMING.SPEED:clamp((fluid.surfaceY-1.05-s.py)*2,-2,2);
    const blend=Math.min(1,dt*SWIMMING.ACCEL);
    const vx=s.vx+(wx*SWIMMING.SPEED+fluid.flowX-s.vx)*blend;
    const vz=s.vz+(wz*SWIMMING.SPEED+fluid.flowZ-s.vz)*blend;
    const vy=s.vy+(targetY-s.vy)*blend;
    const nx=s.px+vx*dt,ny=s.py+vy*dt,nz=s.pz+vz*dt;
    const fits=(space:WaterSpace)=>tick<=space.expires&&
      Math.min(s.px,nx)-PLAYER.RADIUS>=space.x0&&Math.max(s.px,nx)+PLAYER.RADIUS<=space.x1&&
      Math.min(s.pz,nz)-PLAYER.RADIUS>=space.z0&&Math.max(s.pz,nz)+PLAYER.RADIUS<=space.z1&&
      Math.min(s.py,ny)>=space.y0&&Math.max(s.py,ny)+PLAYER.HEIGHT<=space.y1;
    if(!slot.water||!fits(slot.water)){
      if(tick<(slot.waterRetry??0))return false;
      // A surface swimmer barely changes height. Avoid proving an unused
      // deep volume below it; every proposed capsule must still fit the
      // prism before reuse, so a dive/ascent rebuilds clearance as needed.
      const vertical=Math.max(.15,Math.min(1.5,Math.max(Math.abs(s.vy),Math.abs(vy))*HORIZON/TICK_RATE));
      const space=this.waterSpace(world,s.px,s.py,s.pz,tick,vertical);
      if(!space){slot.waterRetry=tick+6;this.stats.rejectedWater++;return false;}
      slot.water=space;
    }
    if(!fits(slot.water))return false;
    // Camps can change independently of the immutable generated primitives.
    const mx=(s.px+nx)/2,my=(s.py+ny+PLAYER.HEIGHT)/2,mz=(s.pz+nz)/2;
    const reach=PLAYER.HEIGHT+Math.hypot(nx-s.px,ny-s.py,nz-s.pz);
    if(world.outposts.distance(mx,my,mz,reach)<reach)return false;
    const nextFluid=world.liquidAt(nx,ny+.72,nz);
    if(!nextFluid||nextFluid.kind!=='water'||nextFluid.id!==fluid.id)return false;
    const head=world.liquidAt(s.px,s.py+PLAYER.EYE_HEIGHT,s.pz);
    s.submerged=!!head;s.airSeconds=clamp((s.airSeconds??SWIMMING.AIR_SECONDS)+dt*(head?-1:5),0,SWIMMING.AIR_SECONDS);
    s.px=nx;s.py=ny;s.pz=nz;s.vx=vx;s.vy=vy;s.vz=vz;
    s.grounded=false;s.swimming=true;s.boosting=false;s.jumpAscent=false;
    s.jumpHeld=!!(cmd.buttons&BTN.JUMP);s.dodgeCd=Math.max(0,s.dodgeCd-dt);s.simulationTick=tick;
    this.stats.waterTicks++;return true;
  }
  private waterSpace(world:World,x:number,y:number,z:number,tick:number,vertical:number):WaterSpace|null {
    this.stats.waterChecks++;
    const space={x0:x-2.5,x1:x+2.5,z0:z-2.5,z1:z+2.5,y0:y-vertical,y1:y+PLAYER.HEIGHT+vertical,expires:tick+24};
    if(Math.max(Math.abs(space.x0),Math.abs(space.x1),Math.abs(space.z0),Math.abs(space.z1))>=WORLD.BORDER-1)return null;
    // Every terrain sample is over three metres below the prism. The grid
    // spacing is less than one metre, with the same conservative slope
    // envelope used by world traces. Authored caves, grading and structures
    // are rejected separately, including thin walls between grid samples.
    for(let iz=0;iz<=6;iz++)for(let ix=0;ix<=6;ix++){
      const px=space.x0+(space.x1-space.x0)*ix/6,pz=space.z0+(space.z1-space.z0)*iz/6;
      const col=world.sampleColumn(px,pz);
      if(col.h>space.y0-3||col.cave||col.templeSite||col.city||col.transport)return null;
    }
    const region=this.staticRegion(world,space.x0,space.x1,space.z0,space.z1);
    const blocked=(boxes:readonly Box[])=>boxes.some(box=>overlaps(box,space.x0-.6,space.x1+.6,space.z0-.6,space.z1+.6,space.y0-.6,space.y1+.6));
    if(region.capitalArea||blocked(region.boulders)||blocked(region.pads)||blocked(region.solids)||blocked(region.cuts)||blocked(region.foundations??[])||
      region.vegetation.some(p=>overlaps({x:p.x,y:p.y+p.height/2,z:p.z,hx:p.radius,hy:p.height/2,hz:p.radius},space.x0,space.x1,space.z0,space.z1,space.y0,space.y1)))return null;
    const cy=(space.y0+space.y1)/2,reach=Math.hypot(2.5,2.5,(space.y1-space.y0)/2)+.6;
    if((region.transportBridges?.distance(x,cy,z,reach)??reach)<reach||world.outposts.distance(x,cy,z,reach)<reach||
      capsuleClearance(world,x,y,z)<1)return null;
    // Mutable injected collectors used by editors/tests cannot lend their
    // clearance proof to a later tick.
    if(world.collectRegion!==World.prototype.collectRegion||world.sampleColumn!==World.prototype.sampleColumn)space.expires=tick;
    return space;
  }
  private path(world:World,x:number,y:number,z:number,dx:number,dz:number,tick:number):GroundPath|null {
    this.stats.pathChecks++;
    const length=PLAYER.RUN_SPEED*HORIZON/TICK_RATE+.08,steps=Math.ceil(length/PATH_STEP),heights:number[]=[];
    const first=world.sampleColumn(x,z);
    // Flat authored decks can be far above their terrain column (Vesper),
    // while ordinary city slabs intentionally overlap the floor probe band.
    // Certify their exact support before considering natural ground.
    if(first.city||Math.abs(y-first.h)>.45){
      const supported=this.authoredPath(world,x,y,z,dx,dz,length,tick);
      if(supported)return supported;
    }
    let min=Infinity,max=-Infinity;
    for(let i=0;i<=steps;i++){
      const along=length*i/steps,px=x+dx*along,pz=z+dz*along,col=world.sampleColumn(px,pz);
      if(col.cave||col.templeSite||col.city?.theme||world.liquidAt(px,col.h+.1,pz)){this.reject('complex ground');return null;}
      if(i&&Math.abs(col.h-heights[i-1])>.14||!i&&Math.abs(y-col.h)>.45){this.reject('ground grade');return null;}
      heights.push(col.h);min=Math.min(min,col.h);max=Math.max(max,col.h);
    }
    // The complete swept capsule bounds prevent endpoint-only tests from
    // tunneling through thin walls, rock ridges or tree trunks.
    const ex=x+dx*length,ez=z+dz*length,pad=PLAYER.RADIUS+.12;
    const x0=Math.min(x,ex)-pad,x1=Math.max(x,ex)+pad,z0=Math.min(z,ez)-pad,z1=Math.max(z,ez)+pad;
    const y0=min-.7,y1=max+PLAYER.HEIGHT+.2,region=this.staticRegion(world,x0,x1,z0,z1);
    const blocked=(boxes:readonly Box[])=>boxes.some(box=>overlaps(box,x0,x1,z0,z1,y0,y1));
    if(region.capitalArea&&(!nativeCapitalProviders(world)||this.capitalBlocked(region,x0,x1,z0,z1,y0,y1))||blocked(region.boulders)||blocked(region.pads)||blocked(region.solids)||blocked(region.cuts)||
      blocked(region.foundations??[])||region.vegetation.some(p=>overlaps({x:p.x,y:p.y+p.height/2,z:p.z,hx:p.radius,hy:p.height/2,hz:p.radius},x0,x1,z0,z1,y0,y1))){this.reject('static geometry');return null;}
    const mx=(x+ex)/2,mz=(z+ez)/2,my=(min+max+PLAYER.HEIGHT)/2,reach=length+PLAYER.HEIGHT;
    if((region.transportBridges?.distance(mx,my,mz,reach)??reach)<reach||
      world.outposts.distance(mx,my,mz,reach)<reach||transitDistance(world,tick/TICK_RATE,mx,my,mz,24)<24){this.reject('transport/camp');return null;}
    for(const pod of world.collectTransportPlan().pods)if((pod.x-mx)**2+(pod.z-mz)**2<20**2)return null;
    if(capsulePenetrates(world,x,heights[0]+SKIN,z,.005)||capsulePenetrates(world,ex,heights.at(-1)!+SKIN,ez,.005)){this.reject('clearance');return null;}
    return{x,z,dx,dz,length,heights,expires:tick+HORIZON,...(region.capitalArea?{capital:true}:{})};
  }
  /** A broad capital district can contain ordinary open terrain. Every solid
   * point of a tapered shell lies inside its endpoint bounds expanded by the
   * larger radius; the field's distant-geometry cap changes only positive air.
   * Keep the complete swept capsule rectangle and original vertical envelope. */
  private capitalBlocked(region:Region,x0:number,x1:number,z0:number,z1:number,y0:number,y1:number):boolean {
    if(!Array.isArray(region.capitalSegments))return true;
    for(let i=0;i<region.capitalSegments.length;i++){
      const segment=region.capitalSegments[i];
      if(!segment?.a||!segment.b)return true;
      const {a,b}=segment;
      if(![a.x,a.y,a.z,a.radius,b.x,b.y,b.z,b.radius].every(Number.isFinite)||a.radius<0||b.radius<0)return true;
      const r=Math.max(a.radius,b.radius);
      if(Math.max(a.x,b.x)+r>=x0&&Math.min(a.x,b.x)-r<=x1&&
        Math.max(a.y,b.y)+r>=y0&&Math.min(a.y,b.y)-r<=y1&&
        Math.max(a.z,b.z)+r>=z0&&Math.min(a.z,b.z)-r<=z1)return true;
    }
    return false;
  }
  /** Support covers the entire swept capsule footprint: either one canonical
   * box or the exact flat core of a non-abyss city. No endpoints-only deck
   * inference, floorY metadata, or union of separated platforms is allowed. */
  private authoredPath(world:World,x:number,y:number,z:number,dx:number,dz:number,length:number,tick:number):GroundPath|null {
    this.stats.authoredChecks++;
    const reject=(reason:string):null=>{this.reject(`authored ${reason}`);return null;};
    const ex=x+dx*length,ez=z+dz*length,pad=PLAYER.RADIUS+.12;
    const x0=Math.min(x,ex)-pad,x1=Math.max(x,ex)+pad,z0=Math.min(z,ez)-pad,z1=Math.max(z,ez)+pad;
    if(Math.max(Math.abs(x0),Math.abs(x1),Math.abs(z0),Math.abs(z1))>=WORLD.BORDER-1)return reject('border');
    const region=this.staticRegion(world,x0,x1,z0,z1);
    const covers=(b:Box)=>b.x-b.hx<=x0&&b.x+b.hx>=x1&&b.z-b.hz<=z0&&b.z+b.hz>=z1;
    let support:Box|undefined,best=Infinity;
    for(const box of region.solids){
      const delta=Math.abs(y-(box.y+box.hy+SKIN));
      if(delta<=.3&&delta<best&&covers(box)){support=box;best=delta;}
    }
    const city=!support?world.collectCities().find(c=>{
      if(c.theme==='vesper'||Math.abs(y-(c.y+SKIN))>.3)return false;
      const ax=Math.max(Math.abs(x0-c.x),Math.abs(x1-c.x)),az=Math.max(Math.abs(z0-c.z),Math.abs(z1-c.z));
      // .85r is below every possible organic boundary radius (.94-.055-.035).
      // The farthest rectangle corner bounds the whole convex footprint.
      return c.theme?Math.hypot(ax,az)<c.radius*.85-.001:Math.max(ax,az)<c.radius-.001;
    }):undefined;
    if(!support&&!city)return reject('support');
    const floor=support?support.y+support.hy:city!.y,y1=Math.max(y,floor+SKIN)+PLAYER.HEIGHT+.2;
    if(city){
      // Explicit whole-footprint exclusions complement the sampled height
      // checks below. Station/access grading and cave cuts cannot hide in
      // a narrow unsampled strip through the exact city plane.
      const plan=world.collectTransportPlan();
      if(world.collectCaveSites(x0,x1,z0,z1).length||
        world.collectJungleTemples().some(t=>t.x+t.radius+120>=x0&&t.x-t.radius-120<=x1&&t.z+t.radius+120>=z0&&t.z-t.radius-120<=z1)||
        (plan.stations??[]).some(s=>s.x+194>=x0&&s.x-34<=x1&&s.z+194>=z0&&s.z-34<=z1)||
        (plan.accesses??[]).some(a=>a.x+270>=x0&&a.x-270<=x1&&a.endZ+256>=z0&&a.startZ-256<=z1))return reject('plane grading');
      // Foundation clamps are subtractive above their exact top. A lower
      // plinth can remove part of this terrain plane even though its solid
      // is below our capsule and both corridor endpoints remain empty.
      if(region.foundations?.some(f=>f.y+f.hy<floor&&(!f.underground||floor<=f.y+f.hy+.6)&&
        f.x+f.hx>=x0&&f.x-f.hx<=x1&&f.z+f.hz>=z0&&f.z-f.hz<=z1))return reject('plane foundation');
    }
    const blocked=(boxes:readonly Box[],margin=0)=>boxes.some(b=>overlaps(b,x0-margin,x1+margin,z0-margin,z1+margin,floor-margin,y1+margin));
    // Ordinary city plinths flatten all preceding terrain/pad unions across
    // this exact footprint. Without that canonical clamp, retain the full
    // 0.6m smooth-union apron around every pad.
    const flatten=region.foundations?.some(f=>!f.underground&&f.y+f.hy===floor&&covers(f));
    if(blocked(region.boulders)||!flatten&&blocked(region.pads,.6)||blocked(region.cuts)||
      region.solids.some(b=>b.y+b.hy>floor+1e-6&&overlaps(b,x0,x1,z0,z1,floor,y1))||
      region.vegetation.some(p=>overlaps({x:p.x,y:p.y+p.height/2,z:p.z,hx:p.radius,hy:p.height/2,hz:p.radius},x0,x1,z0,z1,floor,y1)))return reject('static geometry');
    // Every tapered capital shell lies within its endpoint bounds expanded
    // by the larger radius, including thin ribs between terrain samples.
    if(region.capitalSegments?.some(({a,b})=>{
      const r=Math.max(a.radius,b.radius);
      return Math.max(a.x,b.x)+r>=x0&&Math.min(a.x,b.x)-r<=x1&&
        Math.max(a.y,b.y)+r>=floor&&Math.min(a.y,b.y)-r<=y1&&
        Math.max(a.z,b.z)+r>=z0&&Math.min(a.z,b.z)-r<=z1;
    }))return reject('capital shell');
    if(world.collectCityLifts().some(l=>l.x+l.hx>=x0&&l.x-l.hx<=x1&&l.z+l.hz>=z0&&l.z-l.hz<=z1))return reject('lift');
    // A city plane is exact; elsewhere the terrain must remain comfortably
    // below the deck across a sub-metre grid covering its entire footprint.
    const sx=Math.ceil((x1-x0)/.75),sz=Math.ceil((z1-z0)/.75);
    for(let iz=0;iz<=sz;iz++)for(let ix=0;ix<=sx;ix++){
      const px=x0+(x1-x0)*ix/sx,pz=z0+(z1-z0)*iz/sz,col=world.sampleColumn(px,pz);
      if(col.cave||col.templeSite||col.transport||world.liquidAt(px,floor+.1,pz))return reject('terrain feature');
      if(city&&(col.city?.id!==city.id||col.h!==city.y))return reject('plane height');
      if(col.h>floor-3&&!(col.city&&col.city.theme!=='vesper'&&col.h===col.city.y&&col.h<=floor))return reject('terrain clearance');
    }
    const mx=(x+ex)/2,mz=(z+ez)/2,my=floor+PLAYER.HEIGHT/2,reach=length+PLAYER.HEIGHT;
    if((region.transportBridges?.distance(mx,my,mz,reach)??reach)<reach||world.outposts.distance(mx,my,mz,reach)<reach||
      transitDistance(world,tick/TICK_RATE,mx,my,mz,24)<24||
      world.collectTransportPlan().pods.some(p=>(p.x-mx)**2+(p.z-mz)**2<20**2))return reject('transport/camp');
    if(capsulePenetrates(world,x,floor+SKIN,z,.005)||capsulePenetrates(world,ex,floor+SKIN,ez,.005))return reject('clearance');
    const immutable=world.collectRegion===World.prototype.collectRegion&&world.sampleColumn===World.prototype.sampleColumn&&world.column===World.prototype.column&&
      (!city||world.collectCities===World.prototype.collectCities&&world.collectCaveSites===World.prototype.collectCaveSites&&
        world.collectTransportPlan===World.prototype.collectTransportPlan&&world.collectJungleTemples===World.prototype.collectJungleTemples);
    // This proof covers the entire padded rectangle, unlike natural paths'
    // centerline samples. Both full endpoint footprints must remain inside
    // it on reuse; convexity then covers their straight swept footprint.
    return{x,z,dx,dz,length,heights:[floor,floor],expires:immutable?tick+HORIZON:tick,authored:true,
      ...(immutable&&nativeTerrainProviders.call(world)?{rectangle:{x0,x1,z0,z1,y0:floor,y1}}:{}),
      collectRegion:world.collectRegion,sampleColumn:world.sampleColumn,column:world.column,plane:!!city,
      collectCities:world.collectCities,collectCaveSites:world.collectCaveSites,
      collectTransportPlan:world.collectTransportPlan,collectJungleTemples:world.collectJungleTemples};
  }
  /** Generated structures and vegetation are immutable. Expand collection
   * outward to a reusable cell rectangle, then test the original exact swept
   * bounds against that conservative primitive superset. Dynamic camps and
   * transport retain the live checks above; injected collectors stay live. */
  private staticRegion(world:World,x0:number,x1:number,z0:number,z1:number):Region {
    if(world.collectRegion!==World.prototype.collectRegion)return world.collectRegion(x0,x1,z0,z1);
    const ax=Math.floor(x0/32),bx=Math.ceil(x1/32),az=Math.floor(z0/32),bz=Math.ceil(z1/32);
    const key=`${ax},${bx},${az},${bz}`;
    let regions=this.regions.get(world);if(!regions){regions=new Map();this.regions.set(world,regions);}
    const cached=regions.get(key);if(cached){this.stats.regionHits++;return cached;}
    const region=world.collectRegion(ax*32,bx*32,az*32,bz*32);
    if(regions.size>=256)regions.delete(regions.keys().next().value!);
    regions.set(key,region);this.stats.regionBuilds++;return region;
  }
}
