import { MAX_LEGACY_ENTITY_ID } from '@shared/entity-id';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, vehicleDistrictActive, type ServerVehicle, type ServerPlayer } from '../src/game.js';
import {
  EncounterField, ENCOUNTER_REGION_SIZE, STRUCTURE_KIND, VEHICLE, VEHICLE_DEFS,
  PICKUP_WEAPON, TICK_RATE, ByteReader, decodeSnapshot,
  type EncounterRegion, type PickupKind,
} from '@shared/index';

interface LootSpot {
  region?: string; kind: PickupKind; weapon: number;
  x: number; y: number; z: number; activeId: number; respawnAtTick: number;
}
interface EncounterInternals {
  nextVehicleId: number;
  encounterField: EncounterField | null;
  caveLoot: LootSpot[];
  activeLootRegions: Set<string>;
  knownLootRegions: Set<string>;
  updateEncounters(): void;
  updateCaveLoot(): void;
  updatePickups(): void;
  updateTeleporters(): void;
  populateVehicleRegion(key: string): Generator<void>;
  spawnVehicleAt(site: { x: number; z: number; heading: number; type: ServerVehicle['type'] }): ServerVehicle;
  buildSnapshotFor(player: ServerPlayer): Uint8Array;
}
const internals = (game: Game): EncounterInternals => game as unknown as EncounterInternals;
// Exercise the full motor pool in an enabled district; the separate density
// regression checks that three quarters of districts deliberately stay empty.
const VEHICLE_TEST_SEED = Array.from({ length: 64 }, (_, i) => 1337 + i).find(seed => vehicleDistrictActive(seed, 4, 3))!;

function completedDistrict(game: Game, key = '4,3'): void {
  const region: EncounterRegion = {
    key,
    pads: [{ x: 4510, y: 15, z: 3510, cave: false, partner: 1 },
      { x: 4520, y: -20, z: 3530, cave: true, partner: 0 }],
    loot: [{ id: 'test-loot', x: 4540, y: -20, z: 3530, weapon: 5, cave: true }], pois: [],
  };
  const field = new EncounterField(game.world);
  field.update = () => false;
  field.revision = 1;
  Object.defineProperty(field, 'regions', { get: () => [region] });
  Object.defineProperty(field, 'pads', { get: () => region.pads });
  internals(game).encounterField = field;
}

function parkPlayer(player: ServerPlayer, x: number, z: number, y = 80): void {
  Object.assign(player.state, { px: x, py: y, pz: z, vx: 0, vy: 0, vz: 0, alive: true });
}

test('disabled encounter options stay isolated when a remote district becomes active', () => {
  const plain = new Game(1337);
  plain.addPlayer('Walker', null);
  for (let i = 0; i < 80; i++) { plain.tick++; internals(plain).updateEncounters(); }
  assert.equal(plain.teleporterPads.length, 0);
  assert.equal(plain.vehicles.size, 0);
  assert.equal(plain.pickups.size, 0);

  const vehiclesOnly = new Game(1337, { vehicles: true, teleporters: false });
  assert.ok(vehiclesOnly.vehicles.size > 0);
  completedDistrict(vehiclesOnly);
  const player = vehiclesOnly.addPlayer('Driver', null);
  parkPlayer(player, 4608, 3584);
  for (let i = 0; i < 80; i++) {
    vehiclesOnly.tick++;
    internals(vehiclesOnly).updateEncounters();
    internals(vehiclesOnly).updateCaveLoot();
  }
  assert.equal(vehiclesOnly.teleporterPads.length, 0, 'vehicles must not implicitly enable pads');
  assert.equal(vehiclesOnly.pickups.size, 0, 'vehicles must not implicitly enable cave loot');
});

test('remote districts expose working cave returns and persistent respawning weapon stashes', () => {
  const game = new Game(1337, { teleporters: true, vehicles: false });
  const internal = internals(game), player = game.addPlayer('Explorer', null);
  const key = '4,3', x = 4.5 * ENCOUNTER_REGION_SIZE, z = 3.5 * ENCOUNTER_REGION_SIZE;
  parkPlayer(player, x, z);
  for (let i = 0; i < 2000 && !internal.knownLootRegions.has(key); i++) {
    game.tick++; internal.updateEncounters();
  }
  assert.ok(internal.knownLootRegions.has(key), 'the occupied remote district should finish incrementally');
  const region = internal.encounterField!.regions.find(r => r.key === key)!;
  assert.ok(region.pads.length >= 8, 'transport density should be local rather than a fixed world-wide quota');
  const cavePad = game.teleporterPads.find(pad => pad.cave &&
    Math.floor(pad.x / ENCOUNTER_REGION_SIZE) === 4 && Math.floor(pad.z / ENCOUNTER_REGION_SIZE) === 3)!;
  assert.ok(cavePad, 'remote caverns need a return pad');
  const destination = game.teleporterPads[cavePad.partner];
  assert.equal(destination.cave, false, 'each cave return must reach daylight');
  assert.equal(game.teleporterPads[destination.partner], cavePad, 'active roster partner offsets must be reciprocal');
  parkPlayer(player, cavePad.x, cavePad.z, cavePad.y + .25);
  internal.updateTeleporters();
  assert.equal(player.state.px, destination.x);
  assert.equal(player.state.pz, destination.z);
  internal.updateTeleporters();
  assert.equal(player.state.px, destination.x, 'arrival must not ping-pong back');

  internal.updateCaveLoot();
  const spot = internal.caveLoot.find(p => p.region === key && p.kind === PICKUP_WEAPON)!;
  assert.ok(spot, 'a distant cave district should expose its own weapon stashes');
  const first = game.pickups.get(spot.activeId)!;
  assert.ok(first?.permanent);
  assert.ok(game.world.roofedAbove(first.x, first.y + 1.2, first.z));
  parkPlayer(player, first.x + 4, first.z, first.y - .35);
  const reader = new ByteReader(internal.buildSnapshotFor(player)); reader.u8();
  assert.ok(decodeSnapshot(reader).pickups?.some(p => p.id === first.id), 'nearby underground loot must reach snapshots');
  player.ammo[first.weapon].magazine = 0; player.ammo[first.weapon].reserve = 0;
  parkPlayer(player, first.x, first.z, first.y - .35);
  internal.updatePickups();
  assert.ok(!game.pickups.has(first.id), 'the authoritative pickup can be collected');
  assert.ok(player.ammo[first.weapon].magazine > 0);
  internal.updateCaveLoot();
  const due = spot.respawnAtTick;
  assert.equal(due, game.tick + 45 * TICK_RATE);

  parkPlayer(player, -x, -z);
  internal.updateEncounters(); internal.updateCaveLoot();
  assert.equal(spot.activeId, 0, 'inactive district loot leaves the live roster');
  assert.equal(spot.respawnAtTick, due, 'streaming out must preserve the collection cooldown');
  parkPlayer(player, x, z);
  game.tick += 10; internal.updateEncounters(); internal.updateCaveLoot();
  assert.equal(spot.activeId, 0, 'revisiting must not farm an immediate replacement');
  game.tick = due - 1; internal.updateCaveLoot(); assert.equal(spot.activeId, 0);
  game.tick = due; internal.updateCaveLoot();
  const respawned = game.pickups.get(spot.activeId)!;
  assert.ok(respawned && respawned.id !== first.id);
  assert.deepEqual([respawned.x, respawned.y, respawned.z], [first.x, first.y, first.z]);
  assert.equal(respawned.weapon, first.weapon);
  assert.equal(game.vehicles.size, 0, 'teleporter-only worlds must not populate vehicles');
});

/** Controlled flat bases exercise spawning policy without lucky terrain. */
function flatVehicleDistrict(game: Game, key = '4,3'): void {
  const [cx, cz] = key.split(',').map(Number), x0 = cx * ENCOUNTER_REGION_SIZE, z0 = cz * ENCOUNTER_REGION_SIZE;
  internals(game).activeLootRegions = new Set([key]);
  game.world.groundY = () => 0;
  const column = game.world.column(0, 0);
  game.world.column = () => ({ ...column, h: 0, lavaY: -1000 });
  game.world.sdf = (_x, y) => y;
  game.world.collectSurfaceSites = (minX, _maxX, minZ) => {
    if (minX !== x0 || minZ !== z0) return [];
    return [STRUCTURE_KIND.BUNKER, STRUCTURE_KIND.ENCAMPMENT, STRUCTURE_KIND.HANGAR,
      STRUCTURE_KIND.RELAY, STRUCTURE_KIND.COURTYARD, STRUCTURE_KIND.RUNWAY]
      .map((kind, i) => ({ kind, x: x0 + 25 + i * 36, y: 0, z: z0 + 100, hx: 5, hy: 4, hz: 4, top: 4, rotated: false }));
  };
}

function drain(iterator: Generator<void>): void {
  for (let steps = 0; steps < 300; steps++) if (iterator.next().done) return;
  assert.fail('district population exceeded its bounded candidate work');
}

test('regional vehicle density is replenished without duplicates', () => {
  const game = new Game(VEHICLE_TEST_SEED);
  flatVehicleDistrict(game);
  drain(internals(game).populateVehicleRegion('4,3'));
  const counts = (type: number) => [...game.vehicles.values()].filter(v => v.type === type).length;
  assert.equal(counts(VEHICLE.JEEP), 3);
  assert.equal(counts(VEHICLE.TANK), 1);
  assert.equal(counts(VEHICLE.JET), 1);
  const ids = [...game.vehicles.keys()];
  drain(internals(game).populateVehicleRegion('4,3'));
  assert.deepEqual([...game.vehicles.keys()], ids, 'retries should count existing hulls');
  const jeep = [...game.vehicles.values()].find(v => v.type === VEHICLE.JEEP)!;
  game.vehicles.delete(jeep.id);
  drain(internals(game).populateVehicleRegion('4,3'));
  assert.equal(counts(VEHICLE.JEEP), 3, 'a departed hull leaves room for a replacement');
  const list = [...game.vehicles.values()];
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    assert.ok(Math.hypot(list[i].x - list[j].x, list[i].z - list[j].z) >= 12);
  }
});

function fillVehicles(game: Game, protectedOnly: boolean): { near: ServerVehicle; occupied: ServerVehicle } {
  const player = game.addPlayer('Protected', null);
  parkPlayer(player, 4500, 3500);
  let near!: ServerVehicle, occupied!: ServerVehicle;
  for (let i = 0; i < 160; i++) {
    const vehicle: ServerVehicle = { id: 1000 + i, type: VEHICLE.JEEP,
      x: i === 0 || protectedOnly ? 4700 + (i % 10) * 15 : -6000 + i * 15,
      y: .05, z: i === 0 || protectedOnly ? 3600 + Math.floor(i / 10) * 15 : -6000,
      heading: 0, health: VEHICLE_DEFS[VEHICLE.JEEP].maxHealth,
      occupant: i === 1 ? player.id : -1, respawnAtTick: -1 };
    if (i === 0) near = vehicle;
    if (i === 1) occupied = vehicle;
    game.vehicles.set(vehicle.id, vehicle);
  }
  return { near, occupied };
}

test('regional vehicle cap evicts only distant unoccupied hulls and never exceeds 160', () => {
  for (const protectedOnly of [false, true]) {
    const game = new Game(VEHICLE_TEST_SEED);
    const protectedHulls = fillVehicles(game, protectedOnly);
    flatVehicleDistrict(game);
    const iterator = internals(game).populateVehicleRegion('4,3');
    let done = false;
    for (let i = 0; i < 300 && !done; i++) {
      done = iterator.next().done === true;
      assert.ok(game.vehicles.size <= 160, 'the cap must hold throughout incremental spawning');
      assert.equal(game.vehicles.get(protectedHulls.near.id), protectedHulls.near);
      assert.equal(game.vehicles.get(protectedHulls.occupied.id), protectedHulls.occupied);
    }
    assert.ok(done);
    assert.equal(game.vehicles.size, 160);
    const newHulls = [...game.vehicles.values()].filter(v => v.id < 1000);
    assert.equal(newHulls.length > 0, !protectedOnly,
      'new encounters must wait when every existing hull is protected');
  }
});

test('a district deactivated during a yielded vehicle query stops spawning', () => {
  const game = new Game(VEHICLE_TEST_SEED);
  flatVehicleDistrict(game);
  const job = internals(game).populateVehicleRegion('4,3');
  assert.equal(job.next().done, false);
  internals(game).activeLootRegions.clear();
  drain(job);
  assert.equal(game.vehicles.size, 0, 'an obsolete district job must not spawn or evict after its yield');
});

test('regional vehicle id wrap preserves live and occupied hulls', () => {
  const game = new Game(1337);
  const internal = internals(game);
  game.world.groundY = () => 0;
  const existing = [MAX_LEGACY_ENTITY_ID, 1, 2].map((id): ServerVehicle => ({
    id, type: VEHICLE.JEEP, x: -2000 + id % 100, y: .05, z: 1000, heading: 0,
    health: VEHICLE_DEFS[VEHICLE.JEEP].maxHealth, occupant: id === 1 ? 7 : -1, respawnAtTick: -1,
  }));
  for (const vehicle of existing) game.vehicles.set(vehicle.id, vehicle);
  internal.nextVehicleId = MAX_LEGACY_ENTITY_ID;
  const first = internal.spawnVehicleAt({ x: 4500, z: 3500, heading: 0, type: VEHICLE.TANK });
  const second = internal.spawnVehicleAt({ x: 4600, z: 3500, heading: 0, type: VEHICLE.JEEP });
  assert.equal(first.id, 3);
  assert.equal(second.id, 4);
  assert.equal(game.vehicles.size, 5);
  for (const vehicle of existing) assert.equal(game.vehicles.get(vehicle.id), vehicle);
});
