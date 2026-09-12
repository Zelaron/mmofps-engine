import { cityVehicleSites } from '@shared/cities';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, type ServerPlayer } from '../src/game.js';
import { BTN, vehicleDefinition, vehicleArmament, ByteReader, Msg, decodeFire, decodeSnapshot,
  rotationFromEuler, bastionGunMuzzle, type InputCmd } from '@shared/index';

test('capital vehicles spawn only at their themed landmark and return there after destruction', () => {
  const game = new Game(1337); game.initVehicles();
  const expected = game.world.collectCities().flatMap(c => cityVehicleSites(c));
  const special = [...game.vehicles.values()].filter(v => v.variant===1||v.variant===2);
  assert.equal(special.length,2); assert.equal(expected.length,2);
  for(const v of special) {
    const site=expected.find(s=>s.variant===v.variant)!; assert.ok(site);
    assert.equal(v.x,site.x); assert.equal(v.z,site.z); assert.ok(Math.abs(v.y-site.y)<.1);
    assert.equal(v.health,vehicleDefinition(v.type,v.variant)!.maxHealth);
    v.x+=1200; v.z-=800; game.damageVehicle(v,v.health+1,null,255);
    game.tick=v.respawnAtTick;
    (game as unknown as {updateVehicles():void}).updateVehicles();
    assert.equal(v.x,site.x); assert.equal(v.z,site.z); assert.equal(v.respawnAtTick,-1);
  }
  assert.equal([...game.vehicles.values()].filter(v=>!v.variant && v.type===3).length,3);
  assert.equal([...game.vehicles.values()].filter(v=>!v.variant && v.type===2).length,5);
});

test('both capital armaments fire real bounded server weapons with correct cooldowns and attachments', () => {
  const game=new Game(1337), p=game.addPlayer('Capital pilot',null);
  const intern=game as unknown as {fireVehicleWeapons(p:ServerPlayer,c:InputCmd):void; events:{bytes:Uint8Array}[]};
  game.world.trace=(x,y,z,dx,dy,dz,max)=>({hit:false,x:x+dx*max,y:y+dy*max,z:z+dz*max,nx:0,ny:0,nz:0,dist:max});
  for(const [type,variant] of [[3,1],[2,2]]) {
    Object.assign(p.state,{vehicle:type,vehicleVariant:variant,px:0,py:1500,pz:0,heading:.7,vehicleRotation:rotationFromEuler(.7,Math.PI,.5)});
    const cmd={seq:1,buttons:BTN.FIRE|BTN.ALTFIRE,weapon:0,yaw:-1.2,pitch:.3,renderTick:0,renderFrac:0};
    p.vehFireCd=p.vehAltCd=0;game.projectiles.clear();intern.events.length=0;
    intern.fireVehicleWeapons(p,cmd); const arm=vehicleArmament(type,variant);
    const events=intern.events.filter(e=>e.bytes[0]===Msg.SFire).map(e=>{const r=new ByteReader(e.bytes);r.u8();return decodeFire(r);});
    assert.deepEqual(events.map(e=>e.weapon),[arm.primary.id,arm.alt!.id]);
    assert.equal(game.projectiles.size,type===3?1:2,'one projectile per cannon action, one bomb per release');
    assert.equal(p.vehFireCd,arm.primary.interval);assert.equal(p.vehAltCd,arm.alt!.interval);
    intern.fireVehicleWeapons(p,cmd);assert.equal(intern.events.filter(e=>e.bytes[0]===Msg.SFire).length,2);
    for(const projectile of game.projectiles.values()) {
      assert.ok(Number.isFinite(projectile.vx+projectile.vy+projectile.vz));
      assert.ok(projectile.distLeft<=1600);assert.ok((vehicleArmament(type,variant).alt!.splashRadius ?? 0)<=115);
      if(type===2) {
        const muzzle=bastionGunMuzzle(p.state.heading,cmd.yaw,cmd.pitch);
        assert.ok(Math.hypot(projectile.x-muzzle.x,projectile.y-1500-muzzle.y,projectile.z-muzzle.z)<1e-8);
      }
    }
  }
});

test('possession and exit replicate the special hull without leaking its variant onto the player', () => {
  const game=new Game(1337),p=game.addPlayer('Driver',null);game.initVehicles();
  const intern=game as unknown as {toggleVehicle(p:ServerPlayer):void;buildSnapshotFor(p:ServerPlayer):Uint8Array};
  for(const vehicle of [...game.vehicles.values()].filter(v=>v.variant)) {
    Object.assign(p.state,{px:vehicle.x+2.5,py:vehicle.y,pz:vehicle.z});
    intern.toggleVehicle(p);assert.equal(p.state.vehicle,vehicle.type);assert.equal(p.state.vehicleVariant,vehicle.variant);
    const r=new ByteReader(intern.buildSnapshotFor(p));r.u8();const snap=decodeSnapshot(r);
    assert.equal(snap.you.vehicleVariant,vehicle.variant);assert.equal(snap.you.vehicleHealth,vehicle.health);
    assert.ok(!(snap.vehicles??[]).some(v=>v.id===vehicle.id),'occupied hull is carried by its driver only');
    intern.toggleVehicle(p);assert.equal(p.state.vehicle,0);assert.equal(p.state.vehicleVariant,0);
  }
});
