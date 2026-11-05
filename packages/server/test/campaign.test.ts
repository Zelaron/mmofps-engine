import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, type ServerPlayer, type ServerVehicle } from '../src/game.js';
import { CAPTURE_SECONDS, type Faction, type Territory } from '@shared/frontier';
import { PLAYER, TICK_RATE } from '@shared/constants';
import { capsuleClearance } from '@shared/physics';
import { PLANETS } from '@shared/universe';
import { VEHICLE, vehicleDefinition } from '@shared/vehicles';
import { decodeFrontierState } from '@shared/frontier-wire';
import { Msg } from '@shared/protocol';
import { createMoveState } from '@shared/movement';

function hold(game: Game, player: ServerPlayer, site: Territory, seconds = CAPTURE_SECONDS + .01): void {
  Object.assign(player.state, { px: site.x, py: site.y, pz: site.z, alive: true, vehicle: 0 });
  game.frontier!.step([player], game.tick, seconds);
}
function kill(game: Game, player: ServerPlayer): void {
  (game as unknown as { kill(p: ServerPlayer, a: ServerPlayer, w: number): void }).kill(player, player, 255);
}
function respawn(game: Game, player: ServerPlayer): void {
  game.tick = player.respawnAtTick;
  (game as unknown as { updateRespawnsAndRegen(): void }).updateRespawnsAndRegen();
}

test('each planet has dry control networks, three separated faction staging bases and coastal footholds', () => {
  for (const planet of PLANETS) {
    const game = new Game(planet.seed, { frontier: true }), frontier = game.frontier!;
    assert.equal(frontier.bases.length, 12);
    for (const faction of [1, 2, 3] as const) {
      assert.ok(frontier.bases.some(b => b.kind === 'harbor' && b.owner === faction));
      const base = frontier.bases.find(b => b.id === `base-forward-${faction}`)!;
      const player = game.addPlayer(`Scout ${faction}`, null); player.faction = faction;
      // Fresh arrivals join the most active front; choosing the forward base
      // as the next respawn still deploys at that staging base.
      kill(game, player); assert.equal(game.requestRespawn(player, base.id), true); respawn(game, player);
      assert.ok(Math.hypot(player.state.px - base.x, player.state.pz - base.z) <= 65, `${planet.id}: friendly staging arrival`);
      assert.equal(game.world.liquidAt(player.state.px, player.state.py, player.state.pz), undefined);
      assert.ok(capsuleClearance(game.world, player.state.px, player.state.py, player.state.pz) >= -.02);
      for (const other of frontier.bases.filter(b => b.id.startsWith('base-forward-') && b.owner !== faction)) {
        assert.ok(Math.hypot(player.state.px - other.x, player.state.pz - other.z) > 600, 'opposing spawn areas are separate');
      }
    }
    for (const site of frontier.territories) {
      assert.equal(game.world.liquidAt(site.x, site.y, site.z), undefined, site.id);
      assert.ok(capsuleClearance(game.world, site.x, site.y, site.z) >= -.02, site.id);
      assert.ok(game.world.sdf(site.x, site.y - .12, site.z) <= 0, site.id);
      if (site.kind === 'city') {
        const city = game.world.collectCities().find(c => site.baseId === `base-city-${c.id}`)!;
        assert.ok(Math.abs(site.y - city.y) < .2, 'flags stay on the pedestrian street, below overhead towers');
        // Suspended districts connect through bent bridge approaches; other
        // cities retain their broad cardinal avenues at pedestrian height.
        const bend = city.theme === 'vesper' ? site.x > city.x
          ? { x: city.x, z: site.z } : { x: site.x, z: city.z } : undefined;
        const path = [{ x: city.x, z: city.z }, ...(bend ? [bend] : []), site];
        for (let leg = 1; leg < path.length; leg++) for (let step = 0; step <= 64; step++) {
          const a = path[leg - 1], b = path[leg], x = a.x + (b.x - a.x) * step / 64, z = a.z + (b.z - a.z) * step / 64;
          assert.ok(capsuleClearance(game.world, x, site.y + .02, z) >= -.02, `${planet.id} ${site.id}: street approach ${leg}/${step}`);
          assert.ok(game.world.sdf(x, site.y - .12, z) <= 0, `${planet.id} ${site.id}: unsupported approach`);
        }
      }
    }
  }
});

test('two of three surrounding controls secure a city for each faction and persist its claim', () => {
  for (const faction of [1, 2, 3] as const) {
    const game = new Game(1337, { frontier: true }), f = game.frontier!, p = game.addPlayer('Captor', null);
    p.faction = faction;
    // A city that starts neutral (the factions' home cities start owned).
    const base = f.bases.find(b => b.kind === 'city' && b.owner === 0)!, sites = f.territories.filter(t => t.baseId === base.id);
    hold(game, p, sites[0]); assert.equal(base.owner, 0);
    assert.ok(!f.spawnOptions(p).some(o => o.id === base.id));
    hold(game, p, sites[1]); assert.equal(base.owner, faction);
    assert.ok(f.spawnOptions(p).some(o => o.id === base.id));
    const restored = new Game(1337, { frontier: true }); restored.frontier!.restore(f.save());
    assert.equal(restored.frontier!.bases.find(b => b.id === base.id)!.owner, faction);
    assert.equal(restored.frontier!.territories.find(t => t.id === sites[0].id)!.captureFaction, faction);
  }
});

test('third-faction pressure neutralizes enemy strength and any mixed faction presence contests', () => {
  const game = new Game(1337, { frontier: true }), f = game.frontier!, site = f.territories[0];
  const players = [1, 2, 3].map(faction => { const p = game.addPlayer(`Faction ${faction}`, null); p.faction = faction as Faction; return p; });
  hold(game, players[0], site);
  hold(game, players[2], site, CAPTURE_SECONDS / 2);
  assert.equal(site.owner, 1); assert.equal(site.captureFaction, 1); assert.ok(Math.abs(site.captureProgress! - .5) < 1e-8);
  assert.equal(site.pressureFaction, 3); assert.ok(site.progressRate! < 0);
  for (const p of players) Object.assign(p.state, { px: site.x, py: site.y, pz: site.z });
  f.step(players, 0, 100); assert.equal(site.contested, true); assert.equal(site.captureProgress, .5);
  hold(game, players[2], site, CAPTURE_SECONDS / 2);
  assert.equal(site.owner, 0); assert.equal(site.captureProgress, 0);
  hold(game, players[2], site); assert.equal(site.owner, 3); assert.equal(site.captureFaction, 3);
});

test('death immediately sends a ten-second selection window; selection persists and lost bases fall back', () => {
  const packets: Uint8Array[] = [], game = new Game(1337, { frontier: true });
  const p = game.addPlayer('Player', { send: bytes => packets.push(bytes) }); p.faction = 3;
  const base = game.frontier!.bases.find(b => b.owner === 3 && b.kind === 'harbor')!;
  const before = { ...p.state };
  assert.equal(game.requestRespawn(p, base.id), true, 'living players can remember their next reinforcement base');
  assert.deepEqual(p.state, before, 'changing a respawn preference does not teleport or otherwise change the living actor');
  packets.length = 0;
  kill(game, p);
  assert.equal(p.respawnAtTick - game.tick, 10 * TICK_RATE);
  const packet = packets.find(b => b[0] === Msg.SFrontier)!;
  assert.equal(decodeFrontierState(packet.buffer as ArrayBuffer).respawn?.remaining, PLAYER.RESPAWN_SECONDS);
  assert.equal(game.requestRespawn(p, 'base-city-1'), false, 'unclaimed base is not a spawn');
  assert.equal(game.requestRespawn(p, base.id), true);
  respawn(game, p); assert.ok(p.state.alive); assert.equal(p.preferredSpawnId, base.id);
  assert.ok(Math.hypot(p.state.px - base.x, p.state.pz - base.z) <= 600, 'deploys at the chosen harbor');
  kill(game, p);
  for (const site of game.frontier!.territories.filter(t => t.baseId === base.id)) {
    site.owner = 1; site.captureFaction = 1; site.captureProgress = 1; site.influence = -1;
  }
  game.frontier!.step([], game.tick, .2); respawn(game, p);
  assert.ok(Math.hypot(p.state.px - base.x, p.state.pz - base.z) > 500, 'lost preference is revalidated at actual respawn');
});

test('stationary friendly rally jeeps unlock safe mobile spawns; moving, threatened or destroyed hulls do not', () => {
  const game = new Game(1337, { frontier: true }), p = game.addPlayer('Passenger', null); p.faction = 3;
  const site = game.frontier!.bases[0], v: ServerVehicle = { id: 123456, type: VEHICLE.JEEP, x: site.x, y: site.y, z: site.z, heading: 0,
    health: vehicleDefinition(VEHICLE.JEEP)!.maxHealth, occupant: -1, respawnAtTick: -1, campaignFaction: 3 as Faction };
  game.vehicles.set(v.id, v);
  const mobileId = `mobile-${v.id}`;
  assert.ok(game.frontier!.spawnOptions(p).some(o => o.id === mobileId));
  v.motionState = createMoveState(v.x, v.y, v.z); v.motionState.vx = 4;
  assert.ok(!game.frontier!.spawnOptions(p).some(o => o.id === mobileId));
  v.motionState.vx = 0;
  kill(game, p); assert.equal(game.requestRespawn(p, mobileId), true);
  v.health = 0; v.respawnAtTick = game.tick + 1000;
  assert.ok(!game.frontier!.spawnOptions(p).some(o => o.id === mobileId));
  respawn(game, p); assert.ok(Math.hypot(p.state.px - site.x, p.state.pz - site.z) > 500);
  v.health = vehicleDefinition(VEHICLE.JEEP)!.maxHealth; v.respawnAtTick = -1;
  const enemy = game.addPlayer('Enemy', null); enemy.faction = 2;
  Object.assign(enemy.state, { px: v.x + 20, py: v.y, pz: v.z });
  assert.ok(!game.frontier!.spawnOptions(p).some(o => o.id === mobileId));
});

test('a faction losing every base retains a coastal comeback point, and squad orders ignore creatures', () => {
  const game = new Game(1337, { frontier: true }), f = game.frontier!, p = game.addPlayer('Last soldier', null); p.faction = 3;
  for (const site of f.territories) { site.owner = 2; site.influence = 1; site.captureFaction = 2; site.captureProgress = 1; }
  f.step([], 0, .2);
  const options = f.spawnOptions(p); assert.equal(options.length, 1); assert.equal(options[0].id, 'reserve-3');
  kill(game, p); respawn(game, p);
  assert.ok(Math.hypot(p.state.px - options[0].x, p.state.pz - options[0].z) < 65);
  const bots = [7, 10, 13, 16].map(id => game.addPlayer(`Squad ${id}`, null, true, id));
  for (const bot of bots) bot.faction = 3;
  assert.equal(new Set(bots.map(bot => f.order(bot)?.targetId)).size, 1);
  assert.ok(f.territories.some(t => t.id === f.order(p)?.targetId));
});

test('defense reserves reinforce the exact control being neutralized before its ownership changes', () => {
  const game = new Game(1337, { frontier: true }), f = game.frontier!;
  const defender = game.addPlayer('Reserve', null, true, 37); defender.faction = 1; defender.botRosterIndex = 36;
  const enemy = game.addPlayer('Raider', null); enemy.faction = 3;
  const attacked = f.territories.find(t => t.id === 'forward-1-2')!;
  hold(game, enemy, attacked, 1);
  assert.equal(attacked.owner, 1); assert.equal(attacked.contested, false);
  assert.equal(f.order(defender)?.phase, 'defend'); assert.equal(f.order(defender)?.targetId, attacked.id);
});

test('worlds saved before front-line wars start the first war on the new layout', () => {
  const game = new Game(1337, { frontier: true }), f = game.frontier!;
  const fresh = new Game(1337, { frontier: true }).frontier!;
  f.restore({ version: 1, seed: 1337, territories: [
    { id: 'city-2-0', owner: 1, influence: -1 }, { id: 'harbor-1', owner: 1, influence: -1 },
  ] });
  assert.equal(f.war.number, 1);
  for (const base of f.bases) assert.equal(base.owner, fresh.bases.find(b => b.id === base.id)!.owner, base.id);
});
