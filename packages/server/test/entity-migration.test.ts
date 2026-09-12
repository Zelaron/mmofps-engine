import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Coordinator, OwnershipError } from '../src/coordinator.js';
import { EntityPool } from '../src/entity-pool.js';
import { Game, type ServerPlayer, type ServerVehicle } from '../src/game.js';
import { capturePlayer } from '../src/persistence.js';
import type { RuntimeHandoff } from '../src/runtime-handoff.js';
import type { RegionalHandoffRequest } from '../src/region-transfers.js';
import { VEHICLE } from '@shared/vehicles';
import { ByteReader, decodeSnapshot } from '@shared/protocol';
import { DYNAMIC_ENTITY_BASE } from '@shared/entity-id';

interface Internal {
  pickSpawn(): { x: number; y: number; z: number };
  spawnVehicleAt(site: { type: number; x: number; y: number; z: number; heading: number }): ServerVehicle;
  dropCarpetBombs(player: ServerPlayer): void;
  buildSnapshotFor(player: ServerPlayer): Uint8Array;
}
const internal = (game: Game) => game as unknown as Internal;

test('a crew and its projectiles retain their IDs across migration, source restart, local spawning and a return trip', async () => {
  const c = new Coordinator(':memory:', () => 10_000), pools: EntityPool[] = [];
  c.configureRegions('meridian', { version: 2, xCuts: [0], zCuts: [], entry: { x: -1, z: 0 } });
  const boot = (id: string, region: string) => {
    const grant = c.reserveEntities({ node: id, planet: 'meridian', region, request: randomUUID(), count: 8 });
    const pool = new EntityPool(grant, async request => c.reserveEntities(request)); pools.push(pool);
    const token = { id, epoch: c.register({ id, planet: 'meridian', region, url: 'ws://127.0.0.1:1000/ws', capacity: 8, humans: 0, tick: 0 }).epoch };
    pool.bind(token.epoch);
    const game = new Game(1337, { entityAllocator: pool });
    internal(game).pickSpawn = () => ({ x: -1, y: 600, z: 0 }); game.world.groundY = () => 600;
    return { token, game, pool };
  };
  const hull = (game: Game, x = 1) => internal(game).spawnVehicleAt({ type: VEHICLE.JET, x, y: 600, z: 0, heading: .4 });
  const members = (record: RuntimeHandoff) => record.players.map(p => {
    const owner = c.locate(String(p.id).repeat(64))!;
    return { key: owner.key, entityId: owner.entityId, epoch: owner.epoch, holder: owner.holder! };
  });
  const commit = (request: RegionalHandoffRequest, destination: Game) => {
    const staged = c.prepareRegional(request);
    c.readyRegional(request.id, request.destination, staged.hash, destination.tick);
    assert.equal(c.commitRegional(request.id, request.source, staged.hash).status, 'committed');
    const record = c.regionalPayload(request.id, request.destination);
    return destination.acceptHandoff(record, new Map(record.players.map(p => [p.id, null])));
  };
  try {
    const west = boot('west-first', 'r0:0'), east = boot('east-first', 'r1:0');
    const crew = [1, 2].map(n => {
      const key = String(n).repeat(64), holder = `west-first:player-${n}`;
      const lease = c.claim(key, 'meridian', holder, west.token.id);
      const player = west.game.addPlayer(`Explorer-${n}`, null, false, lease.entityId);
      c.checkpoint([{ key, holder, epoch: lease.epoch, state: capturePlayer(west.game, player) }]);
      return player;
    });
    const aircraft = hull(west.game); aircraft.occupant = crew[0].id; aircraft.gunner = crew[1].id;
    for (let seat = 0; seat < crew.length; seat++) {
      const p = crew[seat]; p.vehicleId = aircraft.id;
      Object.assign(p.state, { px: 1, py: 600, vehicle: VEHICLE.JET, vehicleId: aircraft.id, seat, heading: .4, vx: 35, vy: 3, vz: -45 });
    }
    internal(west.game).dropCarpetBombs(crew[0]);
    const foreignIds = [aircraft.id, ...west.game.projectiles.keys()];
    assert.ok(foreignIds.length > 2); assert.ok(foreignIds.every(id => id >= DYNAMIC_ENTITY_BASE));
    assert.equal(new Set(foreignIds).size, foreignIds.length, 'hulls and projectiles share one allocation stream');
    const detached = west.game.takeHandoff([crew[1].id]);
    const request = { id: randomUUID(), source: west.token, destination: east.token, layoutVersion: 2, members: members(detached.record), record: detached.record };

    const forged = structuredClone(request), unowned = hull(east.game).id;
    forged.id = randomUUID(); forged.record.vehicles[0].id = unowned;
    for (const p of forged.record.players) { p.vehicleId = unowned; p.state.vehicleId = unowned; }
    assert.throws(() => c.prepareRegional(forged), (error: unknown) => error instanceof OwnershipError && error.code === 'invalid' && /not issued/.test(error.message));
    const arrived = commit(request, east.game);
    assert.equal(arrived.length, 2); assert.equal(east.game.vehicles.get(aircraft.id)!.gunner, crew[1].id);
    for (const id of foreignIds.slice(1)) assert.ok(east.game.projectiles.has(id));

    // The source process is gone, but its original entities are still alive east.
    c.unregister(west.token.id, west.token.epoch); await west.pool.close();
    const replacement = boot('west-restarted', 'r0:0');
    const localHull = hull(replacement.game, -1), bot = replacement.game.addPlayer('Ally', null, true);
    Object.assign(bot.state, { px: -1, py: 600, vehicle: VEHICLE.JET, vehicleId: localHull.id }); bot.vehicleId = localHull.id;
    internal(replacement.game).dropCarpetBombs(bot);
    const creature = replacement.game.wildlife.spawn(1, { x: -1, y: 600, z: 0 }); assert.ok(creature);
    const newIds = [localHull.id, bot.id, creature.id, ...replacement.game.projectiles.keys()];
    assert.equal(new Set(newIds).size, newIds.length);
    assert.ok(newIds.every(id => !foreignIds.includes(id)));
    for (const id of foreignIds.slice(1)) assert.ok(east.game.projectiles.has(id), 'replacement spawning cannot touch migrated projectiles');

    const backHull = east.game.vehicles.get(aircraft.id)!; backHull.x = -1;
    for (const p of arrived) p.state.px = -1;
    const back = east.game.takeHandoff([arrived[0].id]);
    const returned = commit({ id: randomUUID(), source: east.token, destination: replacement.token, layoutVersion: 2,
      members: members(back.record), record: back.record }, replacement.game);
    assert.equal(returned.length, 2); assert.equal(replacement.game.vehicles.get(localHull.id), localHull);
    assert.ok(replacement.game.vehicles.has(aircraft.id));
    for (const id of foreignIds.slice(1)) assert.ok(replacement.game.projectiles.has(id));
    assert.equal(c.regionalHullOwner(aircraft.id)!.node_id, replacement.token.id);
    const r = new ByteReader(internal(replacement.game).buildSnapshotFor(returned[0])); r.u8(); const snapshot = decodeSnapshot(r);
    assert.equal(snapshot.you.vehicleId, aircraft.id); assert.equal(r.remaining, 0);
  } finally { await Promise.all(pools.map(pool => pool.close())); c.close(); }
});
