import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/game.js';
import { BTN, VEHICLE, capsuleClearance, airliftPose } from '@shared/index';

test('airlift charges, flies continuously without inputs, and lands at the selected pod', () => {
  const game = new Game(1337), p = game.addPlayer('Traveler', null);
  const pods = game.world.collectTransportPlan().pods;
  assert.equal(pods.length, 8);
  assert.equal(game.requestAirlift(p, pods[1].id), false);
  const source = pods[0], destination = pods[1];
  Object.assign(p.state, { px: source.x, py: source.y + .06, pz: source.z, grounded: true });
  assert.equal(game.requestAirlift(p, source.id), false);
  assert.equal(game.requestAirlift(p, 255), false);
  assert.equal(game.requestAirlift(p, destination.id), true);
  for (let i = 0; i < 179; i++) game.step();
  assert.equal(p.state.px, source.x);
  game.step();
  const flight=p.state.airlift!;assert.ok(flight);assert.equal(p.state.px,source.x);
  assert.equal(game.requestAirlift(p,pods[2].id),false,'cannot redirect a launched pod');
  for(let i=0;i<Math.floor(flight.durationTicks/2);i++)game.step();
  const middle=airliftPose(game.world.collectTransportPlan(),flight,game.tick)!;
  assert.equal(p.state.px,middle.x);assert.equal(p.state.py,middle.y);
  assert.ok(p.state.py>1000,'the journey crosses the landscape in the air');
  while(game.tick<flight.startTick+flight.durationTicks)game.step();
  assert.equal(p.state.px, destination.x); assert.equal(p.state.pz, destination.z);
  assert.ok(capsuleClearance(game.world, p.state.px, p.state.py, p.state.pz) > -.02);
  assert.equal(p.airlift, undefined);
  assert.equal(p.state.airlift,undefined);assert.equal(p.state.vy,0);
});
test('walking out, taking damage, or boarding a vehicle cancels an airlift charge', () => {
  const game = new Game(1337), p = game.addPlayer('Traveler', null), pods = game.world.collectTransportPlan().pods;
  for (const change of ['move', 'damage', 'vehicle']) {
    Object.assign(p.state, { px: pods[0].x, py: pods[0].y + .06, pz: pods[0].z, vehicle: 0 });
    assert.ok(game.requestAirlift(p, pods[1].id));
    if (change === 'move') p.state.px += 2;
    if (change === 'damage') p.health--;
    if (change === 'vehicle') p.state.vehicle = VEHICLE.JEEP;
    game.step(); assert.equal(p.airlift, undefined);
    assert.notEqual(p.state.px, pods[1].x);
  }
});
