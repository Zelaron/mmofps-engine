import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/game.js';
import {
  BTN, WEAPONS, createFullAmmoLoadout, createWeaponState, stepWeaponState,
  RAILGUN_ID, NUKE_LAUNCHER_ID, RAIL_CHARGE, NUKE_MARKER, NUKE_BOMB,
  PICKUP_WEAPON, PICKUP_AMMO,
  capsuleClearance, type World,
  type InputCmd,
} from '@shared/index';
import { buildJungleTemplePlan, type JungleTemplePlan, type TemplePoint } from '@shared/jungle-temples';

function templeExitAccess(world: World, plan: JungleTemplePlan, loot: TemplePoint): void {
  const segments = plan.routes.flatMap(route => route.slice(1).map((b, i) => ({ a: route[i], b })));
  const closest = (p: TemplePoint, segment: { a: TemplePoint; b: TemplePoint }) => {
    const a = segment.a, b = segment.b, dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((p.x-a.x)*dx + (p.y-a.y)*dy + (p.z-a.z)*dz) / Math.max(.001, dx*dx+dy*dy+dz*dz)));
    const point = { x: a.x + dx*t, y: a.y + dy*t, z: a.z + dz*t };
    return { point, distance: Math.hypot(point.x-p.x, point.y-p.y, point.z-p.z) };
  };
  const floor = loot.y - .42;
  const start = segments.map((segment, index) => ({ ...closest({ ...loot, y: floor }, segment), index }))
    .filter(candidate => Math.abs(candidate.point.y - floor) < .1).sort((a,b) => a.distance-b.distance)[0];
  assert.ok(start && start.distance < 12, 'temple treasure must join a nearby authored route');
  for (let i=0; i<=Math.ceil(start.distance*2); i++) {
    const t = i / Math.max(1, Math.ceil(start.distance*2)), x = loot.x + (start.point.x-loot.x)*t, z = loot.z + (start.point.z-loot.z)*t;
    assert.ok(capsuleClearance(world,x,floor+.37,z)>-.03, 'treasure alcove connection is blocked');
    assert.ok(world.sdf(x,floor-.08,z)<0, 'treasure alcove connection lacks a supported floor');
  }
  // Every authored route is physically sampled by the multi-seed jungle
  // traversal suite. Here prove this particular cache joins that connected
  // graph and reaches at least two independently visible surface entrances.
  const seen = new Set([start.index]), queue = [start.index];
  while(queue.length) {
    const current = segments[queue.shift()!];
    for(let index=0;index<segments.length;index++) if(!seen.has(index)) {
      const other=segments[index];
      if([current.a,current.b].some(p=>closest(p,other).distance<.01) || [other.a,other.b].some(p=>closest(p,current).distance<.01)) {
        seen.add(index); queue.push(index);
      }
    }
  }
  const exits = plan.entrances.filter(p=>[...seen].some(index=>closest(p,segments[index]).distance<.01));
  assert.ok(exits.length>=2, 'every temple cache needs at least two connected surface exits');
  for(const exit of exits) assert.equal(world.roofedAbove(exit.x,exit.y+1.6,exit.z),false);
}

function cmd(seq: number, buttons = 0, weapon = 0, yaw = 0, pitch = 0): InputCmd {
  return { seq, buttons, weapon, yaw, pitch, renderTick: 0, renderFrac: 0 };
}

test('cave weapons spawn empty for everyone', () => {
  const loadout = createFullAmmoLoadout();
  assert.deepEqual(loadout[RAILGUN_ID], { magazine: 0, reserve: 0 });
  assert.deepEqual(loadout[NUKE_LAUNCHER_ID], { magazine: 0, reserve: 0 });
});

test('teleporters move humans to their partner pad, not bots', () => {
  const game = new Game(1337, { teleporters: true });
  const pads = game.teleporterPads;
  assert.ok(pads.length >= 12);

  const p = game.addPlayer('Walker', null);
  const pad = pads[0];
  const dest = pads[pad.partner];
  p.state.px = pad.x; p.state.py = pad.y + 0.2; p.state.pz = pad.z;
  game.step();
  assert.ok(
    Math.hypot(p.state.px - dest.x, p.state.pz - dest.z) < 0.5,
    'human teleported to the partner pad',
  );
  // Arriving on the destination pad must not ping-pong straight back.
  for (let i = 0; i < 40; i++) game.step();
  assert.ok(
    Math.hypot(p.state.px - dest.x, p.state.pz - dest.z) < 0.5,
    'no immediate return teleport',
  );

  const bot = game.addPlayer('Robo', null, true);
  bot.state.px = pad.x; bot.state.py = pad.y + 0.2; bot.state.pz = pad.z;
  game.step();
  assert.ok(
    Math.hypot(bot.state.px - pad.x, bot.state.pz - pad.z) < 0.5,
    'bots never teleport',
  );
});

test('cave weapon stashes are scattered through the caverns, away from pads', () => {
  const game = new Game(1337, { teleporters: true });
  game.step();
  const weapons = [...game.pickups.values()].filter((pk) => pk.kind === PICKUP_WEAPON &&
    (pk.weapon === RAILGUN_ID || pk.weapon === NUKE_LAUNCHER_ID));
  assert.ok(weapons.filter((pk) => pk.weapon === RAILGUN_ID).length >= 8,
    'plenty of railgun stashes');
  assert.ok(weapons.filter((pk) => pk.weapon === NUKE_LAUNCHER_ID).length >= 8,
    'plenty of nuke stashes');
  const cavePads = game.teleporterPads.filter((pad) => pad.cave);
  const ammo = [...game.pickups.values()].filter((pk) => pk.kind === PICKUP_AMMO);
  const temples = game.world.collectJungleTemples().map(buildJungleTemplePlan);
  for (const pk of weapons) {
    const temple = temples.find(plan=>plan.loot.some(spot=>spot.weapon===pk.weapon&&Math.hypot(spot.x-pk.x,spot.z-pk.z)<.01));
    if(temple) {
      const spot=temple.loot.find(spot=>spot.weapon===pk.weapon&&Math.hypot(spot.x-pk.x,spot.z-pk.z)<.01)!;
      templeExitAccess(game.world,temple,spot);
      assert.ok(game.world.roofedAbove(pk.x,pk.y+1.2,pk.z),'temple exclusives remain underground');
      continue;
    }
    const column = game.world.column(pk.x, pk.z);
    // Overlapping entrances share a chamber. The most open branch selected
    // for shading need not be the walking route this stash was placed on.
    const cave = (column.caveBranches ?? (column.cave ? [column.cave] : []))
      .find(branch => branch.footprint > 0 && branch.forward >= 54 && Math.abs(branch.side) < 3.5);
    assert.ok(cave,
      'rare weapons must be on a chamber route connected to a walkable exit');
    assert.ok(Math.abs(pk.y - cave.floor) < 0.5, 'stash rests on the reachable chamber floor');
    assert.ok(game.world.roofedAbove(pk.x, pk.y + 1.2, pk.z),
      'every stash is genuinely underground');
    const nearPad = cavePads.some((pad) => Math.hypot(pk.x - pad.x, pk.z - pad.z) < 40);
    assert.ok(!nearPad, 'stashes are a hunt, not a vending machine beside the pad');
    const crate = ammo.some((a) =>
      a.weapon === pk.weapon && Math.hypot(a.x - pk.x, a.z - pk.z) < 6);
    assert.ok(crate, 'a matching ammo crate sits beside each stash');
  }
});

test('cave weapons cannot be selected until actually carried', () => {
  const state = createWeaponState();
  stepWeaponState(state, RAILGUN_ID, 0, 1 / 60);
  assert.equal(state.weapon, 0, 'an empty railgun slot refuses selection');
  state.ammo[RAILGUN_ID].magazine = 20;
  stepWeaponState(state, RAILGUN_ID, 0, 1 / 60);
  assert.equal(state.weapon, RAILGUN_ID, 'carried railgun selects normally');
});

test('a weapon pickup loads a full magazine', () => {
  const game = new Game(1337);
  const p = game.addPlayer('Loot', null);
  game.pickups.set(5001, {
    id: 5001, kind: PICKUP_WEAPON, weapon: RAILGUN_ID,
    x: p.state.px, y: p.state.py + 0.5, z: p.state.pz,
    availableAtTick: 0, expiresAtTick: Number.MAX_SAFE_INTEGER,
  });
  game.step();
  assert.equal(p.ammo[RAILGUN_ID].magazine, WEAPONS[RAILGUN_ID].magazineSize);
  assert.ok(!game.pickups.has(5001), 'pickup consumed');
});

test('railgun terrain miss plants a charge that later detonates', () => {
  const game = new Game(1337);
  const p = game.addPlayer('Rail', null);
  p.ammo[RAILGUN_ID].magazine = 5;
  // Hold fire aimed steeply down until the switch cooldown allows the shot.
  for (let t = 0; t < 40; t++) {
    game.queueInput(p, cmd(t + 1, BTN.FIRE, RAILGUN_ID, 0, -1.35));
    game.step();
    if ([...game.projectiles.values()].some((r) => r.weapon === RAIL_CHARGE.id)) break;
  }
  const charge = [...game.projectiles.values()].find((r) => r.weapon === RAIL_CHARGE.id);
  assert.ok(charge, 'terrain miss planted a rail charge');
  assert.equal(Math.hypot(charge.vx, charge.vy, charge.vz), 0, 'charge is stationary');

  // Stop firing (input starvation would otherwise repeat the FIRE command
  // and keep planting fresh charges), then let the fuse run out.
  game.queueInput(p, cmd(1000, 0, RAILGUN_ID, 0, -1.35));
  for (let i = 0; i < Math.ceil(3 * 60); i++) game.step();
  assert.ok(!game.projectiles.has(charge.id), 'charge detonated when its fuse expired');
});

test('nuke marker drops a falling bomb that detonates on the ground', () => {
  const game = new Game(1337);
  const p = game.addPlayer('Nuker', null);
  const gx = 50, gz = 50;
  const gy = game.world.groundY(gx, gz);
  game.projectiles.set(9100, {
    id: 9100, owner: p.id, weapon: NUKE_MARKER.id,
    x: gx, y: gy + 0.4, z: gz,
    vx: 0, vy: 0, vz: 0,
    distLeft: 50, fuseLeft: 0.05, ageSeconds: 0, sleeping: false,
  } as never);
  for (let i = 0; i < 5; i++) game.step();
  assert.ok(!game.projectiles.has(9100), 'marker retired at fuse expiry');
  const bomb = [...game.projectiles.values()].find((r) => r.weapon === NUKE_BOMB.id);
  assert.ok(bomb, 'bomb spawned');
  assert.ok(bomb.y > gy + 50, 'bomb falls from high above the marker');
  assert.ok(bomb.vy < 0, 'bomb is falling');

  let exploded = false;
  for (let i = 0; i < 10 * 60; i++) {
    game.step();
    if (![...game.projectiles.values()].some((r) => r.weapon === NUKE_BOMB.id)) {
      exploded = true;
      break;
    }
  }
  assert.ok(exploded, 'bomb reached the ground and detonated');
});

test('a nuke marked underground strikes the surface above, never fizzles in the cave', () => {
  const game = new Game(1337, { teleporters: true });
  const cavePad = game.teleporterPads.find((pad) => pad.cave);
  assert.ok(cavePad, 'seed 1337 generates cave pads');
  const p = game.addPlayer('Tunneler', null);
  game.projectiles.set(9200, {
    id: 9200, owner: p.id, weapon: NUKE_MARKER.id,
    x: cavePad.x, y: cavePad.y + 0.4, z: cavePad.z,
    vx: 0, vy: 0, vz: 0,
    distLeft: 50, fuseLeft: 0.05, ageSeconds: 0, sleeping: false,
  } as never);
  for (let i = 0; i < 5; i++) game.step();
  const bomb = [...game.projectiles.values()].find((r) => r.weapon === NUKE_BOMB.id);
  assert.ok(bomb, 'bomb spawned for the underground marker');
  const surfaceY = game.world.groundY(cavePad.x, cavePad.z);
  assert.ok(bomb.y > surfaceY + 100,
    'bomb falls from open sky above the surface, not inside the cave');
});
