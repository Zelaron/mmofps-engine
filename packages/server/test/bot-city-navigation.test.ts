import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '@shared/worldgen';
import { PLANETS } from '@shared/universe';
import { capsuleClearance } from '@shared/physics';
import { vesperDistricts } from '@shared/vesper-city';
import { campaignLayout } from '../src/campaign-layout.js';
import { campaignRoadRoute, type NavigationWorld } from '../src/bot-navigation.js';
import { Bot } from '../src/bots.js';
import { Game, ServerPlayer } from '../src/game.js';
import type { Frontier } from '../src/frontier.js';

function blockedCity(x0:number,x1:number,z0:number,z1:number):NavigationWorld {
  return {
    collectCities:()=>[{id:1,name:'Cache approach',x:0,y:0,z:0,radius:100,seed:1,theme:'aurelia'}],
    collectRoadSegments:()=>[],
    sdf:(x,y,z)=>x>x0&&x<x1&&z>z0&&z<z1&&y>0&&y<3?-1:y,
  };
}

test('city route caching rejects a nearby squad member approach across a building', () => {
  const world=blockedCity(8,16,9,13),goal={x:80,y:.06,z:0};
  const first=campaignRoadRoute(world,{x:12,y:.06,z:4},goal);
  assert.ok(first.length>=2);
  assert.strictEqual(campaignRoadRoute(world,{x:13,y:.06,z:4},goal),first,'safe nearby approaches still share the cached route');
  const other=campaignRoadRoute(world,{x:12,y:.06,z:20},goal);
  assert.ok(other.length>=3,'the second member must approach the unobstructed southern avenue');
  assert.notStrictEqual(other,first,'sharing a 32m bucket does not authorize a shortcut through the building');
  assert.deepEqual(other[0],{x:0,y:.06,z:20,street:true});
});

test('city route caching rechecks the final connector for a nearby capture destination', () => {
  const world=blockedCity(14,18,1,3),start={x:-80,y:.06,z:0};
  const first=campaignRoadRoute(world,start,{x:12,y:.06,z:4});
  assert.ok(first.length>=2);
  const shifted=campaignRoadRoute(world,start,{x:20,y:.06,z:4});
  assert.notStrictEqual(shifted,first,'two destinations in the same 16m bucket can be separated by an obstacle');
  assert.deepEqual(shifted.at(-1),{x:20,y:.06,z:0,street:true},'the revised route stays on the avenue until the clear final approach');
});

test('widened city controls connect through supported streets and bent bridges on every native planet', () => {
  for (const planet of PLANETS) {
    const world=new World(planet.seed), layout=campaignLayout(world);
    for (const city of world.collectCities()) {
      const center={x:city.x,y:city.y+.06,z:city.z};
      const controls=layout.territories.filter(site=>site.baseId===`base-city-${city.id}`);
      const pairs=[...controls.map(goal=>[center,goal] as const),[controls[0],controls[1]],[controls[0],controls[2]]] as const;
      for (const [start,goal] of pairs) {
        const route=campaignRoadRoute(world,start,goal);
        assert.ok(route.length>=2,`${planet.id} ${city.name}: ${start.x},${start.z} to ${goal.x},${goal.z} has no street route`);
        assert.ok(route.every(p=>p.street && Math.abs(p.y-center.y)<.02),'ground objectives never route onto an overhead deck or cave road');
        const path=[start,...route,goal];
        for (let leg=1;leg<path.length;leg++) {
          const a=path[leg-1],b=path[leg],steps=Math.max(1,Math.ceil(Math.hypot(b.x-a.x,b.z-a.z)/16));
          for (let step=0;step<=steps;step++) {
            const t=step/steps,x=a.x+(b.x-a.x)*t,y=a.y+(b.y-a.y)*t,z=a.z+(b.z-a.z)*t;
            assert.ok(world.sdf(x,y-.12,z)<=0,`${planet.id} ${city.name}: route crosses unsupported ground at ${x},${z}`);
            assert.ok(capsuleClearance(world,x,y+.02,z)>=-.02,`${planet.id} ${city.name}: route cuts through a building at ${x},${z}`);
            assert.equal(world.liquidAt(x,y,z),undefined,'a city approach never cuts through water or lava');
          }
        }
        if(city.theme==='vesper')assert.ok(route.length>=3,'separate Vesper districts require physical bridge bends');
      }
    }
  }
});

test('city routing retains a bridge corner even on a leg below the rural 180m road threshold', () => {
  const world=new World(1337),city=world.collectCities().find(city=>city.theme==='vesper')!,district=vesperDistricts(city)[1];
  const start={x:district.x+80,y:city.y+.06,z:city.z},goal={x:district.x,y:city.y+.06,z:city.z-100};
  assert.ok(Math.hypot(start.x-goal.x,start.z-goal.z)<180);
  const route=campaignRoadRoute(world,start,goal);
  assert.ok(route.some(point=>Math.abs(point.x-district.x)<.01&&Math.abs(point.z-city.z)<.01),'short routes must still visit the supported right-angle bend');
  assert.ok(route.length>=3);
});

test('an infantry bot follows a real Vesper bridge bend and reaches the distant deck without falling', () => {
  const game=new Game(1337),city=game.world.collectCities().find(city=>city.theme==='vesper')!,district=vesperDistricts(city)[1];
  const floor=city.y+.06,start={x:district.x+80,y:floor,z:city.z},goal={id:'bridge-turn',name:'West district',radius:12,owner:0,
    x:district.x,y:floor,z:city.z-100};
  // Retain native collision/support and ordinary bot+movement code while
  // isolating this foot approach from transport pickups and unrelated combat.
  game.pickups.clear();game.vehicles.clear();game.wildlife.creatures.clear();
  const transport=game.world.collectTransportPlan();game.world.collectTransportPlan=()=>({...transport,pods:[]});
  Object.defineProperty(game,'frontier',{value:{territories:[goal],objective:()=>goal,order:()=>({targetId:goal.id,phase:'attack'}),recordCombat(){},step(){},send(){}} as unknown as Frontier});
  const player=new ServerPlayer(19,'Bridge squad',null,true,start);player.faction=1;player.state.grounded=true;
  game.players.set(player.id,player);const bot=new Bot(player,1337);
  let visitedTurn=false,reached=false;
  for(let tick=0;tick<2400;tick++) {
    game.queueInput(player,bot.think(game));game.step();
    const s=player.state;
    assert.ok(s.alive && s.py>floor-1,'the route must keep the soldier on the bridge deck');
    visitedTurn ||= Math.hypot(s.px-district.x,s.pz-city.z)<9;
    if(Math.hypot(s.px-goal.x,s.pz-goal.z)<goal.radius){reached=true;break;}
  }
  assert.ok(visitedTurn,'movement reaches the bridge corner before turning');
  assert.ok(reached,'the squad arrives inside the objective radius through ordinary movement');
});
