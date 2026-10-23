import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TICK_RATE } from '@shared/constants';
import { CAPTURE_HEIGHT, type CampaignBase, type CampaignOrder, type Territory } from '@shared/frontier';
import { VEHICLE } from '@shared/vehicles';
import { CampaignDirector, campaignSquad } from '../src/campaign-director.js';
import { Bot } from '../src/bots.js';
import { campaignTravelOrders } from '../src/bot-campaign-state.js';
import { Game, ServerPlayer } from '../src/game.js';

function fixture(ids=[1,2,3]) {
  const bases:CampaignBase[]=[],controls:Territory[]=[];
  for(let i=0;i<6;i++) {
    const owner=i<2?1:0;
    const base:CampaignBase={id:'base-'+i,name:'Base '+i,kind:i?'city':'outpost',
      x:i*1200,y:10,z:0,owner,homeFaction:i===0?1:0,controlIds:['control-'+i],requiredPoints:1};
    bases.push(base);controls.push({id:base.controlIds[0],name:base.name,kind:'relay',baseId:base.id,
      x:base.x,y:base.y,z:base.z,radius:30,owner,influence:owner?-1:0,captureFaction:owner,
      captureProgress:owner?1:0,contested:false});
  }
  const squads=ids.map(squad=>Array.from({length:6},(_,i)=>{
    const roster=squad*18+i*3;
    const p=new ServerPlayer(0x100000000+roster,'Soldier',null,true,{x:700,y:10,z:250});
    p.faction=1;p.botRosterIndex=roster;p.state.grounded=true;return p;
  }));
  const players=squads.flat(),director=new CampaignDirector(bases,controls);
  const place=(members:ServerPlayer[],site=controls[1])=>members.forEach((p,i)=>Object.assign(p.state,
    {px:site.x+i*.2,py:site.y,pz:site.z,grounded:true,alive:true,vehicle:VEHICLE.NONE}));
  const update=(tick:number)=>director.update(players,tick);
  const order=(p:ServerPlayer,tick=0)=>director.order(p,()=>players,tick)!;
  // Internal marker distinguishes the single quiet reservation from the
  // unchanged threatened/overflow DEFEND operations on the wire.
  const plans=()=>((director as unknown as {plans:Map<number,Map<number,{alertGarrison?:boolean;issuedAt:number}>>}).plans.get(1)!);
  const reserved=()=>[...plans()].filter(([,p])=>p.alertGarrison).map(([id])=>id);
  return{bases,controls,squads,players,director,place,update,order,plans,reserved};
}

test('one occupied alert garrison persists while two other ground squads keep distinct attacks',()=>{
  const f=fixture();f.place(f.squads[0]);f.update(0);
  assert.deepEqual(f.reserved(),[1]);
  assert.equal(f.order(f.squads[0][0]).baseId,f.bases[1].id);
  assert.equal(f.order(f.squads[0][0]).phase,'defend');
  const attacks=f.squads.slice(1).map(s=>f.order(s[0]));
  assert.equal(new Set(attacks.map(o=>o.baseId)).size,2);
  assert.ok(attacks.every(o=>o.baseId!==f.bases[1].id&&o.phase==='assemble'));
  for(const tick of [2,10,90].map(s=>s*TICK_RATE)){
    f.update(tick);assert.deepEqual(f.reserved(),[1]);
    assert.equal(f.order(f.squads[0][0],tick).phase,'defend');
    assert.deepEqual(f.squads.slice(1).map(s=>f.order(s[0],tick).baseId),attacks.map(o=>o.baseId));
    assert.ok([...f.plans().values()].every(p=>p.issuedAt===0),'holding does not renew attack commitment timers');
  }
  assert.ok(f.squads.slice(1).every(s=>f.order(s[0],90*TICK_RATE).phase==='attack'));
});

test('actual capture-volume ground presence wins over nominal proximity or mounted occupancy',()=>{
  const f=fixture([1,2,3,5]);
  f.place(f.squads[0]); // Closer to the front but not enough actual capture witnesses.
  f.squads[0][0].state.py+=CAPTURE_HEIGHT+.001;
  f.squads[0][1].state.px=f.controls[1].x+f.controls[1].radius+.001;
  f.squads[0][2].state.vehicle=VEHICLE.TANK;
  f.squads[0][3].state.grounded=false;
  f.place(f.squads[1].slice(0,3),f.controls[0]);
  f.squads[1][0].state.py+=CAPTURE_HEIGHT; // Existing inclusive boundary, no invented floor.
  f.update(0);assert.deepEqual(f.reserved(),[2]);
  assert.equal(f.order(f.squads[1][0]).baseId,f.bases[0].id);
  // A later better-populated, more forward candidate does not churn a valid guard.
  f.place(f.squads[2]);f.update(2*TICK_RATE);assert.deepEqual(f.reserved(),[2]);
});

test('absent, dead, mixed-air and insufficient expansion forces never force a quiet reservation',()=>{
  const absent=fixture();absent.update(0);assert.deepEqual(absent.reserved(),[]);
  const dead=fixture();dead.place(dead.squads[0]);dead.squads[0].forEach(p=>p.state.alive=false);
  dead.update(0);assert.deepEqual(dead.reserved(),[]);
  const mixed=fixture([0,1,2,3]);mixed.place(mixed.squads[0]);mixed.update(0);
  assert.deepEqual(mixed.reserved(),[],'four air/naval duties are not six eligible feet, even before boarding');
  const small=fixture([1,2]);small.place(small.squads[0]);small.update(0);assert.deepEqual(small.reserved(),[]);
  const noReserve=fixture();noReserve.place(noReserve.squads[0]);noReserve.squads[2].slice(0,4).forEach(p=>p.state.alive=false);
  noReserve.update(0);assert.deepEqual(noReserve.reserved(),[],'dead nominal squads do not satisfy the expansion reserve');
  for(const hull of [VEHICLE.NONE,VEHICLE.JET,VEHICLE.GUNBOAT]){
    const split=fixture();split.place(split.squads[0]);
    Object.assign(split.squads[0][5].state,{px:split.bases[1].x+(hull===VEHICLE.NONE?850:1),vehicle:hull});
    split.update(0);assert.deepEqual(split.reserved(),[],'every living ground-role member must be present, including an unexpected air/naval rider');
  }
});

test('threat and ownership loss release quiet reservation into the existing defense auction',()=>{
  for(const kind of ['pressure','loss'] as const){
    const f=fixture([1,2,3,5]);f.place(f.squads[0]);f.place(f.squads[1],f.controls[0]);f.update(0);
    assert.equal(f.reserved().length,1);
    const guarded=f.order(f.players.find(p=>campaignSquad(p)===f.reserved()[0])!);
    const site=f.controls.find(s=>s.id===guarded.targetId)!;
    if(kind==='pressure')site.pressureFaction=2;
    else{site.owner=2;f.bases.find(b=>b.id===site.baseId)!.owner=2;}
    f.update(TICK_RATE);
    assert.deepEqual(f.reserved(),[],'an urgent response cannot be evaded by reserving a substitute quiet guard');
    assert.ok(f.players.some(p=>f.order(p,TICK_RATE).phase==='defend'&&f.order(p,TICK_RATE).targetId===site.id));
    assert.ok(f.players.some(p=>f.order(p,TICK_RATE).baseId!==site.baseId),'bounded defense leaves ongoing operations');
  }
});

test('real orbital travel override releases the local guard and retains its explicit destination',()=>{
  const f=fixture();f.place(f.squads[0]);f.update(0);assert.deepEqual(f.reserved(),[1]);
  const player=f.squads[0][0],bot=new Bot(player,1337),port={id:'orbital-duty',x:8000,y:10,z:0};
  bot.setTravelWaypoint(port);
  assert.equal(campaignTravelOrders.get(player)?.objective.id,port.id);
  f.update(2*TICK_RATE);assert.deepEqual(f.reserved(),[]);
  const internal=bot as unknown as {campaign(game:Game):{order:CampaignOrder;objective:Territory}};
  const duty=internal.campaign({frontier:{order:()=>f.order(player),territories:f.controls}} as unknown as Game);
  assert.equal(duty.order.targetId,port.id);assert.equal(duty.objective.x,port.x);
  bot.setTravelWaypoint(null);assert.equal(campaignTravelOrders.has(player),false);
  f.update(4*TICK_RATE);assert.deepEqual(f.reserved(),[1]);
});

test('departed or airlifted occupants release the guard without recalling them or changing poses',()=>{
  for(const kind of ['departed','airlift'] as const){
    const f=fixture();f.place(f.squads[0]);f.update(0);assert.deepEqual(f.reserved(),[1]);
    if(kind==='departed')f.squads[0].forEach(p=>p.state.pz+=1000);
    else f.squads[0][0].state.airlift={source:0,destination:1,startTick:0,durationTicks:600};
    const states=f.players.map(p=>structuredClone(p.state));
    f.update(2*TICK_RATE);assert.deepEqual(f.reserved(),[]);
    assert.deepEqual(f.players.map(p=>p.state),states,'strategic orders never assign physical positions');
  }
});
