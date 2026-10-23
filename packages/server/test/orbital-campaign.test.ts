import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CampaignExchange, CampaignReport } from '@shared/campaign-war';
import { Game, ServerPlayer } from '../src/game.js';
import { Bot, botCampaignRole } from '../src/bots.js';
import { captureActors, type DetachedHandoff } from '../src/runtime-handoff.js';
import { OrbitalCampaign, relocateExpedition, selectExpeditionTargets } from '../src/orbital-campaign.js';

test('expedition priorities reinforce a threatened foothold before an empty foreign city', () => {
  const reports: CampaignReport[] = [{ planet:'cinder',tick:100,ownership:[.5,.2,.2,.1],botPopulation:[0,20,20,20],bases:[
    {id:'empty',name:'Empty city',owner:0,x:0,z:0,held:[3,0,0,0],attackers:[]},
    {id:'partial',name:'Contested foothold',owner:2,x:1000,z:0,held:[0,1,2,0],attackers:[2]},
    {id:'safe',name:'Safe ally city',owner:1,x:2000,z:0,held:[0,3,0,0],attackers:[]},
  ]}];
  assert.deepEqual(selectExpeditionTargets(reports,'meridian',1).map(target=>target.base.id),['partial','empty']);
  assert.deepEqual(selectExpeditionTargets(reports,'cinder',1),[], 'local reports cannot create an orbital round trip');
});

test('orbital arrival preserves identity and inventory across independent planetary clocks and resets source motion', () => {
  const source=new Game(1337), destination=new Game(7331);
  source.tick=3000;destination.tick=60;
  const player=new ServerPlayer(987,'Traveller',null,true,{x:1,y:2,z:3});player.faction=2;
  player.health=83;player.weapon=3;player.ammo[3].magazine=1;player.ammo[3].reserve=4;
  player.salvage=213;player.campaignRewards=[1337];player.discoveries.add('1337:city-2');
  player.regenBlockUntil=3600;player.lastProcessedSeq=999;player.lastQueuedSeq=1000;player.hasQueuedSeq=true;
  player.state.vx=17;player.state.vy=-5;source.players.set(player.id,player);
  const record=relocateExpedition(destination,captureActors(source,[player.id]).record,[{x:20,y:40,z:60}]);
  const [arrival]=destination.acceptHandoff(record,new Map());
  assert.equal(arrival.id,player.id);assert.equal(arrival.name,player.name);assert.equal(arrival.faction,2);
  assert.equal(arrival.health,83);assert.equal(arrival.weapon,3);assert.equal(arrival.salvage,213);
  assert.deepEqual(arrival.ammo,player.ammo);assert.deepEqual(arrival.campaignRewards,[1337]);
  assert.deepEqual([...arrival.discoveries],['1337:city-2']);
  assert.equal(arrival.regenBlockUntil,660,'cooldowns keep their remaining duration, not another planet clock');
  assert.deepEqual([arrival.state.px,arrival.state.py,arrival.state.pz],[20,40,60]);
  assert.deepEqual([arrival.state.vx,arrival.state.vy,arrival.state.vz],[0,0,0]);
  assert.equal(arrival.hasQueuedSeq,false,'new bot controllers can submit their initial sequence');
  assert.equal(player.state.vx,17,'arrival conversion does not mutate the retained source record');
});

test('arriving infantry receives a fresh contiguous ground squad instead of flight crew roles', () => {
  const game=new Game(1337), first=game.reserveBotRoster(1,6), next=game.reserveBotRoster(2,6);
  assert.equal(new Set(first.map(index=>Math.floor(index/18))).size,1);
  assert.equal(new Set(next.map(index=>Math.floor(index/18))).size,1);
  assert.notEqual(Math.floor(first[0]/18),Math.floor(next[0]/18));
  assert.ok([...first,...next].every(index=>!['pilot','aircrew','sailor','navalcrew'].includes(botCampaignRole(index+1))));
  assert.deepEqual(first.map(index=>index%3),Array(6).fill(0));
  assert.deepEqual(next.map(index=>index%3),Array(6).fill(1));
});

test('strategic reports include attackers at contested controls even when net capture pressure is zero', async () => {
  const game=new Game(1337,{frontier:true}), point=game.frontier!.territories[0];
  Object.assign(point,{owner:1,contested:true,pressureFaction:0,progressRate:0});
  const raider=new ServerPlayer(988,'Contesting raider',null,true,{x:point.x,y:point.y,z:point.z});raider.faction=2;
  game.players.set(raider.id,raider);
  let report:CampaignReport|undefined;
  const service=new OrbitalCampaign(game,[],{planet:'meridian',authority:()=>({id:'report-fixture',epoch:1}),ready:()=>true,populationLimit:()=>192,
    call:async<T>(_method:string,body:unknown)=>{
      report=(body as {report:CampaignReport}).report;
      return {reports:[],alerts:[],arrivals:[]} as CampaignExchange as T;
    }});
  await service.sync();
  assert.deepEqual(report!.bases.find(base=>base.id===point.baseId)!.attackers,[2]);
  await service.close();
});

test('strategic reports exclude friendly restoration but retain enemy and neutral capture pressure', async () => {
  const game=new Game(1337,{frontier:true}), point=game.frontier!.territories[0];
  Object.assign(point,{owner:1,influence:-.5,captureFaction:1,captureProgress:.5,contested:false});
  const soldier=new ServerPlayer(989,'Control participant',null,true,{x:point.x,y:point.y,z:point.z});soldier.faction=1;
  game.players.set(soldier.id,soldier);
  let report:CampaignReport|undefined;
  const service=new OrbitalCampaign(game,[],{planet:'meridian',authority:()=>({id:'restoration-fixture',epoch:1}),ready:()=>true,populationLimit:()=>192,
    call:async<T>(_method:string,body:unknown)=>{
      report=(body as {report:CampaignReport}).report;
      return {reports:[],alerts:[],arrivals:[]} as CampaignExchange as T;
    }});
  const update=async()=>{
    game.tick+=60;game.frontier!.step(game.players.values(),game.tick,1);
    await service.sync();
    return report!.bases.find(base=>base.id===point.baseId)!.attackers;
  };
  try {
    assert.deepEqual(await update(),[],'a defender restoring lost strength must not create a planetary distress report');
    assert.equal(point.pressureFaction,1);
    assert.ok(point.progressRate!>0,'the fixture exercises actual friendly restoration');

    soldier.faction=2;
    assert.deepEqual(await update(),[2],'enemy neutralization must still request reinforcements');
    assert.ok(point.progressRate!<0);

    Object.assign(point,{owner:0,influence:.5,captureFaction:2,captureProgress:.5});
    assert.deepEqual(await update(),[2],'a faction claiming a neutral control still reports its active assault');
    assert.ok(point.progressRate!>0);
  } finally { await service.close(); }
});

for (const outcome of ['cancelled', 'committed'] as const) test(`an uncertain orbital departure waits for durable ${outcome} before resolving its frozen squad`, async () => {
  const game = new Game(1337), player = new ServerPlayer(987, 'Uncertain traveller', null, true, { x: 1, y: 2, z: 3 });
  player.faction = 1; player.salvage = 123; game.players.set(player.id, player);
  const bots = [new Bot(player, game.seed)], frozen = game.takeHandoff([player.id]);
  let confirm!: (value: { id: string; state: typeof outcome }) => void, cancellations = 0;
  const cancellation = new Promise<{ id: string; state: typeof outcome }>(resolve => { confirm = resolve; });
  const id = 'uncertain-orbital-fixture';
  const service = new OrbitalCampaign(game, bots, { planet: 'meridian', authority: () => ({ id: 'source', epoch: 1 }),
    ready: () => true, populationLimit: () => 192, call: async <T>(method: string): Promise<T> => {
      if (method === 'campaign/depart') throw new Error('Departure response was lost');
      if (method === 'campaign/transfer') return null as T;
      if (method === 'campaign/cancel') { cancellations++; return await cancellation as T; }
      return { reports: [], alerts: [], arrivals: [] } as CampaignExchange as T;
    } });
  // Start at the real post-charge handoff boundary; movement and physical
  // pod charging are covered by the generated-world integration test.
  (service as unknown as { expedition: unknown }).expedition = { id, destination: 'cinder', targetBaseId: 'base-city-2', faction: 1,
    members: [...bots], port: { id: 1, stationId: 1, name: 'Pod', x: 1, y: 2, z: 3 }, started: game.tick,
    frozen: frozen as DetachedHandoff, authority: { id: 'source', epoch: 1 }, retryAt: 0 };
  service.step();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(cancellations, 1);
  assert.equal(game.players.has(player.id), false, 'inspection returning null must never thaw the source');
  confirm({ id, state: outcome });
  await service.close();
  assert.equal(game.players.has(player.id), outcome === 'cancelled');
  assert.equal(bots.length, outcome === 'cancelled' ? 1 : 0);
  if (outcome === 'cancelled') {
    assert.strictEqual(game.players.get(player.id), player, 'rollback retains the original controller actor');
    assert.equal(player.salvage, 123);
  }
});
