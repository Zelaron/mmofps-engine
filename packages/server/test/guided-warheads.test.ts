import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Game,type ServerPlayer,type ServerVehicle} from '../src/game.js';
import {WEAPONS,LOCK_TICKS,LOCK_LOCKED,LOCK_NONE,PLAYER,VEHICLE,rocketHullDamageFactor,vehicleDefinition,type InputCmd,type WeaponDef} from '@shared/index';

function crewTarget() {
  const game = new Game(1337), shooter = game.addPlayer('Launcher', null), driver = game.addPlayer('Driver', null), gunner = game.addPlayer('Gunner', null);
  game.world.trace = (x,y,z,dx,dy,dz,max) => ({ hit:false, dist:max, x:x+dx*max, y:y+dy*max, z:z+dz*max, nx:0, ny:0, nz:0 });
  Object.assign(shooter.state, { px:0, py:1000, pz:0 }); shooter.weapon = 3;
  const hull: ServerVehicle = { id:901, type:2, x:0, y:1000, z:-40, heading:0, health:4500, occupant:driver.id, gunner:gunner.id, respawnAtTick:-1 };
  game.vehicles.set(hull.id, hull);
  for (const [seat, player] of [driver, gunner].entries()) {
    Object.assign(player.state, { px:hull.x, py:hull.y, pz:hull.z, vehicle:2, seat, vehicleId:hull.id });
    player.vehicleId = hull.id;
  }
  const cmd: InputCmd = { seq:1, buttons:0, weapon:3, yaw:0, pitch:Math.atan2(1.9-PLAYER.EYE_HEIGHT,40), renderTick:0, renderFrac:0 };
  type Missile = NonNullable<ReturnType<typeof game.projectiles.get>>;
  const intern = game as unknown as {
    updateHomingLock(p:ServerPlayer,c:InputCmd):void;
    fireProjectile(p:ServerPlayer,c:InputCmd,d:WeaponDef):void;
    steerHomingProjectile(r:Missile,dt:number):void;
  };
  const aim = (ticks = 1) => { for (let i=0; i<ticks; i++) intern.updateHomingLock(shooter,cmd); };
  return { game, shooter, driver, gunner, hull, cmd, intern, aim };
}

test('two-second locks launch fast warheads; guided or not, a rocket is anti-armor on the hull it hits',()=>{
  const game=new Game(1337),p=game.addPlayer('Missile gunner',null),driver=game.addPlayer('Tank driver',null);
  game.world.trace=(x,y,z,dx,dy,dz,max)=>({hit:false,dist:max,x:x+dx*max,y:y+dy*max,z:z+dz*max,nx:0,ny:0,nz:0});
  Object.assign(p.state,{px:0,py:1000,pz:0});p.weapon=3;
  Object.assign(driver.state,{px:0,py:1000,pz:-40,vehicle:2});driver.vehicleId=900;
  const hull={id:900,type:2 as const,x:0,y:1000,z:-40,heading:0,health:4500,occupant:driver.id,respawnAtTick:-1};
  game.vehicles.set(hull.id,hull);
  const cmd:InputCmd={seq:1,buttons:0,weapon:3,yaw:0,pitch:Math.atan2(1.9-PLAYER.EYE_HEIGHT,40),renderTick:0,renderFrac:0};
  const intern=game as unknown as {updateHomingLock(p:ServerPlayer,c:InputCmd):void;fireProjectile(p:ServerPlayer,c:InputCmd,d:WeaponDef):void;updateProjectiles():void};
  for(let i=0;i<LOCK_TICKS-1;i++)intern.updateHomingLock(p,cmd);
  assert.notEqual(p.lockState,LOCK_LOCKED);intern.updateHomingLock(p,cmd);assert.equal(p.lockState,LOCK_LOCKED);
  intern.fireProjectile(p,cmd,WEAPONS[3]);const missile=[...game.projectiles.values()][0];
  assert.ok(Math.abs(Math.hypot(missile.vx,missile.vy,missile.vz)-300)<1e-8);assert.equal(missile.distLeft,1500);
  driver.state.vehicle=0;driver.state.px=100;hull.occupant=-1;
  for(let i=0;i<15&&game.projectiles.has(missile.id);i++)intern.updateProjectiles();
  assert.equal(missile.homingTarget,-1);assert.ok(!game.projectiles.has(missile.id));
  const guided=4500-hull.health, direct=WEAPONS[3].damage*rocketHullDamageFactor(VEHICLE.TANK);
  assert.ok(guided>=direct&&guided<direct+116,'a direct hit deals anti-armor damage plus the ordinary blast');
  p.lockState=LOCK_NONE;intern.fireProjectile(p,cmd,WEAPONS[3]);
  const ordinary=[...game.projectiles.values()][0];
  assert.ok(Math.abs(Math.hypot(ordinary.vx,ordinary.vy,ordinary.vz)-48)<1e-8);assert.equal(ordinary.distLeft,600);
  const before=hull.health;
  for(let i=0;i<120&&game.projectiles.has(ordinary.id);i++)intern.updateProjectiles();
  assert.ok(!game.projectiles.has(ordinary.id));
  assert.ok(Math.abs(before-hull.health-guided)<1,'an unguided direct hit is as strong as a guided one');
});

test('unguided rockets destroy a jeep in two direct hits, a gunboat in three, a tank in six and a jet in three',()=>{
  for(const [type,expected] of [[VEHICLE.JEEP,2],[VEHICLE.GUNBOAT,3],[VEHICLE.TANK,6],[VEHICLE.JET,3]] as const){
    const game=new Game(1337),p=game.addPlayer('Rocketeer',null),def=vehicleDefinition(type)!;
    game.world.trace=(x,y,z,dx,dy,dz,max)=>({hit:false,dist:max,x:x+dx*max,y:y+dy*max,z:z+dz*max,nx:0,ny:0,nz:0});
    Object.assign(p.state,{px:0,py:1000,pz:0});p.weapon=3;
    const hull:ServerVehicle={id:900,type,x:0,y:1000,z:-40,heading:0,health:def.maxHealth,occupant:-1,gunner:-1,respawnAtTick:-1};
    game.vehicles.set(hull.id,hull);
    const cmd:InputCmd={seq:1,buttons:0,weapon:3,yaw:0,pitch:Math.atan2(def.radius-PLAYER.EYE_HEIGHT,40),renderTick:0,renderFrac:0};
    const intern=game as unknown as {fireProjectile(p:ServerPlayer,c:InputCmd,d:WeaponDef):void;updateProjectiles():void};
    let hits=0;
    while(hull.health>0&&hull.respawnAtTick<0&&hits<20){
      intern.fireProjectile(p,cmd,WEAPONS[3]);
      const rocket=[...game.projectiles.values()].at(-1)!,before=hull.health;
      for(let i=0;i<120&&game.projectiles.has(rocket.id);i++)intern.updateProjectiles();
      assert.ok(hull.health<before,`every rocket strikes the ${def.name}`);hits++;
    }
    assert.equal(hits,expected,`${def.name} needs ${expected} direct rocket hits`);
  }
});

test('charged locks and in-flight missiles retain the occupied hull when its driver disconnects', () => {
  const { game, shooter, driver, gunner, hull, cmd, intern, aim } = crewTarget();
  aim(LOCK_TICKS);
  assert.equal(shooter.lockState, LOCK_LOCKED);
  intern.fireProjectile(shooter, cmd, WEAPONS[3]);
  const missile = [...game.projectiles.values()][0];
  assert.equal(missile.homingVehicleId, hull.id);
  game.removePlayer(driver.id);
  assert.equal(hull.occupant, gunner.id);
  assert.equal(gunner.state.seat, 0);
  aim();
  assert.equal(shooter.lockState, LOCK_LOCKED, 'the same occupied hull keeps its charge');
  assert.equal(shooter.lockTargetId, gunner.id);
  assert.equal(shooter.lockVehicleId, hull.id);
  gunner.state.px += 2;
  intern.steerHomingProjectile(missile, 1/60);
  assert.equal(missile.homingTarget, gunner.id);
  assert.equal(missile.homingVehicleId, hull.id);
  assert.ok(missile.vx > 0, 'guidance follows the promoted driver pose');
  assert.ok(Math.abs(Math.hypot(missile.vx,missile.vy,missile.vz)-300)<1e-8);
  game.removePlayer(gunner.id);
  intern.steerHomingProjectile(missile, 1/60);
  assert.equal(missile.homingTarget, -1);
  assert.equal(missile.homingVehicleId, -1);
  assert.ok(rocketHullDamageFactor(hull.type) > 1, 'with or without guidance, the rocket stays anti-armor');
});

test('lock continuity still requires a visible hull and does not follow a driver into a different vehicle', () => {
  const { game, shooter, driver, hull, aim } = crewTarget();
  aim(60);
  const other = { ...hull, id:902, gunner:-1 };
  hull.occupant = -1; hull.gunner = -1;
  game.vehicles.set(other.id, other);
  driver.vehicleId = other.id; driver.state.vehicleId = other.id;
  aim();
  assert.equal(shooter.lockTicks, 1, 'a different hull requires a fresh lock');
  assert.equal(shooter.lockVehicleId, other.id);
  aim(30);
  game.world.trace = () => ({ hit:true, dist:1, x:0, y:0, z:0, nx:0, ny:0, nz:1 });
  aim(12);
  assert.equal(shooter.lockState, LOCK_NONE, 'cover must still decay and break lock');
});

test('a crew member cannot acquire their own hull, and a missile never transfers onto the owner hull', () => {
  const { game, shooter, hull, cmd, intern, aim } = crewTarget();
  aim(LOCK_TICKS);
  intern.fireProjectile(shooter, cmd, WEAPONS[3]);
  const missile = [...game.projectiles.values()][0];
  shooter.vehicleId = hull.id;
  Object.assign(shooter.state, { vehicle:2, vehicleId:hull.id, seat:1 });
  aim(60);
  assert.equal(shooter.lockState, LOCK_NONE);
  intern.steerHomingProjectile(missile, 1/60);
  assert.equal(missile.homingTarget, -1);
  assert.equal(missile.homingVehicleId, -1);
});
