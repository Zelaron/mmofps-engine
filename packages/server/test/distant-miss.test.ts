import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, ServerPlayer, type ServerVehicle } from '../src/game.js';
import { BTN, NET, PLAYER, VEHICLE, WEAPONS, World, ByteReader, Msg, decodeFire,
  pelletDir, RAILGUN_ID, NOCTURNE_LANCE, type InputCmd, type WeaponDef } from '@shared/index';

const cmd: InputCmd = { seq: 31, buttons: BTN.FIRE, weapon: 1, yaw: 0, pitch: 0, renderTick: 0, renderFrac: 0 };
const ordinary: WeaponDef = { ...WEAPONS[1], spread: 0, range: 100 };
type Internals = {
  fireHitscan(p: ServerPlayer, c: InputCmd, d: WeaponDef, attachment?: {x:number;y:number;z:number}): void;
  events: {bytes: Uint8Array}[];
  history: ({tick:number;byId:Map<number,{x:number;y:number;z:number;alive:boolean}>}|null)[];
};
function arena(wall = false) {
  const g = new Game(1337); g.tick = 100;
  let queries = 0;
  g.world.sdf = (_x,y,z) => { queries++; return wall ? Math.min(y,z+10) : y; };
  g.world.liquidAt = () => undefined;
  const intern = g as unknown as Internals;
  const add = (id:number,x=0,z=0,bot=true,sink=false) => {
    const p = new ServerPlayer(id,'actor'+id,sink ? {send(){}} : null,bot,{x,y:0,z});
    p.spawnProtectedUntil = -1; g.players.set(id,p); return p;
  };
  const p = add(1);
  const shoot = (def=ordinary,c=cmd,attachment?:{x:number;y:number;z:number}) => intern.fireHitscan(p,c,def,attachment);
  const fires = () => intern.events.filter(e=>e.bytes[0]===Msg.SFire);
  return {g,p,intern,add,shoot,fires,queries:()=>queries};
}
type Arena = ReturnType<typeof arena>;
function retained(setup:(a:Arena)=>{def?:WeaponDef;cmd?:InputCmd}|void, wall=false) {
  const a=arena(wall), b=arena(wall), sa=setup(a), sb=setup(b);
  // A delegated trace retains the original path under the custom-provider guard.
  b.g.world.trace=b.g.world.trace.bind(b.g.world);
  a.shoot(sa?.def,sa?.cmd); b.shoot(sb?.def,sb?.cmd);
  assert.equal(a.fires().length,1);
  assert.deepEqual(a.intern.events,b.intern.events,'retained packets must stay exact');
  assert.deepEqual([...a.g.players].map(([id,p])=>[id,p.health,p.state]),
    [...b.g.players].map(([id,p])=>[id,p.health,p.state]));
  assert.deepEqual([...a.g.vehicles],[...b.g.vehicles]);
  return a;
}

test('distant miss omission uses all humans and the real muzzle interest boundary',()=>{
  for (const x of [NET.INTEREST_RADIUS,NET.INTEREST_RADIUS+1e-9]) {
    const a=arena(), human=a.add(2,x,0,false); human.state.alive=false; human.state.py=10000;
    a.shoot(); assert.equal(a.fires().length,x===NET.INTEREST_RADIUS?1:0);
    if(x>NET.INTEREST_RADIUS) assert.equal(a.queries(),0);
  }
  for(const muzzleX of [-20,20]) {
    const a=arena(); a.add(2,800,0,false); a.shoot(ordinary,cmd,{x:muzzleX,y:PLAYER.EYE_HEIGHT,z:0});
    assert.equal(a.fires().length,muzzleX===20?1:0,'range is measured from muzzle');
  }
  const a=arena(); a.add(2,1000,0,false); a.add(3,700,0,false); a.shoot(); assert.equal(a.fires().length,1);
});

test('custom observers and unusual human motion retain misses',()=>{
  const setups: ((a:Arena)=>void)[] = [
    a=>{a.add(2,1000,0,true,true);}, a=>{Object.assign(a.p,{isBot:false});},
    a=>{a.add(2,1000,0,false).state.vx=256.001;},
    a=>{a.add(2,1000,0,false).state.vz=NaN;},
    a=>{a.add(2,1000,0,false).airlift={source:1,destination:2,start:90,x:1000,y:0,z:0,health:100};},
    a=>{a.add(2,1000,0,false).state.airlift={source:1,destination:2,startTick:90,durationTicks:600};},
  ];
  for(const setup of setups) retained(setup);
  const a=arena(); a.add(2,1000,0,false).state.vx=256; a.shoot(); assert.equal(a.fires().length,0);
});

test('instance and prototype trace overrides keep their original event contract',()=>{
  const native=World.prototype.trace;
  for(const prototype of [false,true]) {
    const a=arena(); let calls=0;
    const custom: World['trace']=function(this:World,...args){calls++;return native.apply(this,args);};
    try {
      if(prototype) World.prototype.trace=custom; else a.g.world.trace=custom;
      a.shoot(); assert.equal(calls,1); assert.equal(a.fires().length,1);
    } finally { World.prototype.trace=native; }
  }
});

test('possible targets preserve cover, full-range and rewound damage selection',()=>{
  const covered=retained(a=>{a.add(2,0,-20);},true);
  assert.equal(covered.g.players.get(2)!.health,100,'possible target behind cover still traces');
  const distant=retained(a=>{a.add(2,0,-900);return {def:{...ordinary,range:1000}};});
  assert.ok(distant.g.players.get(2)!.health<100);
  for(const currentMiss of [true,false]) {
    const setup=(a:Arena)=>{
      const p=a.add(2,currentMiss?20:0,-20);
      for(const tick of [93,94]) a.intern.history[tick%NET.LAG_HISTORY_TICKS]={tick,byId:new Map([[p.id,{x:currentMiss?0:20,y:0,z:-20,alive:true}]])};
      return {cmd:{...cmd,renderTick:93,renderFrac:.4}};
    };
    if(currentMiss) retained(setup);
    else {const a=arena(),s=setup(a);a.shoot(ordinary,s.cmd);assert.equal(a.fires().length,0);assert.equal(a.g.players.get(2)!.health,100);}
  }
});

test('hulls, wildlife and mixed pellets keep whole packets and damage',()=>{
  retained(a=>{
    const v:ServerVehicle={id:80,type:VEHICLE.JEEP,x:0,y:0,z:-20,heading:0,health:1000,occupant:-1,respawnAtTick:-1};
    a.g.vehicles.set(v.id,v);
  });
  retained(a=>{assert.ok(a.g.wildlife.spawn(0,{x:0,y:PLAYER.EYE_HEIGHT,z:-10}));});
  const a=retained(a=>{
    const def={...WEAPONS[2],spread:.108,range:80},d=pelletDir(a.g.seed,1,cmd.seq,0,0,0,def.spread),t=45;
    const p=a.add(2,d.x*t,d.z*t);p.state.py=PLAYER.EYE_HEIGHT+d.y*t-PLAYER.HEIGHT/2;
    return {def};
  });
  const r=new ByteReader(a.fires()[0].bytes);r.u8();const ends=decodeFire(r).ends;
  assert.ok(ends.some(e=>e.hitKind===1)&&ends.some(e=>e.hitKind!==1));
});

test('special, broad and unknown weapons retain their original gameplay paths',()=>{
  for(const def of [{...ordinary,id:999},{...ordinary,beamRadius:.6},{...ordinary,beamRadius:NaN}]) retained(()=>({def}));
  const rail=retained(()=>({def:{...WEAPONS[RAILGUN_ID],spread:0}}),true);
  assert.ok(rail.g.projectiles.size>0);
  const lance=retained(()=>({def:{...NOCTURNE_LANCE,spread:0,pellets:1}}),true);
  assert.ok(lance.intern.events.some(e=>e.bytes[0]===Msg.SExplosion));
});
