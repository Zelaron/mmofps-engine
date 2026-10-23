import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLAYER, VEHICLE } from '@shared/index';
import { Bot } from '../src/bots.js';
import { Game, ServerPlayer } from '../src/game.js';

interface AcquisitionState {
  enemyId: number; losCheckAt: number; losOk: boolean; losCursor: number; losStarted: boolean;
}

/** Previous acquisition policy, always using complete current rays. Its
 * scheduling/candidate state stays independent of the optimized controller. */
function referenceAcquire(game: Game, player: ServerPlayer, state: AcquisitionState,
  trace: Game['world']['trace']): ServerPlayer | null {
  const s = player.state;
  if (game.tick >= state.losCheckAt) {
    state.losCheckAt = game.tick + (state.losStarted ? 9 : 1 + player.id % 9);
    state.losStarted = true;
    const candidates: { player: ServerPlayer; d2: number }[] = [];
    for (const q of game.players.values()) {
      if (!game.areEnemies(player, q) || !q.state.alive || (player.vehicleId >= 0 && q.vehicleId === player.vehicleId)) continue;
      if (s.vehicle === VEHICLE.NONE && q.state.vehicle === VEHICLE.JET && !q.state.grounded) continue;
      const d2 = (q.state.px - s.px) ** 2 + (q.state.py - s.py) ** 2 + (q.state.pz - s.pz) ** 2;
      if (d2 < 390 ** 2) candidates.push({ player: q, d2 });
    }
    candidates.sort((a, b) => a.d2 - b.d2 || a.player.id - b.player.id);
    const retained = candidates.find(candidate => candidate.player.id === state.enemyId);
    state.enemyId = -1; state.losOk = false;
    const checks: typeof candidates = [];
    if (retained) checks.push(retained);
    for (let visited = 0; visited < candidates.length && checks.length < 2; visited++) {
      const candidate = candidates[state.losCursor++ % candidates.length];
      if (candidate !== retained) checks.push(candidate);
    }
    state.losCursor %= Math.max(1, candidates.length);
    for (const { player: q } of checks) {
      const x = s.px, y = s.py + PLAYER.EYE_HEIGHT, z = s.pz;
      const dx = q.state.px - x, dy = q.state.py + 1.2 - y, dz = q.state.pz - z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const hit = distance < 1e-6 ? null : trace(x, y, z, dx / distance, dy / distance, dz / distance, distance, false);
      if (!hit || !hit.hit || hit.dist > distance - .8) {
        state.losOk = true; state.enemyId = q.id; break;
      }
    }
    if (!state.losOk) state.losCheckAt += 9;
  }
  if (!state.losOk || state.enemyId < 0) return null;
  const enemy = game.players.get(state.enemyId);
  if (!enemy || !enemy.state.alive || !game.areEnemies(player, enemy)) return null;
  if (s.vehicle === VEHICLE.NONE && enemy.state.vehicle === VEHICLE.JET && !enemy.state.grounded) return null;
  return enemy;
}

function fixture() {
  const game = new Game(1337), player = new ServerPlayer(1, 'Observer', null, true, { x: 0, y: 0, z: 0 });
  player.faction = 1; game.players.set(player.id, player);
  game.areEnemies = (a, b) => a.id !== b.id && a.faction !== 0 && b.faction !== 0 && a.faction !== b.faction;
  const addTarget = (id = 2, x = 0, z = -180) => {
    const target = new ServerPlayer(id, 'Target', null, false, { x, y: PLAYER.EYE_HEIGHT - 1.2, z });
    target.faction = 2; game.players.set(id, target); return target;
  };
  const target = addTarget();
  const wall = { x: 0, y: PLAYER.EYE_HEIGHT, z: -60, hx: 8, hy: 12, hz: 5, enabled: true, tunnel: 0 };
  let traces = 0, samples = 0, normals = 0;
  game.world.sdf = (x, y, z) => {
    samples++; if (!wall.enabled) return 1000;
    const dx = Math.abs(x - wall.x) - wall.hx, dy = Math.abs(y - wall.y) - wall.hy, dz = Math.abs(z - wall.z) - wall.hz;
    const solid = Math.hypot(Math.max(dx, 0), Math.max(dy, 0), Math.max(dz, 0)) + Math.min(Math.max(dx, dy, dz), 0);
    return wall.tunnel > 0 ? Math.max(solid, wall.tunnel - Math.hypot(x - wall.x, y - wall.y)) : solid;
  };
  const trace = game.world.trace.bind(game.world);
  game.world.trace = (...args) => { traces++; if (args[7] !== false) normals++; return trace(...args); };
  const bot = new Bot(player, 1337);
  const internal = bot as unknown as AcquisitionState & {
    acquireEnemy(game: Game): ServerPlayer | null;
    losObstructions: Map<number, { fraction: number; tick: number }>;
  };
  const reference: AcquisitionState = { enemyId: -1, losCheckAt: 0, losOk: false, losCursor: 0, losStarted: false };
  const check = () => {
    const expected = referenceAcquire(game, player, reference, trace);
    traces = samples = normals = 0;
    const result = internal.acquireEnemy(game);
    assert.equal(result?.id, expected?.id, 'target selection matches the original full-ray policy');
    for (const key of Object.keys(reference) as (keyof AcquisitionState)[])
      assert.equal(internal[key], reference[key], `acquisition state ${key} changed at tick ${game.tick}`);
    assert.equal(normals, 0, 'visibility rays do not calculate unused surface normals');
    return { target: result?.id, traces, samples };
  };
  const scan = () => { game.tick = Math.max(game.tick + 1, internal.losCheckAt); return check(); };
  return { game, player, target, wall, addTarget, internal, check, scan };
}

test('bot blocked-target witnesses preserve scan cadence and replace repeated long rays with a current solid point', () => {
  const f = fixture(); assert.equal(f.check().traces, 1);
  for (let tick = 1; tick < 100; tick++) {
    f.game.tick = tick; f.target.state.px = Math.sin(tick * .1); f.player.state.px = Math.cos(tick * .1) * .1;
    const scanning = tick >= f.internal.losCheckAt, result = f.check();
    assert.equal(result.traces, 0);
    assert.equal(result.samples, scanning ? 1 : 0, 'only a scheduled scan verifies cover');
  }
});

test('bot LOS revalidates removed or moving cover and never caches a clear decision', () => {
  const f = fixture(); f.check(); assert.equal(f.scan().traces, 0);
  f.wall.x = 80; assert.equal(f.scan().traces, 1); assert.equal(f.internal.enemyId, f.target.id);
  assert.equal(f.scan().traces, 1, 'each visible scan still traces the complete ray');
  f.wall.x = 0; assert.equal(f.scan().traces, 1); assert.equal(f.internal.enemyId, -1);
  assert.equal(f.scan().traces, 0);
  f.wall.enabled = false; assert.equal(f.scan().traces, 1); assert.equal(f.internal.enemyId, f.target.id);
  f.wall.enabled = true; f.wall.z = -100;
  assert.equal(f.scan().traces, 1); assert.equal(f.internal.enemyId, -1);
  assert.equal(f.scan().traces, 0);
});

test('bot LOS uses the changed ray through cave openings and when either actor moves around cover', () => {
  const f = fixture(); f.check(); assert.equal(f.scan().traces, 0);
  f.wall.tunnel = 2;
  assert.equal(f.scan().traces, 1); assert.equal(f.internal.enemyId, f.target.id, 'an opened cave tunnel is visible');
  f.target.state.px = 18;
  assert.equal(f.scan().traces, 1); assert.equal(f.internal.enemyId, -1, 'the new aim ray intersects the tunnel wall');
  assert.equal(f.scan().traces, 0);
  f.target.state.px = 70;
  assert.equal(f.scan().traces, 1); assert.equal(f.internal.enemyId, f.target.id, 'target rounds the wall');
  f.target.state.px = 18; f.player.state.px = -8;
  assert.equal(f.scan().traces, 1); assert.equal(f.internal.enemyId, f.target.id, 'observer movement puts the ray through the opening');
});

test('bot obstruction cache expires, stays bounded and cannot reject the target contact allowance', () => {
  const f = fixture(); f.check(); assert.equal(f.scan().traces, 0);
  f.game.tick += 180; assert.equal(f.check().traces, 0, 'a crowded roster may take over two seconds to revisit a target');
  f.game.tick += 601; assert.equal(f.check().traces, 1, 'unused witnesses require a full ray again after ten seconds');
  f.wall.z = -178; f.wall.hz = .1; f.scan(); assert.equal(f.scan().traces, 0);
  f.target.state.pz = -2; f.wall.z = -1.8;
  assert.equal(f.scan().traces, 1, 'the old fraction now lies inside the target allowance');
  assert.equal(f.internal.enemyId, f.target.id);
  f.wall.z = -60; f.wall.hz = 5; f.target.state.pz = -180;
  for (let id = 3; id < 80; id++) {
    f.game.players.delete(f.target.id);
    for (const other of f.game.players.values()) if (other.id !== f.player.id) f.game.players.delete(other.id);
    f.addTarget(id); assert.equal(f.scan().traces, 1, 'different actor IDs have independent witnesses');
    assert.ok(f.internal.losObstructions.size <= 64);
  }
  for (const other of f.game.players.values()) if (other.id !== f.player.id) other.faction = f.player.faction;
  f.scan(); assert.equal(f.internal.losObstructions.size, 0, 'no eligible targets clears retained witnesses');
});

test('bot LOS keeps rotating a crowded occluded roster until the farther visible opponent is checked', () => {
  const f = fixture(); f.game.players.delete(f.target.id);
  for (let id = 2; id < 35; id++) f.addTarget(id, 0, -100 - id * 2);
  const visible = f.addTarget(100, 120, -220);
  let found = false;
  for (let tick = 0; tick < 600; tick++) {
    f.game.tick = tick; const result = f.check();
    assert.ok(result.traces <= 2, 'the original per-scan ray budget remains bounded');
    if (result.target === visible.id) { found = true; break; }
  }
  assert.equal(found, true, 'obstruction reuse cannot starve a farther visible opponent');
});

test('bot obstruction proofs remain reusable across a complete crowded candidate rotation', () => {
  const f = fixture(); f.game.players.delete(f.target.id);
  for (let id = 2; id < 22; id++) f.addTarget(id, 0, -100 - id * 2);
  let firstPass = 0, secondPass = 0;
  for (let scan = 0; scan < 20; scan++) {
    const result = scan ? f.scan() : f.check();
    if (scan < 10) firstPass += result.traces;
    else secondPass += result.traces;
  }
  assert.equal(firstPass, 20, 'the first rotation traces each of the twenty blocked opponents');
  assert.equal(secondPass, 0, 'the next rotation verifies current obstruction points instead of repeating all twenty rays');
});

test('bot obstruction proofs stay on a thin fixed wall when either actor changes range', () => {
  const f = fixture(); f.wall.hz = .1;
  assert.equal(f.check().traces, 1);
  for (const distance of [220, 135, 310, 100, 185]) {
    f.target.state.pz = -distance;
    const result = f.scan();
    assert.equal(result.traces, 0, 'projecting the last solid point preserves the fixed wall despite changing ray length');
    assert.equal(result.samples, 1);
  }
  for (const position of [5, -10, 25, -30]) {
    f.player.state.pz = position;
    assert.equal(f.scan().traces, 0, 'moving the observer along the ray retains a freshly proven wall point');
  }
  f.wall.enabled = false;
  assert.equal(f.scan().traces, 1);
  assert.equal(f.internal.enemyId, f.target.id, 'projection never retains removed cover');
});

test('relative obstruction hints still work when cover moves with a changing target range', () => {
  const f = fixture(); f.wall.hz = .1;
  f.check();
  const fraction = f.internal.losObstructions.get(f.target.id)!.fraction;
  f.target.state.pz = -280; f.wall.z = f.target.state.pz * fraction;
  const result = f.scan();
  assert.equal(result.traces, 0, 'a second current-ray point can prove cover after the old world point clears');
  assert.equal(result.samples, 2);
  f.target.state.px = 100;
  assert.equal(f.scan().traces, 1);
  assert.equal(f.internal.enemyId, f.target.id);
});
