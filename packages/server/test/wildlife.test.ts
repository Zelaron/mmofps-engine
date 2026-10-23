import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, WEAPONS, PLAYER, VEHICLE, VEHICLE_VARIANT, CREATURE, CREATURE_DEFS, MAX_CREATURES, MAX_VISIBLE_CREATURES, type InputCmd, type WeaponDef } from '@shared/index';
import { Wildlife, WILDLIFE_AI_BUDGET, WILDLIFE_LOCAL_CAP } from '../src/wildlife.js';
import { Game, type ServerPlayer } from '../src/game.js';
import { MAX_ENTITY_ID } from '@shared/entity-id';

function flatWorld(wall = false): World {
  const world = new World(1337);
  const column = world.column(0, 0);
  world.column = () => ({ ...column, h: 0, lavaY: -1000 });
  world.roofedAbove = () => false;
  world.groundY = () => 0;
  world.sdf = (_x, y) => y;
  world.trace = (x, y, z, dx, dy, dz, max) => {
    const floor = dy < 0 ? -y / dy : Infinity;
    const dist = wall && Math.abs(dy) < .5 ? .2 : floor;
    return dist >= 0 && dist <= max ? { hit: true, x: x + dx * dist, y: y + dy * dist,
      z: z + dz * dist, nx: 0, ny: 1, nz: 0, dist } :
      { hit: false, x: x + dx * max, y: y + dy * max, z: z + dz * max, nx: 0, ny: 0, nz: 0, dist: max };
  };
  return world;
}

test('safe-integer wildlife IDs keep steering responsive and idle timing exact', () => {
  for (const id of [2 ** 40 + 1, MAX_ENTITY_ID]) {
    const fauna = new Wildlife(flatWorld(), () => {}, () => {}, undefined, { allocate: () => id });
    const creature = fauna.spawn(0, { x: 0, y: 0, z: 0 })!;
    assert.equal(creature.id, id); assert.ok(creature.yaw >= 0 && creature.yaw < Math.PI * 2);
    const originalYaw = creature.yaw;
    const observer = { id: 1, x: 100, y: 40, z: 0, alive: true, vehicle: VEHICLE.JET };
    for (let tick = 6; tick <= 240; tick += 6) {
      fauna.update(tick, [observer]);
      const moving = (BigInt(tick) + BigInt(id) * 37n) % 240n < 140n;
      assert.equal(creature.speed > 0, moving, `idle phase at tick ${tick}`);
      assert.equal(fauna.creatures.get(id), creature);
      if (tick === 6) { assert.notEqual(creature.yaw, originalYaw); creature.turnAt = Infinity; }
    }
  }
});

test('land wildlife cannot spawn in water, wander into it, or persist after being submerged',()=>{
  const world=flatWorld();let flooded=false;
  world.liquidAt=(x,y,z)=>flooded||x>6?{id:2,kind:'water',surfaceY:3,bottomY:0,distance:-10,flowX:0,flowZ:0}:undefined;
  const fauna=new Wildlife(world,()=>{},()=>{}),player={id:1,x:0,y:0,z:0,alive:true,vehicle:0};
  for(let species=0;species<CREATURE_DEFS.length;species++)assert.equal(fauna.spawn(species,{x:10,y:0,z:0}),null);
  const grazer=fauna.spawn(0,{x:5.8,y:0,z:0})!;
  for(let tick=6;tick<=120;tick+=6)fauna.update(tick,[player]);
  assert.ok(grazer.x<=6,'fleeing must stop at the wet bank');
  flooded=true;fauna.update(126,[player]);assert.equal(fauna.creatures.has(grazer.id),false);
  for(let tick=132;tick<=600;tick+=6)fauna.update(tick,[player]);
  assert.equal(fauna.creatures.size,0,'surface groups and companions must all reject a wet floor');
});

test('grazers flee without attacking; predators need clear range and obey bite cooldown', () => {
  let bites = 0;
  const fauna = new Wildlife(flatWorld(), () => bites++, () => {});
  const grazer = fauna.spawn(0, { x: 5, y: 0, z: 0 })!;
  const predator = fauna.spawn(2, { x: -1.2, y: 0, z: 0 })!;
  const player = { id: 1, x: 0, y: 0, z: 0, alive: true, vehicle: 0 };
  fauna.update(6, [player]);
  assert.ok(grazer.x > 5, 'passive grazer runs away');
  assert.equal(bites, 1);
  fauna.update(12, [player]);
  assert.equal(bites, 1, 'bite cannot repeat every AI step');
  assert.equal(predator.alert, true);
  const blocked = new Wildlife(flatWorld(true), () => bites++, () => {});
  blocked.spawn(2, { x: 1, y: 0, z: 0 }); blocked.update(6, [player]);
  assert.equal(bites, 1, 'a wall blocks predator attacks');
});

test('undead bite reachable hull surfaces, including landed aircraft, without hitting airborne targets or through cover', () => {
  for (const [vehicle, vehicleVariant, x, y] of [[VEHICLE.JEEP, 0, 3, 0], [VEHICLE.TANK, 0, 3.3, 0],
    [VEHICLE.TANK, VEHICLE_VARIANT.BASTION, 4.1, 0], [VEHICLE.JET, 0, 3.1, 0], [VEHICLE.GUNBOAT, 0, 3.6, -.65]]) {
    const hits: number[] = [], world = flatWorld(), fauna = new Wildlife(world, id => hits.push(id), () => {});
    const zombie = fauna.spawn(CREATURE.SHAMBLER, { x: 0, y: 0, z: 0 })!;
    const driver = { id: 1, x, y, z: 0, alive: true, vehicle, vehicleVariant, vehicleId: 10 };
    fauna.update(6, [driver]);
    assert.deepEqual(hits, [1], `vehicle ${vehicle}/${vehicleVariant}: a nearby hull can be struck from outside it`);
    fauna.update(12, [driver]); assert.equal(hits.length, 1, 'armor attacks keep the ordinary melee cooldown');
    driver.y = 20; fauna.update(90, [driver]); assert.equal(hits.length, 1, 'melee cannot reach a flying hull');
    assert.equal(zombie.alert, false);
    const blocked = new Wildlife(flatWorld(true), id => hits.push(id), () => {});
    blocked.spawn(CREATURE.SHAMBLER, { x: 0, y: 0, z: 0 });
    blocked.update(6, [{ ...driver, y }]); assert.equal(hits.length, 1, 'solid cover protects occupied vehicles');
  }
});

test('committed monster attacks hit each crewed hull once and a driven escape dodges the slam', () => {
  const hits: number[] = [], fauna = new Wildlife(flatWorld(), id => hits.push(id), () => {});
  fauna.spawn(CREATURE.OSSUARY_TITAN, { x: 0, y: 0, z: 0 });
  const crew = [1, 2, 3].map(id => ({ id, x: 12, y: 0, z: 0, alive: true,
    vehicle: VEHICLE.TANK, vehicleId: 10 }));
  fauna.update(6, crew); assert.deepEqual(hits, []);
  fauna.update(96, crew); assert.deepEqual(hits, [1], 'passengers must not multiply damage against the same armor');
  fauna.update(402, crew);
  for (const member of crew) member.x = 18;
  fauna.update(492, crew); assert.deepEqual(hits, [1], 'driving out during the windup avoids the committed impact');
});

test('authoritative undead attacks damage occupied vehicle armor and leave its crew protected', () => {
  const game = new Game(1337), driver = game.addPlayer('Driver', null), gunner = game.addPlayer('Gunner', null);
  Object.assign(driver.state, { px: 3.3, py: 400, pz: 0, vehicle: VEHICLE.TANK });
  Object.assign(gunner.state, { px: 3.3, py: 400, pz: 0, vehicle: VEHICLE.TANK, seat: 1 });
  driver.vehicleId = gunner.vehicleId = 10; driver.spawnProtectedUntil = gunner.spawnProtectedUntil = 0;
  const hull = { id: 10, type: VEHICLE.TANK, x: 3.3, y: 400, z: 0, heading: 0,
    health: 4500, occupant: driver.id, gunner: gunner.id, respawnAtTick: -1 };
  game.vehicles.set(hull.id, hull);
  game.wildlife.spawn(CREATURE.SHAMBLER, { x: 0, y: 400, z: 0 });
  game.wildlife.update(6, [driver, gunner].map(p => ({ id: p.id, x: p.state.px, y: p.state.py,
    z: p.state.pz, alive: true, vehicle: p.state.vehicle, vehicleId: p.vehicleId })));
  assert.equal(hull.health, 4500 - CREATURE_DEFS[CREATURE.SHAMBLER].damage);
  assert.equal(driver.health, 100); assert.equal(gunner.health, 100);
});

test('small mixed groups become visible near a walker without exceeding the local cap', () => {
  const fauna = new Wildlife(flatWorld(), () => {}, () => {});
  const player = { id: 1, x: 64, y: 0, z: 64, alive: true, vehicle: 0 };
  for (let tick = 6; tick <= 900; tick += 6) fauna.update(tick, [player]);
  const nearby = fauna.snapshot(player.x, player.y, player.z);
  assert.ok(nearby.length >= 6, `fifteen seconds of normal ground play should find small groups (${nearby.length})`);
  assert.ok(nearby.length <= WILDLIFE_LOCAL_CAP);
  assert.ok(new Set(nearby.map(c => c.species)).size >= 3, 'nearby groups should offer different silhouettes');
  assert.ok(nearby.every(c => !CREATURE_DEFS[c.species].cave));
  assert.ok(nearby.some(c => Math.hypot(c.x - player.x, c.z - player.z) < 90), 'wildlife must not all sit at the interest horizon');
  const homes = new Map<string, number>();
  for (const c of fauna.creatures.values()) {
    const key = `${c.homeX},${c.homeZ}`; homes.set(key, (homes.get(key) ?? 0) + 1);
  }
  assert.ok([...homes.values()].some(n => n >= 2 && n <= 3), 'companions share a small group home');
});

test('caves without discovery metadata can contain supported passive and hostile wildlife', () => {
  const world = flatWorld(); world.roofedAbove = () => true;
  const fauna = new Wildlife(world, () => {}, () => {}), player = { id: 1, x: 64, y: 0, z: 64, alive: true, vehicle: 0 };
  for (let tick = 6; tick <= 900; tick += 6) fauna.update(tick, [player], []);
  const species = new Set(fauna.snapshot(player.x, player.y, player.z).map(c => c.species));
  assert.deepEqual([...species].sort(), [2, 5]);
  assert.ok(fauna.creatures.size >= 4 && fauna.creatures.size <= WILDLIFE_LOCAL_CAP);
});

test('new passive wildlife flees and bristlebacks defend only their immediate space', () => {
  let bites = 0;
  const fauna = new Wildlife(flatWorld(), () => bites++, () => {}), player = { id: 1, x: 0, y: 0, z: 0, alive: true, vehicle: 0 };
  const bird = fauna.spawn(3, { x: 6, y: 0, z: 0 })!, beetle = fauna.spawn(5, { x: -5, y: 0, z: 0 })!;
  const boar = fauna.spawn(4, { x: 16, y: 0, z: 0 })!;
  fauna.update(6, [player]);
  assert.ok(bird.x > 6 && beetle.x < -5);
  assert.equal(bites, 0); assert.equal(boar.alert, false, 'defensive animals do not chase from predator range');
  player.x = boar.x - 1.2; player.z = boar.z;
  fauna.update(12, [player]); assert.equal(bites, 1);
});

test('AI terrain work stays bounded and aircraft do not launch spawn probes', () => {
  const world = flatWorld();
  let traces = 0, roofQueries = 0;
  const trace = world.trace.bind(world); world.trace = (...args) => { traces++; return trace(...args); };
  world.roofedAbove = () => { roofQueries++; return false; };
  const fauna = new Wildlife(world, () => {}, () => {}), player = { id: 1, x: 0, y: 0, z: 0, alive: true, vehicle: 0 };
  for (let i = 0; i < MAX_CREATURES; i++) fauna.spawn(i % CREATURE_DEFS.length, { x: 35 + i % 10, y: 0, z: Math.floor(i / 10) * 3 });
  fauna.update(6, [player]);
  assert.ok(traces <= WILDLIFE_AI_BUDGET * 3, 'one crowded world cannot advance every creature terrain probe at once');
  assert.equal([...fauna.creatures.values()].filter(c => c.thinkAt === 6).length, WILDLIFE_AI_BUDGET);
  const empty = new Wildlife(world, () => {}, () => {}); traces = 0; roofQueries = 0;
  for (let i = 0; i < 30; i++) empty.update(i * 6, [{ ...player, x: i * 500, vehicle: VEHICLE.JET }]);
  assert.equal(traces, 0); assert.equal(roofQueries, 0); assert.equal(empty.creatures.size, 0);
  const hyper = new Wildlife(world, () => {}, () => {});
  for (let i = 0; i < 30; i++) hyper.update(i * 6, [{ ...player, x: i * 20 }]);
  assert.equal(traces, 0); assert.equal(roofQueries, 0, 'rapid on-foot travel also skips cold spawning queries');
});

test('fauna population, nearest snapshot and corpse/loot lifetime remain bounded', () => {
  let loot = 0;
  const fauna = new Wildlife(flatWorld(), () => {}, () => loot++);
  for (let i = 0; i < MAX_CREATURES + 20; i++) fauna.spawn(2, { x: i, y: 0, z: 0 });
  assert.equal(fauna.creatures.size, MAX_CREATURES);
  assert.equal(fauna.snapshot(0, 0, 0).length, MAX_VISIBLE_CREATURES);
  for (const c of fauna.creatures.values()) {
    assert.equal(fauna.damage(c, 100, 1, 0), true);
    assert.equal(fauna.damage(c, 100, 1, 1), false, 'a corpse cannot drop loot twice');
  }
  assert.ok(loot > 50 && loot < MAX_CREATURES, 'loot is frequent but not guaranteed');
  assert.ok(fauna.snapshot(0, 0, 0).every(c => c.dead));
  fauna.update(300, []);
  assert.equal(fauna.creatures.size, 0);
});

test('rejected terrain probes cannot grow the exploration cache without limit', () => {
  const world = flatWorld();
  world.sdf = () => -1;
  const fauna = new Wildlife(world, () => {}, () => {});
  for (let i = 0; i < 1500; i++) for (const step of [0, 6]) fauna.update(i * 12 + step,
    [{ id: 1, x: i * 600, y: 0, z: 0, alive: true, vehicle: 0 }]);
  assert.ok((fauna as unknown as { visited: Map<string, number> }).visited.size <= 512);
  assert.ok((fauna as unknown as { visited: Map<string, number> }).visited.size > 300, 'the test must actually exercise rejected candidates');
  assert.equal(fauna.creatures.size, 0);
});

test('seeded real terrain yields nearby varied surface groups and fauna in a small cave room', () => {
  for (const seed of [1337, 27, 90210]) {
    const world = new World(seed), fauna = new Wildlife(world, () => {}, () => {});
    const seen = new Set<number>(), species = new Set<number>();
    for (let step = 0; step < 600; step++) {
      const x = 64 + step * .48, z = 96, y = world.groundY(x, z);
      fauna.update(step * 6, [{ id: 1, x, y, z, alive: true, vehicle: 0 }]);
      for (const c of fauna.snapshot(x, y, z)) if (Math.abs(c.y - y) < 15 && Math.hypot(c.x - x, c.z - z) < 100) {
        seen.add(c.id); species.add(c.species);
      }
    }
    assert.ok(seen.size >= 5, `seed ${seed}: a minute of ground travel should encounter multiple small groups`);
    assert.ok(species.size >= 2, `seed ${seed}: more than one silhouette should be encountered`);
  }
  const world = new World(1337), fauna = new Wildlife(world, () => {}, () => {});
  const player = { id: 1, x: 375.8798, y: -27.6837, z: 638.3846, alive: true, vehicle: 0 };
  for (let tick = 6; tick <= 1800; tick += 6) fauna.update(tick, [player], []);
  assert.ok(fauna.creatures.size >= 2 && fauna.creatures.size <= WILDLIFE_LOCAL_CAP, 'short sightlines still allow a small passive group');
  for (const c of fauna.creatures.values()) {
    assert.ok(CREATURE_DEFS[c.species].cave);
    assert.ok(world.sdf(c.x, c.y - .12, c.z) < 0, 'walking fauna remains attached to a cave floor');
    assert.ok(world.sdf(c.x, c.y + CREATURE_DEFS[c.species].height * .65, c.z) > .2);
  }
});

test('fauna combat uses real authoritative hits and gives resources without PvP kill credit', () => {
  const game = new Game(1337), owner = game.addPlayer('Hunter', null);
  Object.assign(owner.state, { px: 0, py: 400, pz: 0, vx: 0, vy: 0, vz: 0 });
  const creature = game.wildlife.spawn(2, { x: 0, y: 400, z: -12 })!;
  const internal = game as unknown as { fireHitscan(p: ServerPlayer, cmd: InputCmd, def: WeaponDef): void };
  internal.fireHitscan(owner, { seq: 1, weapon: 0, buttons: 0, yaw: 0,
    pitch: -Math.atan2(PLAYER.EYE_HEIGHT - .4, 12), renderTick: 0, renderFrac: 0 }, { ...WEAPONS[0], spread: 0, damage: 100 });
  assert.ok(creature.deadUntil > 0, 'hitscan intersects the creature capsule');
  assert.equal(owner.frags, 0, 'hunting cannot farm player scores');
  owner.weapon = 6;
  for (let i = 0; i < 20; i++) {
    const c = game.wildlife.spawn(2, { x: 20 + i, y: game.world.groundY(20 + i, 0), z: 0 })!;
    game.wildlife.damage(c, 100, owner.id, game.tick);
  }
  assert.ok(game.pickups.size > 0, 'successful hunts produce authoritative collectible resources');
  assert.ok([...game.pickups.values()].every(p => p.kind !== 2 && !WEAPONS[p.weapon]?.spawnEmpty),
    'even a cave creature outside cannot drop ammo that unlocks found weapons');
});

test('boss slams warn first, can be dodged, hit several nearby actors and respect cover', () => {
  const hits: number[] = [], world = flatWorld(), fauna = new Wildlife(world, id => hits.push(id), () => {});
  const boss = fauna.spawn(9, { x: 0, y: 0, z: 0 })!;
  const players = [1, 2].map((id, i) => ({ id, x: 6 + i * 2, y: 0, z: 0, alive: true, vehicle: 0 }));
  fauna.update(6, players); assert.equal(hits.length, 0); assert.equal(boss.windupUntil, 96);
  assert.equal(fauna.snapshot(0, 0, 0)[0].windingUp, true);
  players[0].x = 18;
  fauna.update(96, players); assert.deepEqual(hits, [2], 'walking beyond the warning ring dodges the committed attack');
  players[0].x = 6; fauna.update(402, players); assert.ok(boss.windupUntil > 402);
  fauna.update(492, players); assert.deepEqual(hits, [2, 1, 2], 'both players can be hit by a committed area attack');
  fauna.update(798, players); const trace = world.trace;
  world.trace = (x, y, z, dx, dy, dz, max) => Math.abs(dy) < .5
    ? { hit: true, x, y, z, nx: 1, ny: 0, nz: 0, dist: .1 } : trace(x, y, z, dx, dy, dz, max);
  fauna.update(888, players); assert.deepEqual(hits, [2, 1, 2], 'solid cover also blocks a committed slam');
});

test('protected faction spawn areas reject infestations and cannot be camped by pursuing bosses', () => {
  const hits: number[] = [], fauna = new Wildlife(flatWorld(), id => hits.push(id), () => {}, undefined, undefined,
    { protectedAreas: () => [{ x: 0, z: 0, radius: 70 }] });
  assert.equal(fauna.spawn(6, { x: 40, y: 0, z: 0 }), null);
  assert.equal(fauna.spawn(9, { x: 220, y: 0, z: 0 }), null, 'boss home and full leash stay clear of the spawn');
  assert.ok(fauna.spawn(0, { x: 40, y: 0, z: 0 }), 'passive fauna can still graze nearby');
  const boss = fauna.spawn(9, { x: 280, y: 0, z: 0 })!;
  boss.x = 77; boss.health--;
  fauna.update(6, [{ id: 1, x: 68, y: 0, z: 0, alive: true, vehicle: 0 }]);
  assert.equal(boss.alert, false); assert.equal(boss.windupUntil, 0); assert.deepEqual(hits, []);
});

test('boss health takes sustained team damage and yields one guaranteed reward on defeat', () => {
  let rewards = 0;
  const fauna = new Wildlife(flatWorld(), () => {}, () => rewards++), boss = fauna.spawn(11, { x: 0, y: 0, z: 0 })!;
  assert.equal(fauna.damage(boss, 1000, 1, 0), false); assert.ok(boss.health > 10000);
  assert.ok(fauna.snapshot(0, 0, 0)[0].health! < 1);
  assert.equal(fauna.damage(boss, 14000, 2, 60), true); assert.equal(rewards, 1);
  assert.equal(fauna.damage(boss, 14000, 2, 61), false); assert.equal(rewards, 1);
  assert.equal(fauna.snapshot(0, 0, 0)[0].health, 0);
});

test('server accepts an explicit future planet roster without altering the global species table', () => {
  const fauna = new Wildlife(flatWorld(), () => {}, () => {}, undefined, undefined,
    { ecology: { id: 'future-reef', roster: [{ species: 12, weight: 1, group: [3, 3], habitat: 'surface' }] } });
  for (let tick = 6; tick <= 900; tick += 6) fauna.update(tick, [{ id: 1, x: 64, y: 0, z: 64, alive: true, vehicle: 0 }]);
  assert.ok(fauna.creatures.size >= 3);
  assert.ok([...fauna.creatures.values()].every(c => c.species === 12));
});

test('bots are local creature targets but do not consume the offscreen encounter budget', () => {
  const hits: number[] = [], fauna = new Wildlife(flatWorld(), id => hits.push(id), () => {});
  fauna.spawn(6, { x: 0, y: 0, z: 0 });
  const human = { id: 1, x: 90, y: 0, z: 0, alive: true, vehicle: 0 };
  const bot = { id: 2, x: 1, y: 0, z: 0, alive: true, vehicle: 0, isBot: true };
  fauna.update(6, [human, bot]); assert.deepEqual(hits, [2]);
  for (let tick = 12; tick <= 900; tick += 6) fauna.update(tick, [bot]);
  assert.equal(fauna.creatures.size, 0, 'unobserved bots neither retain nor spawn distant infestations');
});

test('coastal encounters sample adjacent water at its own bed elevation', () => {
  const world = flatWorld(), dry = world.column(0, 0);
  world.column = (x: number) => ({ ...dry, city: undefined, h: x > 120 ? -8 : 0 });
  world.liquidAt = (x, y) => x > 120 && y >= -8 && y <= 0
    ? { id: 1, kind: 'water', surfaceY: 0, bottomY: -8, distance: -1, flowX: 0, flowZ: 0 } : undefined;
  const fauna = new Wildlife(world, () => {}, () => {}, undefined, undefined, {
    ecology: { id: 'coast-fixture', roster: [{ species: 13, weight: 1, group: [1, 1], habitat: 'shore', maxElevation: 35 }] },
  });
  for (let tick = 6; tick <= 900; tick += 6) fauna.update(tick, [{ id: 1, x: 0, y: 0, z: 0, alive: true, vehicle: 0 }]);
  assert.equal(fauna.creatures.size, 1, 'a dry shore can host a rare coastal boss beside a lower ocean bed');
  assert.ok([...fauna.creatures.values()].every(c => c.x <= 120));
});
