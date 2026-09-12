import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, WEAPONS, PLAYER, VEHICLE, CREATURE_DEFS, MAX_CREATURES, MAX_VISIBLE_CREATURES, type InputCmd, type WeaponDef } from '@shared/index';
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
    const observer = { id: 1, x: 100, y: 0, z: 0, alive: true, vehicle: VEHICLE.JET };
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
