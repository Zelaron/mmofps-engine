import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BTN, CREATURE, CREATURE_DEFS, LOCK_LOCKED, PICKUP_WEAPON, VEHICLE, vehicleDefinition, rocketHullDamageFactor,
  BOT_AA_LAUNCH_INTERVAL, type ColumnData } from '@shared/index';
import type { RoadSegment } from '@shared/landscape';
import { Bot, botCampaignRole, botRoleId, campaignSpot } from '../src/bots.js';
import { campaignRoadRoute } from '../src/bot-navigation.js';
import { Game, ServerPlayer, type ServerPickup, type ServerVehicle } from '../src/game.js';
import type { Frontier } from '../src/frontier.js';
import type { Creature } from '../src/wildlife.js';

/** Real command/collection/possession pipeline over an unobstructed practice field. */
function fixture(id = 4, x = 0, z = 0) {
  const game = new Game(1337);
  const col = { h: 0, temp: .5, moist: .5, desert: 0, entr: 0, entrRaw: 0, volc: 0, lavaY: -1000 } as ColumnData;
  game.world.column = () => col;
  game.world.sdf = (_x, y) => y;
  game.world.sdfCol = (_x, y) => y;
  game.world.terrainHeight = () => 0;
  game.world.liquidAt = () => undefined;
  game.world.collectCityLifts = () => [];
  game.world.collectTransportPlan = () => ({ routes: [], stations: [], harbors: [], pods: [], lifts: [], solids: [], bridges: [], accesses: [] });
  game.world.gradient = (_x, _y, _z, out) => Object.assign(out, { x: 0, y: 1, z: 0 });
  game.world.trace = (ox, oy, oz, dx, dy, dz, maxDist) => {
    const dist = dy < 0 ? Math.min(maxDist, Math.max(0, oy / -dy)) : maxDist;
    return { hit: dy < 0 && oy / -dy <= maxDist, dist, x: ox + dx * dist, y: oy + dy * dist,
      z: oz + dz * dist, nx: 0, ny: 1, nz: 0 };
  };
  const player = new ServerPlayer(id, 'Explorer', null, true, { x, y: .006, z });
  player.state.grounded = true;
  game.players.set(id, player);
  const bot = new Bot(player, 1337);
  const advance = (ticks: number) => {
    for (let i = 0; i < ticks; i++) { game.queueInput(player, bot.think(game)); game.step(); }
  };
  return { game, player, bot, advance };
}

function crate(id: number, weapon: number, x: number, z: number): ServerPickup {
  return { id, weapon, kind: PICKUP_WEAPON, x, y: .6, z, availableAtTick: 0, expiresAtTick: 10000 };
}
function hull(id: number, type: ServerVehicle['type'], z: number): ServerVehicle {
  return { id, type, x: 0, y: .006, z, heading: 0,
    health: vehicleDefinition(type)!.maxHealth, occupant: -1, respawnAtTick: -1 };
}

function campaign(game:Game,point={x:0,y:0,z:-100},phase:'assemble'|'attack'='attack') {
  const objective={id:'control',name:'Approach',radius:30,owner:0,x:point.x,y:point.y,z:point.z};
  game.world.collectRoadSegments=()=>[];
  Object.defineProperty(game,'frontier',{value:{territories:[objective],objective:()=>objective,
    order:()=>({targetId:objective.id,phase,staging:{x:0,y:0,z:0}}),recordCombat(){},step(){},send(){}} as unknown as Frontier});
  return objective;
}

test('all three factions receive pilots, sailors, crew and ground squads',()=>{
  for(let faction=1;faction<=3;faction++) {
    const roles=Array.from({length:16},(_,i)=>botCampaignRole(faction+i*3));
    assert.equal(roles.filter(role=>role==='pilot').length,1);
    assert.equal(roles.filter(role=>role==='sailor').length,1);
    assert.equal(roles.filter(role=>role==='aircrew').length,1);
    assert.equal(roles.filter(role=>role==='navalcrew').length,1);
    assert.ok(roles.filter(role=>role==='driver').length>=3);
    assert.ok(roles.filter(role=>role==='infantry').length>=3);
    assert.deepEqual(roles,Array.from({length:16},(_,i)=>botCampaignRole(1+i*3)));
  }
});

test('foot soldiers, drivers and pilots resolve one campaign order per think and refresh on the next call',()=>{
  for(const vehicle of [VEHICLE.NONE,VEHICLE.JEEP,VEHICLE.JET] as const) {
    const {game,player,bot}=fixture(19);player.faction=1;
    const objective=campaign(game,{x:0,y:0,z:-650});
    let orderCalls=0,phase:'assemble'|'attack'='assemble';
    game.frontier!.order=()=>{orderCalls++;return {baseId:'base',targetId:objective.id,name:'Test order',x:objective.x,z:objective.z,
      phase,squad:0,staging:{x:140,y:0,z:0}};};
    if(vehicle!==VEHICLE.NONE) {
      const owned=hull(999,vehicle,0);owned.occupant=player.id;game.vehicles.set(owned.id,owned);player.vehicleId=owned.id;
      Object.assign(player.state,{vehicle,vehicleId:owned.id,grounded:vehicle!==VEHICLE.JET,py:vehicle===VEHICLE.JET?100:.006});
    }
    const first=bot.think(game);
    assert.equal(orderCalls,1,`vehicle ${vehicle}: repeated objective/course requests reuse one strategy resolution`);
    if(vehicle===VEHICLE.NONE)assert.equal(bot.intent.x,campaignSpot(player,{x:140,z:0},objective.radius).x,'assembly movement follows the staging point');
    phase='attack';
    const second=bot.think(game);
    assert.equal(orderCalls,2,'a second invocation at the same tick still sees changed strategic state');
    assert.equal(second.seq,first.seq+1,'normal command generation continues for every invocation');
    if(vehicle===VEHICLE.NONE)assert.equal(bot.intent.x,campaignSpot(player,objective,objective.radius).x,'the changed order immediately moves the soldier toward its capture objective');
  }
});

test('a recovering driver keeps live support sensing and resumes solid probes after the maneuver',()=>{
  const {game,player,bot,advance}=fixture(13);player.faction=1;
  campaign(game,{x:0,y:0,z:-650});game.world.collectCities=()=>[];
  const tank=hull(988,VEHICLE.TANK,0);tank.occupant=player.id;game.vehicles.set(tank.id,tank);player.vehicleId=tank.id;
  Object.assign(player.state,{vehicle:VEHICLE.TANK,vehicleId:tank.id});
  let blocked=true,forwardTraces=0,supportSamples=0;
  game.world.sdf=(_x,y)=>{supportSamples++;return y;};
  game.world.trace=(x,y,z,dx,dy,dz,distance)=>{
    forwardTraces++;
    return {hit:blocked,dist:blocked?2:distance,x:x+dx*2,y:y+dy*2,z:z+dz*2,nx:0,ny:blocked?0:1,nz:1};
  };
  const avoidance=bot.think(game);
  assert.equal(forwardTraces,1,'the first hull probe confirms the wall');
  assert.ok(supportSamples>0,'a wall does not establish safe ground for the recovery turn');
  assert.ok(avoidance.buttons&BTN.BACK,'the ordinary avoidance response remains active');
  blocked=false;forwardTraces=0;supportSamples=0;game.tick=18;
  bot.think(game);
  assert.equal(forwardTraces,0,'solid probes cannot change an active recovery maneuver');
  assert.ok(supportSamples>0,'shore and edge sensing remains live throughout recovery');
  // Advance the real movement pipeline so the stationary-fixture watchdog
  // cannot start an unrelated recovery when the original maneuver expires.
  advance(72);
  assert.ok(Math.hypot(player.state.px,player.state.pz)>.8,'the hull made actual recovery progress');
  forwardTraces=0;supportSamples=0;
  const resumed=bot.think(game);
  assert.equal(forwardTraces,8,'after expiry, an unobstructed course checks every roof and shoulder probe');
  assert.ok(supportSamples>0,'the clear course still requires supported ground');
  assert.ok(resumed.buttons&BTN.FORWARD,'a supported clear route resumes forward travel');
});

test('squad road routes follow connected dry detours and share bounded cached planning',()=>{
  const points=[{x:0,y:0,z:0},{x:0,y:0,z:150},{x:150,y:0,z:150},{x:300,y:0,z:150},{x:300,y:0,z:0}];
  let scans=0;
  const world={collectRoadSegments:()=>{scans++;return points.slice(1).map((b,i)=>({a:points[i],b,width:8,trail:false,id:`road${i}`} satisfies RoadSegment));}};
  const route=campaignRoadRoute(world,{x:0,z:0},{x:300,z:0});
  assert.deepEqual(route,points,'the direct route crosses an unconnected hazard, so follow the detour');
  assert.strictEqual(campaignRoadRoute(world,{x:10,z:10},{x:301,z:1}),route);
  assert.equal(scans,1,'nearby squad members reuse the same strategic graph search');
  assert.deepEqual(campaignRoadRoute(world,{x:0,z:0},{x:9000,z:0}),[]);
  assert.equal(scans,1,'intercontinental orders must not scan the entire world');
});

test('a driver waits while an allied infantry bot approaches, boards and operates the gunner seat',()=>{
  const {game,player,bot}=fixture(13);player.faction=1;
  campaign(game,{x:0,y:0,z:-650});
  const jeep=hull(990,VEHICLE.JEEP,-4);jeep.campaignFaction=1;game.vehicles.set(jeep.id,jeep);
  const passenger=new ServerPlayer(19,'Gunner',null,true,{x:0,y:.006,z:23});passenger.faction=1;passenger.state.grounded=true;
  game.players.set(passenger.id,passenger);const gunner=new Bot(passenger,1337);
  for(let tick=0;tick<450;tick++) {
    game.queueInput(player,bot.think(game));game.queueInput(passenger,gunner.think(game));game.step();
    if(passenger.vehicleId===jeep.id)break;
  }
  assert.equal(jeep.occupant,player.id);
  assert.equal(jeep.gunner,passenger.id,'the driver must remain in reach long enough to board');
  assert.equal(passenger.state.seat,1);
  const enemy=new ServerPlayer(90,'Hostile',null,false,{x:0,y:.006,z:-180});enemy.faction=2;enemy.health=10000;game.players.set(enemy.id,enemy);
  for(let tick=0;tick<120;tick++) {
    const cmd=gunner.think(game);
    assert.equal(cmd.buttons&(BTN.FORWARD|BTN.BACK|BTN.LEFT|BTN.RIGHT|BTN.THROTTLE),0,'only the driver controls movement');
    game.queueInput(player,bot.think(game));game.queueInput(passenger,cmd);game.step();
  }
  assert.ok(enemy.health<10000,'crewed vehicles actively fire their mounted weapons');
});

test('a convoy follows its capture order, deploys infantry and does not instantly reboard',()=>{
  const {game,player,bot,advance}=fixture(13);player.faction=1;
  campaign(game,{x:0,y:0,z:-110});
  const jeep=hull(991,VEHICLE.JEEP,-4);jeep.campaignFaction=1;game.vehicles.set(jeep.id,jeep);
  advance(2);assert.equal(player.vehicleId,jeep.id);
  for(let i=0;i<1500&&player.vehicleId>=0;i++)advance(1);
  assert.equal(player.vehicleId,-1,'transport driver must leave the hull to capture');
  assert.ok(Math.hypot(player.state.px,player.state.pz+110)<40);
  advance(120);
  assert.equal(player.state.vehicle,VEHICLE.NONE,'deployment has a useful on-foot interval');
  assert.equal(bot.intent.vehicleId,-1);
});

test('city assault transports deploy outside the blocks and infantry finishes the approach on foot',()=>{
  const {game,player,advance}=fixture(13);player.faction=1;
  const objective=campaign(game,{x:0,y:0,z:-650});Object.assign(objective,{kind:'city'});
  const jeep=hull(989,VEHICLE.JEEP,-4);jeep.campaignFaction=1;game.vehicles.set(jeep.id,jeep);
  advance(2);assert.equal(player.vehicleId,jeep.id);
  let deploymentDistance=0;
  for(let i=0;i<4500;i++) {
    const aboard=player.vehicleId===jeep.id;advance(1);
    if(aboard&&player.vehicleId<0)deploymentDistance=Math.hypot(player.state.px,player.state.pz+650);
  }
  assert.ok(deploymentDistance>180 && deploymentDistance<260,'the convoy drops infantry before the dense urban approach');
  assert.equal(player.state.vehicle,VEHICLE.NONE);
  assert.ok(Math.hypot(player.state.px,player.state.pz+650)<objective.radius,'the soldier reaches the actual capture zone');
});

test('fighter pilots let their aircrew board before opening the throttle',()=>{
  const {game,player,bot}=fixture(1);player.faction=1;campaign(game,{x:0,y:0,z:-700});
  const jet=hull(998,VEHICLE.JET,-4);jet.campaignFaction=1;game.vehicles.set(jet.id,jet);
  const passenger=new ServerPlayer(4,'Aircrew',null,true,{x:0,y:.006,z:0});passenger.faction=1;passenger.state.grounded=true;
  game.players.set(passenger.id,passenger);const gunner=new Bot(passenger,1337);
  for(let tick=0;tick<180;tick++) {
    game.queueInput(player,bot.think(game));game.queueInput(passenger,gunner.think(game));game.step();
    if(passenger.vehicleId===jet.id)break;
  }
  assert.equal(jet.occupant,player.id);
  assert.equal(jet.gunner,passenger.id,'crew must not be stranded beside an empty runway');
  for(let tick=0;tick<300;tick++) {game.queueInput(player,bot.think(game));game.queueInput(passenger,gunner.think(game));game.step();}
  assert.ok(player.state.py>25,'the crewed fighter takes off normally');
});

test('reserved worker IDs keep flight roles stable and destroyed aircraft redeploy at their original runway',()=>{
  let nextId=0x1_0000_0000+17;
  const game=new Game(1337,{vehicles:true,frontier:true,entityAllocator:{allocate:()=>nextId++}});
  const bots=Array.from({length:6},(_,i)=>new Bot(game.addPlayer(`Flight ${i+1}`,null,true),1337));
  const pilot=bots[0].player,gunner=bots[3].player;
  assert.ok(pilot.id>0x1_0000_0000,'this worker allocates world objects before its bot IDs');
  assert.equal(botCampaignRole(botRoleId(pilot)),'pilot');
  assert.equal(botCampaignRole(botRoleId(gunner)),'aircrew');
  assert.deepEqual(bots.map(b=>b.player.faction),[1,2,3,1,2,3]);
  const advance=(ticks:number)=>{for(let i=0;i<ticks;i++){for(const b of bots)game.queueInput(b.player,b.think(game));game.step();}};
  advance(25);
  const jet=game.vehicles.get(pilot.vehicleId)!;
  assert.ok(jet && jet.type===VEHICLE.JET);
  assert.equal(jet.gunner,gunner.id);
  const home=jet.campaignHome!;assert.ok(home);
  game.damageVehicle(jet,10000,null,255);
  assert.equal(pilot.state.alive,false);assert.equal(gunner.state.alive,false);
  advance(1);
  game.tick=pilot.respawnAtTick-1;game.step();
  assert.equal(pilot.state.alive,true);
  assert.ok(Math.hypot(pilot.state.px-home.x,pilot.state.pz-home.z)<12);
  advance(60);
  const position={x:pilot.state.px,z:pilot.state.pz};
  advance(60);
  assert.ok(jet.respawnAtTick>game.tick);
  assert.ok(Math.hypot(pilot.state.px-position.x,pilot.state.pz-position.z)<1,'the pilot waits through the replacement cooldown');
  for(const crew of [pilot,gunner])assert.ok(Math.hypot(crew.state.px-home.x,crew.state.pz-home.z)>vehicleDefinition(VEHICLE.JET)!.radius+1,
    'the crew waits beside the pad, so the replacement can spawn');
  assert.ok(Math.hypot(pilot.state.px-gunner.state.px,pilot.state.pz-gunner.state.pz)>.6,'the waiting crew does not stand inside each other');
  game.tick=jet.respawnAtTick-1;game.step();
  advance(180);
  assert.equal(jet.occupant,pilot.id,'the original pilot boards the repaired aircraft');
  assert.equal(jet.gunner,gunner.id,'the aircrew returns with its pilot');
});

test('stranded infantry walks to a useful airlift pod and completes the real charging and travel sequence',()=>{
  const {game,player,advance}=fixture(19);player.faction=1;campaign(game,{x:0,y:0,z:-1600});
  const empty=game.world.collectTransportPlan();
  game.world.collectTransportPlan=()=>({...empty,pods:[
    {id:701,stationId:1,name:'Departure',x:0,y:.006,z:-20},
    {id:702,stationId:2,name:'Arrival',x:0,y:.006,z:-1480},
  ]});
  let charged=false,flew=false;
  for(let i=0;i<1500;i++) {advance(1);charged ||= !!player.airlift;flew ||= !!player.state.airlift;}
  assert.ok(charged,'the bot approaches the departure pad and requests transport');
  assert.ok(flew,'it holds still through the ordinary three-second launch charge');
  assert.ok(player.state.pz<-1480 && Math.abs(player.state.py)<1,'transport delivers the soldier near its campaign objective');
  assert.equal(player.state.alive,true);
});

test('AA specialists acquire distant aircraft, finish real locks and space their launches',()=>{
  const {game,player,bot}=fixture(13);player.faction=1;
  campaign(game,{x:0,y:0,z:-100});
  const second=new ServerPlayer(22,'Second sentry',null,true,{x:6,y:.006,z:0});second.faction=1;second.state.grounded=true;
  game.players.set(second.id,second);const other=new Bot(second,1337);
  const pilot=new ServerPlayer(90,'Intruder',null,false,{x:0,y:130,z:-550});pilot.faction=2;
  const jet=hull(992,VEHICLE.JET,-550);jet.y=130;jet.occupant=pilot.id;jet.health=50000;game.vehicles.set(jet.id,jet);
  Object.assign(pilot.state,{vehicle:VEHICLE.JET,vehicleId:jet.id,grounded:false});pilot.vehicleId=jet.id;game.players.set(pilot.id,pilot);
  const launches:number[]=[];let reachedLock=false;
  for(let i=0;i<780;i++) {
    // The target fixture holds a known airborne position; the sentries still
    // use authoritative lock, ammunition, fire-cooldown and projectile code.
    Object.assign(pilot.state,{px:0,py:130,pz:-550,vx:0,vy:0,vz:0});
    for(const [p,b] of [[player,bot],[second,other]] as const) {
      const cmd=b.think(game);
      if(cmd.buttons&BTN.FIRE){assert.equal(p.lockState,LOCK_LOCKED);launches.push(game.tick);}
      game.queueInput(p,cmd);
    }
    game.step();reachedLock ||= player.lockState===LOCK_LOCKED || second.lockState===LOCK_LOCKED;
    if(!pilot.state.alive)break;
  }
  assert.ok(reachedLock,'AA must track beyond the infantry acquisition range');
  assert.ok(launches.length>=2,'sentries continue responding when the aircraft remains overhead');
  assert.ok(launches.every((tick,i)=>i===0||tick-launches[i-1]>=BOT_AA_LAUNCH_INTERVAL),'squad launches share an evasion window');
});

test('bots fight nearby hostile creatures, avoid telegraphed blows and ignore distant bosses and passive fauna',()=>{
  const {game,player,bot}=fixture(19);player.faction=1;campaign(game,{x:0,y:0,z:-100});
  const creature=(id:number,species:number,z:number,alert=false):Creature=>({id,species,x:0,y:0,z,yaw:0,speed:0,alert,
    health:CREATURE_DEFS[species].health,homeX:0,homeY:0,homeZ:z,attackAt:0,turnAt:0,deadUntil:0,thinkAt:0,windupUntil:0,targetId:-1,
    aggressorId:-1,aggressorUntil:0,rangedAt:0,detourUntil:0,damageContributors:new Map()});
  const grazer=creature(993,CREATURE.GRAZER,-6);game.wildlife.creatures.set(grazer.id,grazer);
  const boss=creature(994,CREATURE.OSSUARY_TITAN,-150,true);game.wildlife.creatures.set(boss.id,boss);
  assert.equal(bot.think(game).buttons&BTN.FIRE,0,'passive fauna and remote bosses are not faction targets');
  const brute=creature(995,CREATURE.BRUTE,-4,true);brute.windupUntil=90;game.wildlife.creatures.set(brute.id,brute);
  game.tick=30;
  const defense=bot.think(game);
  assert.ok(defense.buttons&BTN.FIRE);
  assert.ok(defense.buttons&BTN.BACK);
  assert.ok(defense.buttons&BTN.DODGE,'a visible warning prompts a retreating dodge');
  assert.equal(defense.buttons&BTN.FORWARD,0,'local self-defense must not become a creature pursuit');
});

test('a real homing missile punishes straight flight but a bot can defeat it with a banked break',()=>{
  const run=(evasive:boolean)=>{
    const {game,player,bot}=fixture(4);player.state.py=120;player.state.pz=-220;
    const jet=hull(996,VEHICLE.JET,-220);jet.y=120;jet.occupant=player.id;game.vehicles.set(jet.id,jet);
    Object.assign(player.state,{vehicle:VEHICLE.JET,vehicleId:jet.id,grounded:false,vx:0,vy:0,vz:-132});player.vehicleId=jet.id;
    const shooter=new ServerPlayer(90,'Missile launch',null,false,{x:0,y:0,z:0});game.players.set(shooter.id,shooter);
    const rocket={id:997,owner:shooter.id,weapon:3,x:0,y:121.55,z:0,vx:0,vy:0,vz:-300,distLeft:1500,
      fuseLeft:Infinity,ageSeconds:0,sleeping:false,homingTarget:player.id,homingVehicleId:jet.id};
    game.projectiles.set(rocket.id,rocket);
    let banked=false,broke=false;
    for(let i=0;i<300 && player.state.alive;i++) {
      const cmd=evasive?bot.think(game):{seq:i+1,buttons:BTN.THROTTLE,weapon:1,yaw:0,pitch:0,renderTick:game.tick,renderFrac:0};
      game.queueInput(player,cmd);game.step();
      banked ||= Math.abs(player.state.vehicleRoll)>.65;
      broke ||= rocket.homingVehicleId===-1;
    }
    return {alive:player.state.alive,health:jet.health,banked,broke};
  };
  const straight=run(false),breakTurn=run(true);
  const health=vehicleDefinition(VEHICLE.JET)!.maxHealth;
  assert.ok(straight.health<health || !straight.alive,'flying straight must not grant immunity');
  assert.ok(straight.alive && straight.health>health*.45,'one missile gives the pilot time to respond or escape');
  assert.ok(breakTurn.banked,'the pilot performs a physical banking maneuver');
  assert.ok(breakTurn.broke,'the missile seeker loses a sufficiently sharp break');
  assert.ok(breakTurn.alive && breakTurn.health===health,'the maneuver avoids the incoming warhead without artificial invulnerability');
});

test('a healthy fighter survives two isolated locked hits while a third destroys it; ground armor keeps its multiplier',()=>{
  const {game,player,bot}=fixture(13);player.faction=1;campaign(game);
  const pilot=new ServerPlayer(90,'Straight flight',null,false,{x:0,y:100,z:-260});pilot.faction=2;
  const jet=hull(981,VEHICLE.JET,-260);jet.y=100;jet.occupant=pilot.id;game.vehicles.set(jet.id,jet);
  Object.assign(pilot.state,{vehicle:VEHICLE.JET,vehicleId:jet.id,grounded:false});pilot.vehicleId=jet.id;game.players.set(pilot.id,pilot);
  const hits:number[]=[],launches:number[]=[];
  for(let i=0;i<1800 && pilot.state.alive;i++) {
    Object.assign(pilot.state,{px:0,py:100,pz:-260,vx:0,vy:0,vz:0});
    const cmd=bot.think(game);if(cmd.buttons&BTN.FIRE)launches.push(game.tick);
    const before=jet.health;
    game.queueInput(player,cmd);game.step();
    if(jet.health<before)hits.push(jet.health);
  }
  assert.equal(hits.length,3,`ordinary direct hit plus splash should require three fresh missile hits: ${JSON.stringify({hits,launches,alive:pilot.state.alive,position:[player.state.px,player.state.pz]})}`);
  assert.ok(hits[0]>300,'the first impact leaves a meaningful chance to evade or bail out');
  assert.ok(hits[1]>0,'a second isolated hit cannot erase an otherwise healthy fighter');
  assert.equal(pilot.state.alive,false,'ignoring repeated warnings remains fatal');
  assert.ok(launches.every((tick,i)=>i===0||tick-launches[i-1]>=BOT_AA_LAUNCH_INTERVAL));
  assert.ok(rocketHullDamageFactor(VEHICLE.TANK)>rocketHullDamageFactor(VEHICLE.JET),'ground armor keeps a larger multiplier');
});
