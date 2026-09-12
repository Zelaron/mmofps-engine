import {test} from 'node:test';
import assert from 'node:assert/strict';
import {World,airliftPose,airliftDuration,createMoveState,stepMove,BTN,TICK_DT,ByteReader,ByteWriter,encodeSnapshot,decodeSnapshot,createFullAmmoLoadout,type Snapshot} from '@shared/index';

test('every pod has a clear launch well and every flight has zero-speed endpoints',()=>{
  for(const seed of [1,1337,424242]) {
    const world=new World(seed),plan=world.collectTransportPlan();
    for(const a of plan.pods) {
      for(let y=a.y+4;y<340;y+=2)assert.ok(world.sdf(a.x,y,a.z)>1.4,`pod ${a.id} launch blocked at ${y}`);
      for(const b of plan.pods.filter(p=>p.id!==a.id)) {
        const durationTicks=Math.round(airliftDuration(a,b)*60),flight={source:a.id,destination:b.id,startTick:100,durationTicks};
        assert.ok(durationTicks>=840&&durationTicks<=1800);
        const start=airliftPose(plan,flight,100)!,end=airliftPose(plan,flight,100+durationTicks)!;
        assert.deepEqual([start.x,start.y,start.z],[a.x,a.y+.08,a.z]);
        assert.deepEqual([end.x,end.y,end.z],[b.x,b.y+.08,b.z]);
        assert.ok(Math.hypot(start.vx,start.vy,start.vz)<.1&&Math.hypot(end.vx,end.vy,end.vz)<.1);
        const middle=airliftPose(plan,flight,100+durationTicks/2)!;
        assert.ok(middle.y>1500);assert.ok(middle.progress===.5);
      }
    }
  }
});

test('flight snapshots round-trip and prediction ignores movement, jump and gravity in the pod',()=>{
  const world=new World(1337),plan=world.collectTransportPlan(),a=plan.pods[0],b=plan.pods[1];
  const flight={source:a.id,destination:b.id,startTick:100,durationTicks:1200};
  const state=createMoveState(a.x,a.y,a.z);state.airlift=flight;state.simulationTick=500;
  const snap:Snapshot={tick:500,lastSeq:0,ents:[],you:{...state,airlift:flight,health:100,weapon:0,cooldown:0,
    ammo:createFullAmmoLoadout(),reloadWeapon:-1,reloadCooldown:0,reloadHeld:false,vehicleHealth:0,lockState:0}};
  const writer=new ByteWriter();encodeSnapshot(writer,snap);const reader=new ByteReader(writer.finish());reader.u8();
  const decoded=decodeSnapshot(reader);assert.deepEqual(decoded.you.airlift,flight);assert.equal(reader.remaining,0);
  const replay={...state,airlift:decoded.you.airlift};
  const cmd={seq:1,buttons:BTN.FORWARD|BTN.JUMP|BTN.FIRE,yaw:1,pitch:0,weapon:0,renderTick:0,renderFrac:0};
  for(let i=0;i<80;i++){stepMove(world,state,cmd,TICK_DT);stepMove(world,replay,{...cmd,buttons:0},TICK_DT);}
  assert.deepEqual([state.px,state.py,state.pz],[replay.px,replay.py,replay.pz]);
  assert.equal(state.grounded,false);assert.equal(state.submerged,false);
});
