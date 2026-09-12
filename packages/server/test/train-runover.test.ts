import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, ServerPlayer } from '../src/game.js';
import { transportField } from '../../shared/test/transport-fixture.js';
import { transportPose } from '@shared/transport';
import { transitWorld, transitLocal } from '@shared/transit-motion';

test('the server damages one train runover once while the shared rebound clears the victim from the tracks', () => {
  const game = new Game(1337), { route } = transportField(game.world), seconds = 30;
  const pose = transportPose(route,seconds), p = transitWorld(pose,0,-1.194,-16.5);
  const player = new ServerPlayer(41,'Track pedestrian',null,false,p);
  player.state.grounded = true; player.state.simulationTick = seconds*60;
  game.tick = seconds*60; game.players.set(player.id,player);
  let injuryTicks = 0, previousHealth = player.health;
  for (let i=0; i<90; i++) {
    game.queueInput(player,{seq:i+1,buttons:0,weapon:0,yaw:0,pitch:0,renderTick:0,renderFrac:0});
    game.step();
    if (player.health<previousHealth) injuryTicks++;
    previousHealth = player.health;
  }
  assert.equal(injuryTicks,1,'multiple contacts during the rebound must not multiply the initial injury');
  assert.ok(player.health>0 && player.health<=10,`full-speed train injury: ${player.health}`);
  assert.equal(player.state.alive,true);
  const local = transitLocal(transportPose(route,game.tick/60),player.state.px,player.state.py,player.state.pz);
  assert.ok(Math.abs(local.x)>5.5);
});

test('the server never applies train runover damage to a carried passenger', () => {
  const game = new Game(1337), { route } = transportField(game.world), seconds = 30;
  const pose = transportPose(route,seconds,route.carOffsets[2]), p = transitWorld(pose,0,1.206,0);
  const player = new ServerPlayer(41,'Passenger',null,false,p);
  player.state.grounded = true; player.state.simulationTick = seconds*60;
  game.tick = seconds*60; game.players.set(player.id,player);
  for (let i=0; i<150; i++) {
    game.queueInput(player,{seq:i+1,buttons:0,weapon:0,yaw:0,pitch:0,renderTick:0,renderFrac:0});
    game.step();
  }
  assert.equal(player.health,100);
  assert.equal(player.transitDamageUntil,-1);
});
