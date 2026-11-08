import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VEHICLE } from '@shared/index';
import { Game, type ServerPlayer, type ServerVehicle } from '../src/game.js';

// A hull its crew leaves in flight must not hang in the sky as a parked
// vehicle (with its beacon), whatever took the pilot out of the seat.

interface Internals {
  spawnVehicleAt(site: { type: number; x: number; y?: number; z: number; heading: number }): ServerVehicle;
  kill(victim: ServerPlayer, attacker: ServerPlayer, weapon: number): void;
  redeployForWar(): void;
}

function airborneJet(game: Game, name: string): { pilot: ServerPlayer; jet: ServerVehicle } {
  const pilot = game.addPlayer(name, null), internals = game as unknown as Internals;
  const y = game.world.groundY(pilot.state.px, pilot.state.pz) + 300;
  const jet = internals.spawnVehicleAt({ type: VEHICLE.JET, x: pilot.state.px, y, z: pilot.state.pz, heading: 0 });
  jet.occupant = pilot.id; pilot.vehicleId = jet.id;
  Object.assign(pilot.state, { vehicle: VEHICLE.JET, vehicleVariant: 0, seat: 0, vehicleId: jet.id, py: jet.y, grounded: false });
  return { pilot, jet };
}

test('a jet whose pilot dies in flight crashes instead of hanging in the sky', () => {
  const game = new Game(4407, { vehicles: true });
  const { pilot, jet } = airborneJet(game, 'Pilot');
  (game as unknown as Internals).kill(pilot, pilot, 255);
  assert.equal(pilot.state.alive, false);
  assert.equal(jet.occupant, -1);
  assert.ok(jet.health <= 0, 'the abandoned jet is wrecked, not parked mid-air');
  assert.equal(pilot.deaths, 1, 'its crash does not kill the pilot a second time');
});

test('a new war does not leave crewed jets parked in mid-air', () => {
  const game = new Game(4408, { vehicles: true, frontier: true });
  const { jet } = airborneJet(game, 'Wing');
  assert.ok(!jet.campaignHome, 'a hull that does not return home at a war reset');
  (game as unknown as Internals).redeployForWar();
  assert.ok(!game.vehicles.has(jet.id) || jet.health <= 0, 'the jet left in flight is wrecked');
});
