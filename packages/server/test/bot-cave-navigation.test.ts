import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '@shared/worldgen';
import { cavePathPoint } from '@shared/caves';
import type { CampaignBase, Territory } from '@shared/frontier';
import { Bot } from '../src/bots.js';
import { campaignCaveExitRoute } from '../src/bot-navigation.js';
import { CampaignDirector } from '../src/campaign-director.js';
import { Game, ServerPlayer } from '../src/game.js';
import type { Frontier } from '../src/frontier.js';

const starts = [
  {x:-1775.007098909258,y:62.41174739258114,z:3708.6831533195677},
  {x:-1766.014893601519,y:61.23832961904847,z:3705.3221573125275},
  {x:-1777.2418593020668,y:62.83047869455679,z:3708.226224365224},
  {x:-1767.25,y:61.18,z:3705.79},
];
const destination = {id:'surface-march',name:'Distant surface objective',x:200,y:80,z:9500,radius:3,owner:0};

test('cave recovery follows the physical gallery and leaves surface or underground destinations alone',()=>{
  const world=new World(1337),start=starts[0],column=world.sampleColumn(start.x,start.z),site=column.cave!.site;
  assert.ok(column.h-start.y>30,'the captured walkers are below the hillside, not on its surface');
  const route=campaignCaveExitRoute(world,start,destination);
  assert.ok(route.length>=6);
  assert.deepEqual(route.at(-1),cavePathPoint(site,-28),'escape continues outside the mouth before surface replanning');
  assert.ok(route.every(p=>world.sdf(p.x,p.y+1,p.z)>0),'the gallery points lie in walkable air');
  assert.deepEqual(campaignCaveExitRoute(world,{...start,y:column.h+.01},destination),[],'a surface walker must not be sent underground');
  assert.deepEqual(campaignCaveExitRoute(world,start,cavePathPoint(site,site.length)),[],'an objective inside this cave retains its route');
});

test('reassessed second-squad orders let four cave walkers recover through ordinary movement',()=>{
  const game=new Game(1337);
  game.pickups.clear();game.vehicles.clear();game.wildlife.creatures.clear();
  const transport=game.world.collectTransportPlan();game.world.collectTransportPlan=()=>({...transport,pods:[]});
  const players=starts.map((start,i)=>{
    const p=new ServerPlayer(19+i*3,`Cave marcher ${i}`,null,true,start);p.faction=3;p.state.grounded=true;
    p.botRosterIndex=[164,173,176,179][i];
    game.players.set(p.id,p);return p;
  });
  const targets:Territory[]=[0,1].map(i=>({...destination,id:`surface-${i}`,baseId:'surface-city',
    x:destination.x+i*180,owner:0,kind:'city',influence:0,contested:false}));
  const home:Territory={id:'home-control',name:'Home',baseId:'home',x:0,y:80,z:0,radius:3,owner:3,
    kind:'relay',influence:1,contested:false};
  const bases:CampaignBase[]=[
    {id:'home',name:'Home',kind:'outpost',x:0,y:80,z:0,owner:3,homeFaction:3,requiredPoints:1,controlIds:[home.id]},
    {id:'surface-city',name:'Surface city',kind:'city',x:destination.x,y:80,z:destination.z,owner:0,
      homeFaction:0,requiredPoints:2,controlIds:targets.map(target=>target.id)},
  ];
  // Strategic actors are outside the movement fixture. Four allied squads
  // and seven distant defenders give this city two ordinary assault slots.
  const strategic=Array.from({length:10},(_,i)=>{
    const p=new ServerPlayer(1000+i,`Strategic actor ${i}`,null,true,
      i===1||i===2?{x:-10000,y:80,z:-10000}:{x:destination.x,y:80,z:destination.z+600});
    p.faction=i<3?3:1;p.botRosterIndex=i<3?[0,180,198][i]:300+i*3;return p;
  });
  const roster=[...players,...strategic],director=new CampaignDirector(bases,[home,...targets]);
  director.update(roster,0);game.tick=720;
  Object.defineProperty(game,'frontier',{value:{territories:[home,...targets],
    order:(player:ServerPlayer)=>director.order(player,()=>roster,game.tick),recordCombat(){},step(){},send(){}} as unknown as Frontier});
  const initial=director.order(players[0],()=>roster,game.tick)!;
  // Both assault squads mass on one control before a second is opened.
  assert.ok(targets.some(target=>target.id===initial.targetId),'the captured cave squad joins the city assault');
  assert.equal(director.order(strategic[0],()=>roster,game.tick)!.targetId,initial.targetId);
  const bots=players.map(p=>new Bot(p,1337)),left=new Set<number>(),recovered=new Set<number>();
  for(let tick=0;tick<2100&&left.size<players.length;tick++) {
    director.update(roster,game.tick);
    for(const bot of bots){
      assert.equal(director.order(bot.player,()=>roster,game.tick)!.targetId,initial.targetId,
        'the 120-tick reassessment must leave enough stable time for the 180-tick recovery');
      game.queueInput(bot.player,bot.think(game));
      if((bot as unknown as {walkEscape:unknown}).walkEscape)recovered.add(bot.player.id);
    }
    game.step();
    for(const p of players) {
      assert.ok(p.state.alive,'recovery must walk the supported gallery without killing or teleporting the soldier');
      if(p.state.px<-1852 && p.state.py>70)left.add(p.id);
    }
  }
  assert.equal(recovered.size,4,'all four brains enter sustained cave recovery under real director orders');
  assert.equal(left.size,4,'all four marching soldiers escape the chamber instead of circling its wall indefinitely');
});

test('changing a travel destination cancels a retained cave escape immediately',()=>{
  const game=new Game(1337),p=new ServerPlayer(19,'Changed order',null,true,starts[0]),bot=new Bot(p,1337);
  p.faction=3;p.state.grounded=true;
  bot.setTravelWaypoint({...destination,y:80});
  const course=bot as unknown as {campaignCourse(game:Game,goal:typeof destination):void;walkEscape:unknown};
  for(let tick=0;tick<=192;tick+=12) {
    game.tick=tick;
    // Six metres of apparent movement defeats the old 0.6m stuck check,
    // but never improves the best distance to the same surface target.
    p.state.px=starts[0].x+(tick%24===0?0:-6);
    course.campaignCourse(game,destination);
  }
  assert.ok(course.walkEscape,'sustained route nonprogress starts a persistent physical escape');
  bot.setTravelWaypoint(null);
  assert.equal(course.walkEscape,undefined,'a canceled expedition cannot keep an old escape destination');
});
