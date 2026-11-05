import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BotSimulation,BOT_LOD_MIN_POPULATION} from '../src/bot-simulation.js';
import {ServerPlayer} from '../src/game.js';
import {World,type Region} from '@shared/worldgen';
import {BTN,stepMove,type InputCmd} from '@shared/movement';
import {PLAYER,TICK_DT} from '@shared/constants';
import {setVehicleColliders} from '@shared/vehicle-collision';
import {VEHICLE} from '@shared/vehicles';

const meridian={seed:1337,x:8099.963859451707,y:79.49807336383007,z:4377.507626967795,vx:-9.347892812736763,vy:0,vz:1.6931922399964983,yaw:1.749984457579788};
// Boulders now rest on their lowest footing (2026-11); this walk grazes a real primitive on Cinder's capital outskirts.
const cinder={seed:7331,x:7116.440953266132,y:8.096203300524241,z:5371.873491596787,vx:-6.405715989973827,vy:0,vz:6.405715989973826,yaw:2.356194490192345};
function fixture(pose=meridian){
  const world=new World(pose.seed),sim=new BotSimulation();
  const players=Array.from({length:BOT_LOD_MIN_POPULATION},(_,i)=>{
    const p=new ServerPlayer(i,'capital walker',null,true,{x:i?0:pose.x,y:i?.1:pose.y,z:i?0:pose.z});p.botRosterIndex=i;return p;
  });
  const p=players[0];Object.assign(p.state,{grounded:true,vx:pose.vx,vy:pose.vy,vz:pose.vz});
  const input:InputCmd={seq:1,buttons:BTN.FORWARD,weapon:1,yaw:pose.yaw,pitch:0,renderTick:0,renderFrac:0};
  return{world,sim,players,p,input};
}

test('captured open capital outskirts retain native supported movement instead of the district-wide veto',()=>{
  for(const pose of [meridian,cinder]){
    const f=fixture(pose),start={x:f.p.state.px,z:f.p.state.pz};
    assert.equal(f.world.collectRegion(pose.x-5,pose.x+5,pose.z-5,pose.z+5).capitalArea,true);
    assert.equal(f.world.sampleColumn(pose.x,pose.z).city,undefined,'the witness is natural outskirts, not an authored city-plane shortcut');
    for(let tick=1;tick<=120;tick++){
      f.world.motionTime=tick/60;f.sim.prepare(tick,f.players,[]);
      if(!f.sim.move(f.world,f.p,f.input,TICK_DT,tick)){
        const dt=f.sim.physicsDt(f.world,f.p,f.input,TICK_DT,tick);if(dt)stepMove(f.world,f.p.state,f.input,dt,tick);
      }
      assert.equal(f.p.state.alive,true);assert.equal(f.p.state.grounded,true);
      assert.ok(f.world.sdf(f.p.state.px,f.p.state.py+PLAYER.HEIGHT/2,f.p.state.pz)>0,'body remains in canonical air');
    }
    assert.ok(f.sim.stats.groundTicks>48,JSON.stringify(f.sim.stats));
    if(pose===cinder)assert.ok(f.sim.stats.fullTicks>0&&f.sim.stats.reasons['static geometry']>0,'the later real primitive still returns control to shared physics');
    assert.ok(Math.hypot(f.p.state.px-start.x,f.p.state.pz-start.z)>17,'native supported route makes sustained progress');
    assert.equal(f.p.state.simulationTick,120);
  }
});

test('capital bounds preserve thin, vertical, tapered and grazing shells and reject incomplete metadata',()=>{
  const sim=new BotSimulation(),blocked=(sim as unknown as {capitalBlocked(r:Region,x0:number,x1:number,z0:number,z1:number,y0:number,y1:number):boolean}).capitalBlocked.bind(sim);
  const point=(x:number,y:number,z:number,radius:number)=>({x,y,z,radius});
  const cases=[
    {a:point(2,-2,0,.001),b:point(2,5,0,.001)},
    {a:point(2,1,-2,.001),b:point(2,1,2,1)},
    {a:point(2,-1.7,0,1),b:point(3,-1.7,0,1)},
  ];
  const region:Region={capitalArea:true,capitalSegments:[],sites:[],boulders:[],pads:[],solids:[],cuts:[],vegetation:[]};
  for(const segment of cases)for(const reversed of [false,true]){
    region.capitalSegments=[reversed?{a:segment.b,b:segment.a}:segment];
    assert.equal(blocked(region,-.54,4.42,-.54,.54,-.7,2.2),true);
  }
  region.capitalSegments=[{a:point(2,20,0,1),b:point(2,25,0,2)}];
  assert.equal(blocked(region,-.54,4.42,-.54,.54,-.7,2.2),false,'distant high crown cannot create solid in this ground corridor');
  for(const segments of [undefined,new Array(1),[{a:point(2,0,0,NaN),b:point(3,0,0,1)}]]){
    region.capitalSegments=segments;assert.equal(blocked(region,-.54,4.42,-.54,.54,-.7,2.2),true);
  }
});

test('modified field and collection providers invalidate an already admitted capital corridor immediately',()=>{
  const f=fixture(),saved={...f.p.state};
  for(const key of ['sdf','sdfCol','sampleColumn','column','collectRegion','collectStructures','collectCities','terrainSdfCol'] as const){
    Object.assign(f.p.state,saved);f.sim.resetMovement(f.p);f.sim.prepare(1,f.players,[]);
    assert.equal(f.sim.move(f.world,f.p,f.input,TICK_DT,1),true,key+' native admission');
    const original=f.world[key],record=f.world as unknown as Record<string,unknown>;
    record[key]=(...args:unknown[])=>Reflect.apply(original,f.world,args);
    const before={...f.p.state};f.sim.prepare(2,f.players,[]);
    assert.equal(f.sim.move(f.world,f.p,f.input,TICK_DT,2),false,key+' cannot borrow native metadata proof');
    assert.deepEqual(f.p.state,before);record[key]=original;
  }
});

test('human interest and live hulls still interrupt newly admitted capital ground paths',()=>{
  for(const reason of ['human','hull'] as const){
    const f=fixture();f.sim.prepare(1,f.players,[]);assert.equal(f.sim.move(f.world,f.p,f.input,TICK_DT,1),true);
    if(reason==='human')f.players.push(new ServerPlayer(999,'observer',null,false,{x:f.p.state.px,y:f.p.state.py,z:f.p.state.pz}));
    else setVehicleColliders(f.world,2,[{id:500,type:VEHICLE.JEEP,x:f.p.state.px,y:f.p.state.py,z:f.p.state.pz,heading:0,health:100,vx:12}]);
    f.sim.prepare(2,f.players,[]);assert.equal(f.sim.move(f.world,f.p,f.input,TICK_DT,2),false,reason);
    assert.equal(f.sim.physicsDt(f.world,f.p,f.input,TICK_DT,2),TICK_DT,reason);
  }
});
