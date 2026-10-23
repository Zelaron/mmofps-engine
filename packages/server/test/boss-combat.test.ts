import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CREATURE, CREATURE_DEFS, MAX_CREATURES, MAX_VISIBLE_CREATURES, VEHICLE, type World } from '@shared/index';
import { Wildlife, WILDLIFE_AI_BUDGET, WILDLIFE_RANGED_CAP, type WildlifeOptions, type WildlifePlayer } from '../src/wildlife.js';

/** Deliberately cheap, dry fixture: these tests concern combat, not worldgen. */
function arena() {
  let traces = 0, blocked = false;
  const world = {
    seed: 1337,
    column: () => ({ h: 0, lavaY: -1000, temp: .6, volc: 0 }),
    groundY: () => 0, roofedAbove: () => false, liquidAt: () => undefined,
    sdf: (_x: number, y: number) => y,
    trace(x: number, y: number, z: number, dx: number, dy: number, dz: number, max: number) {
      traces++;
      const floor = dy < 0 ? -y / dy : Infinity;
      const distance = blocked && max > 20 ? Math.min(10, floor) : floor;
      return distance >= 0 && distance <= max
        ? { hit: true, x: x + dx * distance, y: y + dy * distance, z: z + dz * distance, nx: 0, ny: 1, nz: 0, dist: distance }
        : { hit: false, x: x + dx * max, y: y + dy * max, z: z + dz * max, nx: 0, ny: 0, nz: 0, dist: max };
    },
  } as unknown as World;
  return { world, get traces() { return traces; }, reset() { traces = 0; }, cover(value: boolean) { blocked = value; } };
}
function encounter(options: WildlifeOptions = {}) {
  const fixture = arena(), hits: { id: number; amount: number }[] = [];
  const fauna = new Wildlife(fixture.world, (id, amount) => hits.push({ id, amount }), () => {}, undefined, undefined,
    { ecology: { id: 'test', roster: [] }, ...options });
  const boss = fauna.spawn(CREATURE.OSSUARY_TITAN, { x: 0, y: 0, z: 0 })!;
  return { fixture, hits, fauna, boss };
}
const actor = (id: number, x: number, y = 0, z = 0): WildlifePlayer => ({ id, x, y, z, alive: true, vehicle: 0 });
const aiTick = (tick: number) => Math.ceil(tick / 6) * 6;

test('damaged bosses pursue the actual distant attacker and survive beyond the ordinary observer horizon', () => {
  const { fauna, boss } = encounter(), attacker = actor(2, 1100), bystander = actor(1, -5);
  fauna.damage(boss, 10, attacker.id, 0);
  fauna.update(6, [bystander, attacker]);
  assert.ok(boss.x > 0, 'a nearby bystander must not steal retaliation from the shooter');
  assert.equal(boss.aggressorId, attacker.id); assert.equal(boss.speed, CREATURE_DEFS[boss.species].pursuit!.speed);
  fauna.update(12, [attacker]);
  assert.equal(fauna.creatures.get(boss.id), boss, 'the encounter cannot vanish when the shooter is more than300m away');
  assert.equal(fauna.snapshot(attacker.x, attacker.y, attacker.z)[0]?.id, boss.id);
  fauna.damage(boss, 10, attacker.id, 2600);
  fauna.update(2706, [attacker]); assert.equal(fauna.creatures.get(boss.id), boss, 'new damage refreshes the pursuit');
});

test('boss pursuit expires and does not retain dead, disconnected, protected or out-of-bounds attackers', () => {
  for (const kind of ['expired', 'dead', 'departed', 'far', 'protected'] as const) {
    let safe = false;
    const { fauna, boss } = encounter({ protectedAreas: () => safe ? [{ x: 700, z: 0, radius: 30 }] : [] });
    const attacker = actor(1, 700);
    fauna.damage(boss, 5, 1, 0);
    if (kind === 'dead') attacker.alive = false;
    if (kind === 'far') attacker.x = 1201;
    if (kind === 'protected') safe = true;
    fauna.update(kind === 'expired' ? 2706 : 6, kind === 'departed' ? [] : [attacker]);
    assert.equal(fauna.creatures.has(boss.id), false, kind);
  }
  const { fauna, boss } = encounter();
  fauna.update(6, [actor(1, 700)]);
  assert.equal(fauna.creatures.has(boss.id), false, 'unprovoked creatures do not acquire distant people');
});

test('retaliation falls back to a recent living contributor when the newest attacker dies', () => {
  const { fauna, boss } = encounter(), first = actor(1, 1100), second = actor(2, -1100);
  fauna.damage(boss, 10, first.id, 0); fauna.damage(boss, 10, second.id, 1);
  second.alive = false;
  fauna.update(6, [first, second]);
  assert.equal(boss.aggressorId, first.id); assert.ok(boss.x > 0);
});

test('respawning does not revive an old boss pursuit, but another hit can provoke it again', () => {
  const { fauna, boss } = encounter(), shooter = actor(1, 1100), observer = actor(2, 150);
  fauna.damage(boss, 5, shooter.id, 0); shooter.alive = false;
  fauna.update(6, [shooter, observer]); assert.equal(boss.aggressorId, -1);
  shooter.alive = true;
  fauna.update(12, [shooter, observer]); assert.equal(boss.aggressorId, -1);
  fauna.damage(boss, 5, shooter.id, 13);
  fauna.update(18, [shooter, observer]); assert.equal(boss.aggressorId, shooter.id);
});

test('cover blocks a distant shot without freezing pursuit or probing a long ray every AI step', () => {
  const { fixture, fauna, boss, hits } = encounter(), attacker = actor(1, 500);
  fixture.cover(true); fauna.damage(boss, 1, 1, 0);
  fauna.update(6, [attacker]);
  assert.ok(boss.x > 0); assert.equal(boss.rangedAttack, undefined); assert.deepEqual(hits, []);
  assert.equal(fixture.traces, 3, 'one failed sightline plus the movement and floor probes');
  fixture.reset(); fauna.update(12, [attacker]);
  assert.equal(fixture.traces, 2, 'the failed far shot waits before checking again');
  assert.ok(boss.x > .76);
});

test('boss ranged attacks commit a visible aim point and moving during windup dodges the blast', () => {
  const { fauna, boss, hits } = encounter(), attacker = actor(1, 500);
  fauna.damage(boss, 1, 1, 0); fauna.update(6, [attacker]);
  const shot = { ...boss.rangedAttack! };
  assert.equal(shot.x, 500); assert.ok(shot.fireTick > 6 + 60); assert.ok(shot.impactTick > shot.fireTick + 30);
  assert.deepEqual(fauna.snapshot(500, 0, 0)[0].rangedAttack, shot);
  attacker.z = 30;
  fauna.update(aiTick(shot.fireTick), [attacker]);
  assert.deepEqual(boss.rangedAttack, shot, 'neither the moving boss nor the target retargets a released projectile');
  assert.ok(boss.x > 0, 'the boss resumes pursuit after releasing its attack');
  fauna.update(aiTick(shot.impactTick), [attacker]);
  assert.deepEqual(hits, []); assert.equal(boss.rangedAttack, undefined);
});

test('ranged impacts respect new cover and protected areas, and killing a boss cancels its attack', () => {
  for (const kind of ['cover', 'protected', 'killed'] as const) {
    let safe = false;
    const { fixture, fauna, boss, hits } = encounter({ protectedAreas: () => safe ? [{ x: 500, z: 0, radius: 30 }] : [] });
    const attacker = actor(1, 500);
    fauna.damage(boss, 1, 1, 0); fauna.update(6, [attacker]);
    const impact = boss.rangedAttack!.impactTick;
    if (kind === 'cover') fixture.cover(true);
    if (kind === 'protected') safe = true;
    if (kind === 'killed') fauna.damage(boss, boss.health, 1, 60);
    fauna.update(aiTick(impact), [attacker]);
    assert.deepEqual(hits, [], kind); assert.equal(boss.rangedAttack, undefined, kind);
  }
});

test('ranged retaliation can hit elevated aircraft, but crew members only take one hull hit', () => {
  const { fauna, boss, hits } = encounter();
  const crew = [1, 2, 3].map(id => ({ ...actor(id, 500, 120), vehicle: VEHICLE.JET, vehicleId: 10 }));
  fauna.damage(boss, 1, crew[2].id, 0); fauna.update(6, crew);
  assert.ok(boss.rangedAttack); assert.equal(boss.aggressorId, 3, 'a passenger can provoke retaliation');
  const impact = boss.rangedAttack.impactTick;
  fauna.update(aiTick(impact), crew);
  assert.deepEqual(hits, [{ id: 1, amount: CREATURE_DEFS[boss.species].ranged!.damage }]);
});

test('incoming boss warnings stay in a crowded recipient snapshot at long range and high altitude', () => {
  const { fauna, boss } = encounter(), attacker = actor(1, 800, 550);
  for (let i = 0; i < 30; i++) fauna.spawn(CREATURE.GRAZER, { x: 800 + i / 10, y: 550, z: 0 });
  fauna.damage(boss, 1, 1, 0); fauna.update(6, [attacker]);
  assert.ok(boss.rangedAttack);
  const snapshot = fauna.snapshot(attacker.x, attacker.y, attacker.z);
  assert.equal(snapshot.length, MAX_VISIBLE_CREATURES);
  assert.equal(snapshot[0].id, boss.id, 'doubling vertical interest distance must not hide the incoming attack');
});

test('boss damage attribution counts actual damage, retains lethal contributors, and stays bounded', () => {
  const { fauna, boss } = encounter();
  for (let id = 0; id < 100; id++) fauna.damage(boss, 1, id, id);
  assert.equal(boss.damageContributors.size, 64); assert.equal(boss.damageContributors.has(0), false);
  const before = boss.health;
  fauna.damage(boss, before + 90000, 99, 120);
  assert.deepEqual(boss.damageContributors.get(99), { damage: before + 1, lastHitTick: 120 });
  fauna.damage(boss, 1000, 1, 121);
  assert.equal(boss.damageContributors.size, 64, 'a corpse cannot add contributions');
  const ordinary = fauna.spawn(CREATURE.SHAMBLER, { x: 0, y: 0, z: 0 })!;
  fauna.damage(ordinary, 1, 1, 120); assert.equal(ordinary.damageContributors.size, 0);
});

test('mass boss encounters retain the AI budget, bounded blast checks and one protected-area read per update', () => {
  let protectionReads = 0;
  const { fixture, fauna, boss } = encounter({ protectedAreas: () => { protectionReads++; return []; } });
  for (let i = 1; i < MAX_CREATURES; i++) fauna.spawn(CREATURE.OSSUARY_TITAN, { x: 0, y: 0, z: i / 100 });
  const players = Array.from({ length: 20 }, (_, i) => actor(i, 500, 0, i / 100));
  for (const creature of fauna.creatures.values()) fauna.damage(creature, 1, 0, 0);
  protectionReads = 0; fixture.reset(); fauna.update(6, players);
  assert.equal(protectionReads, 1); assert.ok(fixture.traces <= WILDLIFE_AI_BUDGET * 3);
  assert.equal([...fauna.creatures.values()].filter(c => c.rangedAttack).length, WILDLIFE_RANGED_CAP);
  assert.equal([...fauna.creatures.values()].filter(c => c.thinkAt === 6).length, WILDLIFE_AI_BUDGET);
  for (let tick = 12; tick <= 36; tick += 6) fauna.update(tick, players);
  const impact = aiTick(boss.rangedAttack!.impactTick + 36);
  fixture.reset(); protectionReads = 0; fauna.update(impact, players);
  assert.equal(protectionReads, 1);
  assert.ok(fixture.traces <= WILDLIFE_AI_BUDGET * 11, 'one impact ray, at most eight victim rays, and two movement probes each');
  assert.equal([...fauna.creatures.values()].filter(c => c.thinkAt === impact).length, WILDLIFE_AI_BUDGET);
});

test('crowded boss blasts land on their advertised tick, never on a later round-robin slot', () => {
  for (const dodge of [false, true]) {
    const { world } = arena(); let currentTick = 0;
    const hitTicks: number[] = [], fauna = new Wildlife(world, () => hitTicks.push(currentTick), () => {}, undefined, undefined,
      { ecology: { id: 'test', roster: [] } });
    const attacker = actor(1, 500);
    for (let i = 0; i < MAX_CREATURES; i++) {
      const boss = fauna.spawn(CREATURE.OSSUARY_TITAN, { x: 0, y: 0, z: 0 })!;
      fauna.damage(boss, 1, attacker.id, 0);
    }
    currentTick = 6; fauna.update(currentTick, [attacker]);
    const first = [...fauna.creatures.values()].filter(c => c.rangedAttack);
    assert.equal(first.length, WILDLIFE_RANGED_CAP);
    const impactTick = first[0].rangedAttack!.impactTick;
    assert.ok(first.every(c => c.rangedAttack!.impactTick === impactTick && c.rangedAttack!.fireTick % 6 === 0));
    assert.equal(impactTick % 6, 0);
    for (currentTick = 12; currentTick <= impactTick + 42; currentTick += 6) {
      if (dodge && currentTick === impactTick) attacker.z = 30;
      if (dodge && currentTick === impactTick + 6) attacker.z = 0;
      fauna.update(currentTick, [attacker]);
      assert.ok([...fauna.creatures.values()].filter(c => c.rangedAttack).length <= WILDLIFE_RANGED_CAP);
      assert.equal([...fauna.creatures.values()].filter(c => c.thinkAt === currentTick).length, WILDLIFE_AI_BUDGET);
      if (currentTick === impactTick) assert.ok(first.every(c => c.rangedAttack === undefined), 'all first-wave impacts have resolved');
    }
    assert.deepEqual(hitTicks, dodge ? [] : Array(WILDLIFE_RANGED_CAP).fill(impactTick),
      dodge ? 'returning immediately after the visible impact cannot trigger late damage' : 'damage matches the visible deadline exactly');
  }
});

test('map threat reports include only the nearest eight living bosses without terrain queries', () => {
  const { fixture, fauna, boss } = encounter();
  for (let i = 1; i <= 12; i++) fauna.spawn(CREATURE.OSSUARY_TITAN, { x: i * 100, y: 0, z: 0 });
  fauna.spawn(CREATURE.SHAMBLER, { x: 1, y: 0, z: 0 });
  fauna.damage(boss, 6000, 1, 0); fixture.reset();
  const reports = fauna.threatReports(0, 0);
  assert.equal(reports.length, 8); assert.equal(reports[0].id, boss.id);
  assert.equal(reports[0].health, .5); assert.equal(reports[0].engaged, true);
  assert.ok(reports.every((r, i) => r.x === i * 100)); assert.equal(fixture.traces, 0);
  fauna.damage(boss, 6000, 1, 1);
  assert.ok(fauna.threatReports(0, 0).every(r => r.id !== boss.id));
});
