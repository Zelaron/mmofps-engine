import { writeFileSync, mkdirSync } from 'node:fs';
import { Bot, botCampaignRole, botRoleId, botName } from '../packages/server/src/bots.js';
import { Game } from '../packages/server/src/game.js';
import { VEHICLE } from '../packages/shared/src/index.js';

// An isolated, real terrain/server simulation: no live server, accounts or
// persistence. Useful for checking that deployment produces moving armies.
const seconds=Number(process.argv.find(a=>a.startsWith('--seconds='))?.split('=')[1]??60);
const seed=Number(process.argv.find(a=>a.startsWith('--seed='))?.split('=')[1]??1337);
const output=process.argv.find(a=>a.startsWith('--output='))?.split('=')[1]??'campaign-simulation-check';
const factionOnly=Number(process.argv.find(a=>a.startsWith('--faction='))?.split('=')[1]??0);
const population=Number(process.argv.find(a=>a.startsWith('--population='))?.split('=')[1]??192);
if(!/^[a-z0-9-]+$/i.test(output)||!Number.isFinite(seconds)||seconds<1||seconds>600)throw new Error('Invalid simulation output or duration');
if(!Number.isInteger(population)||population<1||population>384)throw new Error('Invalid simulation population');
const started=performance.now();
const reservedIds=process.argv.includes('--reserved');let nextReservedId=0x1_0000_0000+17;
const game=new Game(seed,{vehicles:true,teleporters:true,wildlife:true,frontier:true,
  ...(reservedIds?{entityAllocator:{allocate:()=>nextReservedId++}}:{})});
const admitted=Array.from({length:population},(_,i)=>new Bot(game.addPlayer(botName(i),null,true),seed));
const bots=admitted.filter(bot=>!factionOnly||bot.player.faction===factionOnly);
for(const bot of admitted)if(!bots.includes(bot))game.removePlayer(bot.player.id);
const initial=bots.map(({player:p})=>({id:p.id,faction:p.faction,role:botCampaignRole(botRoleId(p)),x:p.state.px,y:p.state.py,z:p.state.pz,
  objective:game.frontier!.objective(p)?.id}));
let botMs=0,simulationMs=0,maxTickMs=0;
const checkpoints:unknown[]=[];
const checkpoint=()=>{
  const players=bots.map(({player:p},i)=>({id:p.id,faction:p.faction,role:botCampaignRole(botRoleId(p)),alive:p.state.alive,
    x:+p.state.px.toFixed(1),y:+p.state.py.toFixed(1),z:+p.state.pz.toFixed(1),vehicle:p.state.vehicle,seat:p.state.seat??0,
    traveled:+Math.hypot(p.state.px-initial[i].x,p.state.pz-initial[i].z).toFixed(1),deaths:p.deaths,
    target:game.frontier!.objective(p)?.id,speed:+Math.hypot(p.state.vx,p.state.vz).toFixed(1),
    targetDistance:+Math.hypot(p.state.px-(game.frontier!.objective(p)?.x??p.state.px),p.state.pz-(game.frontier!.objective(p)?.z??p.state.pz)).toFixed(1),intent:bots[i].intent}));
  const occupied=[...game.vehicles.values()].filter(v=>v.occupant>=0);
  const summary={seconds:game.tick/60,wallSeconds:+((performance.now()-started)/1000).toFixed(2),
    vehicles:Object.fromEntries([VEHICLE.JEEP,VEHICLE.TANK,VEHICLE.JET,VEHICLE.GUNBOAT].map(type=>[type,occupied.filter(v=>v.type===type).length])),
    crew:occupied.filter(v=>(v.gunner??-1)>=0).length,
    airborne:players.filter(p=>p.vehicle===VEHICLE.JET&&p.seat===0&&p.y>game.world.terrainHeight(p.x,p.z)+25).length,
    infantryAdvanced:players.filter((p,i)=>!['pilot','aircrew','sailor','navalcrew'].includes(p.role)&&p.traveled>100).length,
    shots:game.stats.shotsFired,deaths:players.reduce((sum,p)=>sum+p.deaths,0),creatures:game.wildlife.creatures.size,
    meanBotMs:+(botMs/Math.max(1,game.tick)).toFixed(2),meanSimulationMs:+(simulationMs/Math.max(1,game.tick)).toFixed(2),maxTickMs:+maxTickMs.toFixed(2)};
  checkpoints.push({summary,players,territories:game.frontier!.territories.map(t=>({id:t.id,owner:t.owner,progress:t.captureProgress,contested:t.contested}))});console.log(JSON.stringify(summary));
  mkdirSync('artifacts',{recursive:true});
  writeFileSync(`artifacts/${output}.json`,JSON.stringify({seed,seconds,population,reservedIds,factionOnly,initial,checkpoints},null,2));
};
checkpoint();
for(let tick=0;tick<seconds*60;tick++) {
  const before=performance.now();
  for(const bot of bots)game.queueInput(bot.player,bot.think(game));
  const afterBots=performance.now();game.step();const after=performance.now();
  botMs+=afterBots-before;simulationMs+=after-afterBots;maxTickMs=Math.max(maxTickMs,after-before);
  if(game.tick%600===0){checkpoint();await new Promise<void>(resolve=>setImmediate(resolve));}
}
if(game.tick%600!==0)checkpoint();
