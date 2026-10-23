import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TICK_RATE } from '@shared/constants';
import { ORBITAL_CHARGE_SECONDS, planetById, type PlanetId } from '@shared/universe';
import { ByteReader, Msg } from '@shared/protocol';
import { Bot } from '../src/bots.js';
import { Coordinator } from '../src/coordinator.js';
import { startControlPlane } from '../src/control-plane.js';
import { ControlClient } from '../src/control-client.js';
import { EntityPool } from '../src/entity-pool.js';
import { Game } from '../src/game.js';
import { OrbitalCampaign } from '../src/orbital-campaign.js';
import type { RuntimeHandoff } from '../src/runtime-handoff.js';

test('a real squad walks to a generated pod, charges, crosses worlds once and keeps its identity after a lost commit reply', async () => {
  // Fixed coordinator time lets an accelerated physics simulation exercise
  // real authenticated HTTP calls without expiring its authority leases.
  const coordinator = new Coordinator(':memory:', () => 10_000), secret = 'orbital-integration-secret-123456789';
  const control = await startControlPlane(coordinator, secret), client = new ControlClient(`http://127.0.0.1:${control.port}`, secret);
  const pools: EntityPool[] = [], services: OrbitalCampaign[] = [];
  try {
    const world = async (planet: PlanetId) => {
      const id = `orbital-fixture-${planet}`, pool = await EntityPool.bootstrap(client, { node: id, planet, region: 'world' });
      pools.push(pool);
      const game = new Game(planetById(planet)!.seed, { frontier: true, entityAllocator: pool });
      const grant = coordinator.register({ id, planet, url: 'ws://localhost:12000/ws', capacity: 64, humans: 0, tick: 0 });
      pool.bind(grant.epoch);
      return { game, authority: { id, epoch: grant.epoch }, bots: [] as Bot[] };
    };
    const source = await world('meridian'), destination = await world('cinder');
    const pod = source.game.world.collectTransportPlan().pods.find(p => p.id === 1)!;
    const home = source.game.frontier!.bases.find(b => b.id === 'base-forward-1')!;
    for (let i = 0; i < 12; i++) {
      const player = source.game.addPlayer(`Expedition soldier ${i}`, null, true);
      player.faction = 1; player.botRosterIndex = i < 6 ? 18 + i * 3 : 72 + (i - 6) * 3;
      player.salvage = 17 + i; player.ammo[1].magazine = 13; player.ammo[1].reserve = 77;
      Object.assign(player.state, i < 6 ? { px: pod.x, py: pod.y, pz: pod.z + 45 + i * 1.4, grounded: true }
        : { px: home.x + i * 2, py: home.y, pz: home.z, grounded: true });
      source.bots.push(new Bot(player, source.game.seed));
    }
    const messages: string[] = [];
    const observer = source.game.addPlayer('Campaign observer', { send: bytes => {
      if (bytes[0] === Msg.SMessage) { const reader = new ByteReader(bytes); reader.u8(); messages.push(reader.str()); }
    } });
    observer.faction = 1; Object.assign(observer.state, { px: home.x, py: home.y, pz: home.z });
    const target = destination.game.frontier!.bases.find(b => b.id === 'base-city-2')!;
    const controls = destination.game.frontier!.territories.filter(t => t.baseId === target.id);
    for (const site of controls) Object.assign(site, { owner: 1, captureFaction: 1, captureProgress: 1, influence: -1 });
    destination.game.frontier!.step([], 0, 0);
    const raider = destination.game.addPlayer('Remote raider', null); raider.faction = 2;
    Object.assign(raider.state, { px: controls[2].x, py: controls[2].y, pz: controls[2].z });

    let dropped = false, inspectCalls = 0;
    const submittedCargo = new Map<number, RuntimeHandoff['players'][number]>();
    const sourceService = new OrbitalCampaign(source.game, source.bots, { planet: 'meridian', authority: () => source.authority,
      ready: () => true, populationLimit: () => 192, call: async <T>(method: string, body: unknown): Promise<T> => {
        if (method === 'campaign/transfer') inspectCalls++;
        if (method === 'campaign/depart') for (const player of (body as { payload: RuntimeHandoff }).payload.players)
          submittedCargo.set(player.id, structuredClone(player));
        const reply = await client.call<T>(method, body);
        if (method === 'campaign/depart' && !dropped) { dropped = true; throw new Error('Simulated lost committed departure response'); }
        return reply;
      } });
    const destinationService = new OrbitalCampaign(destination.game, destination.bots, { planet: 'cinder', authority: () => destination.authority,
      ready: () => true, populationLimit: () => 192, call: <T>(method: string, body: unknown) => client.call<T>(method, body) });
    services.push(sourceService, destinationService);
    destination.game.frontier!.step(destination.game.players.values(), 1, .2);
    await destinationService.sync(); await sourceService.sync();
    assert.ok(messages.some(text => text.includes(target.name) && text.includes('Cinder') && text.includes('Helix Combine')),
      'pressure on another world reaches players as a named, faction-specific alert');

    source.game.tick = 20 * TICK_RATE;
    sourceService.step();
    const chosen = [...sourceService.status.members];
    assert.ok(chosen.length >= 3 && chosen.length <= 6, 'the strategic report launches one bounded expedition');
    assert.equal(sourceService.status.destination, 'cinder');
    assert.ok(messages.some(text => text.includes(`expedition to ${target.name} on Cinder`)),
      'the strategic director selects the reported remote attack rather than an arbitrary destination');
    const cargo = new Map(chosen.map(id => {
      const player = source.game.players.get(id)!;
      assert.ok(Math.hypot(player.state.px - pod.x, player.state.pz - pod.z) > 30, 'the squad begins outside the pod');
      return [id, { name: player.name, faction: player.faction, salvage: player.salvage, ammo: structuredClone(player.ammo) }];
    }));
    const departedAtStart = chosen.some(id => !source.game.players.has(id));
    assert.equal(departedAtStart, false, 'an order cannot instantly move soldiers between worlds');
    let chargingAt = -1, departedAt = -1, moved = false;
    for (let tick = 0; tick < 35 * TICK_RATE; tick++) {
      sourceService.step();
      if (sourceService.status.phase === 'charging' && chargingAt < 0) chargingAt = source.game.tick;
      for (const bot of [...source.bots]) {
        if (!source.game.players.has(bot.player.id)) continue;
        source.game.queueInput(bot.player, sourceService.command(bot, bot.think(source.game)));
      }
      source.game.step();
      moved ||= chosen.some(id => {
        const p = source.game.players.get(id);
        return p && Math.hypot(p.state.px - pod.x, p.state.pz - pod.z) < 15;
      });
      if (chosen.every(id => !source.game.players.has(id))) { departedAt = source.game.tick; break; }
      if (tick % 30 === 0) await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.ok(moved, 'ordinary bot movement approaches the actual generated transit pod');
    assert.ok(chargingAt >= 0, 'the expedition starts the normal orbital charging phase');
    assert.ok(departedAt - chargingAt >= ORBITAL_CHARGE_SECONDS * TICK_RATE, 'the complete charging interval elapses before detachment');
    await sourceService.sync();
    for (let attempt = 0; attempt < 20 && !chosen.every(id => destination.game.players.has(id)); attempt++) {
      await new Promise<void>(resolve => setImmediate(resolve));
      await destinationService.sync(); await sourceService.sync();
      destinationService.step(); sourceService.step();
    }
    assert.equal(dropped, true); assert.ok(inspectCalls > 0, 'an ambiguous commit is resolved by inspecting durable ownership');
    assert.ok(chosen.every(id => !source.game.players.has(id) && destination.game.players.has(id)), 'every chosen identity has exactly one simulation owner');
    for (const id of chosen) {
      const player = destination.game.players.get(id)!, before = cargo.get(id)!;
      assert.equal(player.name, before.name); assert.equal(player.faction, before.faction); assert.equal(player.salvage, before.salvage);
      assert.deepEqual(player.ammo, submittedCargo.get(id)!.ammo, 'orbital transport retains the inventory actually loaded at departure');
      const controller = destination.bots.find(bot => bot.player.id === id)!;
      controller.think(destination.game);
      assert.ok(Math.hypot(controller.intent.x - target.x, controller.intent.z - target.z) < 1600,
        'the arriving squad receives a route toward its selected remote front');
      assert.equal(destination.bots.filter(bot => bot.player.id === id).length, 1);
    }
    await destinationService.sync(); destinationService.step(); await destinationService.sync(); destinationService.step();
    assert.equal(destination.bots.filter(bot => chosen.includes(bot.player.id)).length, chosen.length, 'arrival replay and acknowledgement never create duplicate controllers');
  } finally {
    for (const service of services) await service.close();
    for (const pool of pools) await pool.close();
    await control.close(); coordinator.close();
  }
});
