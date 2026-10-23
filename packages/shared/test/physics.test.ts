import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, cavePathPoint } from '@shared/worldgen';
import {
  capsuleClearance, capsuleHasGroundSupport, collideCapsule, sphereFieldContact, type KinState,
} from '@shared/physics';
import { createMoveState, stepMove, BTN, type InputCmd } from '@shared/movement';
import { PLAYER, WORLD, TICK_DT } from '@shared/constants';
import { mulberry32 } from '@shared/rng';
import { quantYaw, unquantYaw, quantPitch, unquantPitch } from '@shared/math';

// THE test this rewrite exists for: whatever inputs are thrown at the
// controller, the capsule must never end up inside the world, never go NaN,
// and never tunnel out of the map.

function randomCmd(rng: () => number, seq: number): InputCmd {
  let buttons = 0;
  if (rng() < 0.75) buttons |= BTN.FORWARD;
  if (rng() < 0.2) buttons |= BTN.BACK;
  if (rng() < 0.3) buttons |= BTN.LEFT;
  if (rng() < 0.3) buttons |= BTN.RIGHT;
  if (rng() < 0.15) buttons |= BTN.JUMP;
  if (rng() < 0.05) buttons |= BTN.DODGE;
  return {
    seq,
    buttons,
    weapon: 0,
    yaw: unquantYaw(quantYaw(rng() * Math.PI * 2)),
    pitch: unquantPitch(quantPitch((rng() - 0.5) * 2)),
    renderTick: 0,
    renderFrac: 0,
  };
}

test('fuzz: players never fall through or escape the world', () => {
  for (const seed of [7, 1337, 424242]) {
    const world = new World(seed);
    const rng = mulberry32(seed * 31 + 1);

    for (let p = 0; p < 3; p++) {
      const spawn = world.findSpawn(rng);
      // Drop from high above to stress the landing path too.
      const s = createMoveState(spawn.x, spawn.y + 25 * rng(), spawn.z);
      let cmd = randomCmd(rng, 1);

      for (let tick = 0; tick < 1500; tick++) {
        if (tick % 7 === 0) cmd = randomCmd(rng, tick + 1);
        stepMove(world, s, cmd, TICK_DT);

        assert.ok(
          Number.isFinite(s.px) && Number.isFinite(s.py) && Number.isFinite(s.pz) &&
          Number.isFinite(s.vx) && Number.isFinite(s.vy) && Number.isFinite(s.vz),
          `NaN state at seed ${seed} tick ${tick}`,
        );
        const clearance = capsuleClearance(world, s.px, s.py, s.pz);
        assert.ok(
          clearance > -0.3,
          `capsule shell field ${clearance.toFixed(3)} at seed ${seed} tick ${tick} (${s.px.toFixed(1)}, ${s.py.toFixed(1)}, ${s.pz.toFixed(1)})`,
        );
        if (s.grounded) {
          assert.ok(
            capsuleHasGroundSupport(world, s.px, s.py, s.pz),
            `grounded without a real support crossing at seed ${seed} tick ${tick} ` +
            `(${s.px.toFixed(1)}, ${s.py.toFixed(1)}, ${s.pz.toFixed(1)})`,
          );
        }
        assert.ok(s.py > -60, `fell out of the world at seed ${seed} tick ${tick}: y=${s.py}`);
        assert.ok(Math.abs(s.px) < WORLD.BORDER && Math.abs(s.pz) < WORLD.BORDER, 'escaped the border');
      }
    }
  }
});

test('a capsule teleported inside solid rock is pushed back out', () => {
  const world = new World(1337);
  const rng = mulberry32(5);
  const spawn = world.findSpawn(rng);
  const s = createMoveState(spawn.x, spawn.y - 6, spawn.z); // buried 6m deep
  const idle: InputCmd = { seq: 1, buttons: 0, weapon: 0, yaw: 0, pitch: 0, renderTick: 0, renderFrac: 0 };
  for (let i = 0; i < 60; i++) stepMove(world, s, idle, TICK_DT);
  const clearance = capsuleClearance(world, s.px, s.py, s.pz);
  assert.ok(clearance > -0.05, `still buried after 60 ticks: clearance ${clearance.toFixed(3)}`);
});

test('a carved-away height minimum cannot act as invisible ground', () => {
  const world = new World(1337);
  const candidates = world.collectCaveSites(-960, 960, -960, 960)
    .map((site) => {
      const p = cavePathPoint(site, site.mouthLength - 3);
      return { ...p, h: world.terrainHeight(p.x, p.z), gy: world.groundY(p.x, p.z) };
    });
  const hole = candidates.find(({ x, z }) => {
    const col = world.column(x, z);
    return world.groundY(x, z) < col.h - 6;
  });
  assert.ok(hole, 'seed 1337 should retain a canonical entrance opening');

  // At the raw height this capsule shell is wholly in canonical air. The old
  // R-d collision nevertheless grounded it because y-h still equalled R.
  assert.ok(
    capsuleClearance(world, hole.x, hole.h, hole.z) > 0,
    'regression location must fit a capsule without solid shell overlap',
  );

  const s = createMoveState(hole.x, hole.h + 5, hole.z);
  const idle: InputCmd = {
    seq: 1, buttons: 0, weapon: 0, yaw: 0, pitch: 0, renderTick: 0, renderFrac: 0,
  };
  // The capsule must fall straight through the carved-away height surface
  // (never grounding at or near the phantom `h` level) and land only on the
  // real cavern floor far below, with sign-bracketed support throughout.
  let fellThrough = false;
  for (let i = 0; i < 300 && !s.grounded; i++) {
    stepMove(world, s, idle, TICK_DT);
    if (!s.grounded && s.py < hole.h - 2) fellThrough = true;
    if (s.grounded) {
      assert.ok(
        capsuleHasGroundSupport(world, s.px, s.py, s.pz),
        `tick ${i}: controller reported ghost support`,
      );
    }
  }
  assert.ok(fellThrough,
    `capsule never passed the removed surface: y=${s.py.toFixed(2)}, h=${hole.h.toFixed(2)}`);
  assert.ok(s.grounded, 'capsule should eventually reach real cavern terrain');
  assert.ok(
    Math.abs(s.py - hole.gy) < 0.12,
    `capsule stopped on removed height surface: y=${s.py.toFixed(2)}, h=${hole.h.toFixed(2)}`,
  );
  assert.ok(capsuleHasGroundSupport(world, s.px, s.py, s.pz), 'landing must have sign-bracketed support');
});

/**
 * Minimal World-shaped implicit used to exercise contact directions without
 * depending on a particular procedural cliff. Private World members make it
 * nominal, hence the explicit test-only cast.
 */
function planeWorld(
  field: (x: number, y: number, z: number) => number,
  normal: { x: number; y: number; z: number },
  onColumn?: () => void,
): World {
  const empty = {
    sites: [], pads: [], solids: [], cuts: [], boulders: [], vegetation: [],
  };
  return {
    column: () => {
      onColumn?.();
      return { h: 0, temp: 0, moist: 0, desert: 0, entr: 0, entrRaw: 0, volc: 0, lavaY: -1000 };
    },
    collectCityLifts: () => [],
    regionAt: () => empty,
    sdfCol: (x: number, y: number, z: number) => field(x, y, z),
    sdf: field,
    gradient: (
      _x: number, _y: number, _z: number,
      out: { x: number; y: number; z: number },
    ) => {
      out.x = normal.x;
      out.y = normal.y;
      out.z = normal.z;
    },
  } as unknown as World;
}

/**
 * Intersection of two air half-spaces whose outward normals oppose each
 * other slightly. Alternating projection converges, but resolving either face
 * exposes a shallower overlap with the other face.
 */
function creaseWorld(contactStarts: Array<{ x: number; z: number }>): World {
  const oppose = 0.8;
  const side = Math.sqrt(1 - oppose * oppose);
  const bias = 0.1;
  const distances = (x: number, z: number): readonly [number, number] => [
    x + bias,
    -oppose * x + side * z + bias,
  ];
  const field = (x: number, _y: number, z: number): number => {
    const d = distances(x, z);
    return Math.min(d[0], d[1]);
  };
  const empty = {
    sites: [], pads: [], solids: [], cuts: [], boulders: [], vegetation: [],
  };
  return {
    column: (x: number, z: number) => {
      contactStarts.push({ x, z });
      return { h: 0, temp: 0, moist: 0, desert: 0, entr: 0, entrRaw: 0, volc: 0, lavaY: -1000 };
    },
    regionAt: () => empty,
    sdfCol: (x: number, y: number, z: number) => field(x, y, z),
    sdf: field,
    gradient: (
      x: number, _y: number, z: number,
      out: { x: number; y: number; z: number },
    ) => {
      const d = distances(x, z);
      if (d[0] <= d[1]) {
        out.x = 1;
        out.y = 0;
        out.z = 0;
      } else {
        out.x = -oppose;
        out.y = 0;
        out.z = side;
      }
    },
  } as unknown as World;
}

function maskedShellWorld(): World {
  // Branch A has the lower raw center value, so it supplies the gradient, but
  // sits just outside the sphere. The differently-scaled branch B has a
  // larger raw center value while its actual surface cuts deeply into -Z.
  const distances = (x: number, z: number): readonly [number, number] => [
    0.1 * (x + 0.4257),
    0.2 * (z + 0.3),
  ];
  const field = (x: number, _y: number, z: number): number => {
    const d = distances(x, z);
    return Math.min(d[0], d[1]);
  };
  const empty = {
    sites: [], pads: [], solids: [], cuts: [], boulders: [], vegetation: [],
  };
  return {
    column: () => ({ h: 0, temp: 0, moist: 0, desert: 0, entr: 0, entrRaw: 0, volc: 0, lavaY: -1000 }),
    regionAt: () => empty,
    sdfCol: (x: number, y: number, z: number) => field(x, y, z),
    sdf: field,
    gradient: (
      x: number, _y: number, z: number,
      out: { x: number; y: number; z: number },
    ) => {
      const d = distances(x, z);
      out.x = d[0] <= d[1] ? 1 : 0;
      out.y = 0;
      out.z = d[0] <= d[1] ? 0 : 1;
    },
  } as unknown as World;
}

function sphereWorld(cx: number, cy: number, cz: number, radius: number): World {
  const field = (x: number, y: number, z: number): number =>
    Math.hypot(x - cx, y - cy, z - cz) - radius;
  const empty = {
    sites: [], pads: [], solids: [], cuts: [], boulders: [], vegetation: [],
  };
  return {
    column: () => ({ h: 0, temp: 0, moist: 0, desert: 0, entr: 0, entrRaw: 0, volc: 0, lavaY: -1000 }),
    regionAt: () => empty,
    sdfCol: (x: number, y: number, z: number) => field(x, y, z),
    sdf: field,
    gradient: (
      x: number, y: number, z: number,
      out: { x: number; y: number; z: number },
    ) => {
      const dx = x - cx, dy = y - cy, dz = z - cz;
      const n = Math.hypot(dx, dy, dz) || 1;
      out.x = dx / n;
      out.y = dy / n;
      out.z = dz / n;
    },
  } as unknown as World;
}

test('sign-validated capsule contact preserves walls and ceilings', () => {
  // Air is x<0; x>=0 is a solid vertical wall.
  const wall = planeWorld((x) => -x, { x: -1, y: 0, z: 0 });
  const ws: KinState = {
    px: -1, py: 4, pz: 0,
    vx: 12, vy: 0, vz: 0,
    grounded: false,
  };
  for (let i = 0; i < 8; i++) collideCapsule(wall, ws, TICK_DT, false);
  assert.ok(ws.px <= -PLAYER.RADIUS + 0.002, `passed through wall: x=${ws.px}`);
  assert.ok(ws.px > -PLAYER.RADIUS - 0.03, `wall left excessive gap: x=${ws.px}`);
  assert.ok(Math.abs(ws.vx) < 1e-6, `wall did not clip inward velocity: vx=${ws.vx}`);

  // Air is y<3; y>=3 is a solid ceiling.
  const ceiling = planeWorld((_x, y) => 3 - y, { x: 0, y: -1, z: 0 });
  const cs: KinState = {
    px: 0, py: 1, pz: 0,
    vx: 0, vy: 8, vz: 0,
    grounded: false,
  };
  for (let i = 0; i < 8; i++) collideCapsule(ceiling, cs, TICK_DT, false);
  assert.ok(cs.py + PLAYER.HEIGHT < 3, `passed through ceiling: top=${cs.py + PLAYER.HEIGHT}`);
  assert.ok(cs.py + PLAYER.HEIGHT > 3 - 0.03, `ceiling left excessive gap: top=${cs.py + PLAYER.HEIGHT}`);
  assert.ok(Math.abs(cs.vy) < 1e-6, `ceiling did not clip inward velocity: vy=${cs.vy}`);
});

test('capsule axis sampling closes the gaps between end and midpoint spheres', () => {
  // Axis levels from the old 3-sphere approximation were y=.42,.90,1.38.
  // This 0.6m obstacle intersects the continuous capsule at y=.66, but is
  // 2cm beyond the radius of both neighboring old samples.
  const obstacle = sphereWorld(0.70, 0.66, 0, 0.30);
  const s: KinState = {
    px: 0, py: 0, pz: 0,
    vx: 0, vy: 0, vz: 0,
    grounded: false,
  };
  collideCapsule(obstacle, s, 0, false);
  assert.ok(s.px < -0.02, `thin ledge remained inside capsule gap: x=${s.px}`);
  assert.ok(capsuleClearance(obstacle, s.px, s.py, s.pz) > -0.002);
});

test('non-metric center values cannot reject sampled-shell penetration', () => {
  const world = new World(1337);
  // Find real steep implicit ceilings, without tying this collision
  // regression to terrain coordinates that move whenever worldgen changes.
  const fixtures: number[][] = [];
  const rng = mulberry32(0x5ce111);
  for (let i = 0; i < 1000 && fixtures.length < 3; i++) {
    const x = (rng() - 0.5) * 4800, z = (rng() - 0.5) * 4800;
    const top = world.terrainHeight(x, z) - 2.5;
    for (let y = -40; y < top; y += 1) {
      if (world.sdf(x, y, z) <= 0 || world.sdf(x, y + 1, z) > 0) continue;
      let lo = y, hi = y + 1;
      for (let j = 0; j < 16; j++) {
        const mid = (lo + hi) * 0.5;
        if (world.sdf(x, mid, z) > 0) lo = mid; else hi = mid;
      }
      const py = hi - PLAYER.HEIGHT + 0.03;
      if (world.sdf(x, py + PLAYER.HEIGHT - PLAYER.RADIUS, z) <= PLAYER.RADIUS + 1.2) continue;
      if (capsuleClearance(world, x, py, z) >= 0) continue;
      fixtures.push([x, py, z]);
      break;
    }
  }
  assert.equal(fixtures.length, 3, 'expected three non-metric ceiling witnesses');
  for (const [px, py, pz] of fixtures) {
    const s: KinState = {
      px, py, pz,
      vx: 0, vy: 0, vz: 0,
      grounded: false,
    };
    const topAxisY = py + PLAYER.HEIGHT - PLAYER.RADIUS;
    assert.ok(
      world.sdf(px, topAxisY, pz) > PLAYER.RADIUS + 1.2,
      'fixture no longer exercises the non-metric broad-phase fallback',
    );
    const before = capsuleClearance(world, px, py, pz);
    assert.ok(before < 0, `fixture lost its shell penetration (${before})`);
    collideCapsule(world, s, 0, false);
    const after = capsuleClearance(world, s.px, s.py, s.pz);
    assert.ok(
      after >= -0.002,
      `center broad phase left shell penetration ${after.toFixed(5)} at ${px},${py},${pz}`,
    );
  }
});

test('a grazing gradient branch cannot mask a deeper shell contact', () => {
  const world = maskedShellWorld();
  const s: KinState = {
    px: 0, py: 0, pz: 0,
    vx: 0, vy: 0, vz: 0,
    grounded: false,
  };
  assert.ok(capsuleClearance(world, s.px, s.py, s.pz) < -0.02);
  collideCapsule(world, s, 0, false);
  assert.ok(s.pz > 0.1, `masked -Z contact did not push the capsule: z=${s.pz}`);
  assert.ok(capsuleClearance(world, s.px, s.py, s.pz) >= 0);
});

test('shell contact computes only the final winning surface normal', () => {
  let gradients=0;
  const world={
    sdf:(x:number,y:number,_z:number)=>Math.min(x+.4,y+.2),
    gradient(x:number,y:number,z:number,out:{x:number;y:number;z:number}){
      gradients++;
      // A CSG crease can point the initial gradient away from the shell's
      // overlapping faces; its fallback finds the side, then a nearer floor.
      if(x===0&&y===0&&z===0)Object.assign(out,{x:0,y:0,z:1});
      else Object.assign(out,x+.4<y+.2?{x:1,y:0,z:0}:{x:0,y:1,z:0});
    },
  } as World;
  const contact=sphereFieldContact(world,0,0,0,.5);
  assert.ok(contact);
  assert.equal(contact.depth,.506-.2001953125,'unchanged sign bisection selects the same floor contact');
  assert.deepEqual([contact.nx,contact.ny,contact.nz],[0,1,0]);
  assert.equal(gradients,2,'only the initial search direction and final winner need a gradient');
});

test('compound sign-surface contacts converge within one collision call', () => {
  // Resolving either face of this stable synthetic crease exposes the other.
  // The position observed at the fifth check is therefore the result of four
  // push-outs and proves a short recovery cap would leave sampled-shell
  // overlap. This acute version still overlaps after sixteen push-outs.
  const contactStarts: Array<{ x: number; z: number }> = [];
  const world = creaseWorld(contactStarts);
  const s: KinState = {
    px: 0, py: 0, pz: 0,
    vx: 0, vy: 0, vz: 0,
    grounded: false,
  };
  assert.ok(capsuleClearance(world, s.px, s.py, s.pz) < 0);
  collideCapsule(world, s, 0, false);
  assert.ok(contactStarts.length > 4, 'fixture must exercise the recovery tail');
  const afterFour = contactStarts[4];
  assert.ok(
    capsuleClearance(world, afterFour.x, 0, afterFour.z) < -0.002,
    'fixture no longer requires a fifth contact',
  );
  const afterSixteen = contactStarts[16];
  assert.ok(afterSixteen, 'fixture must exercise more than sixteen contacts');
  assert.ok(
    capsuleClearance(world, afterSixteen.x, 0, afterSixteen.z) < -0.01,
    'fixture no longer exercises the long recovery tail',
  );
  assert.ok(capsuleClearance(world, s.px, s.py, s.pz) >= -0.002);
});

test('fuzz: shallow sampled-shell overlaps resolve in one collision call', () => {
  let overlaps = 0;
  for (const seed of [7, 1337, 424242]) {
    const world = new World(seed);
    const rng = mulberry32(seed ^ 0xabc123);
    for (let i = 0; i < 500; i++) {
      const px = (rng() - 0.5) * 3000;
      const pz = (rng() - 0.5) * 3000;
      const py = world.column(px, pz).h - 1 + rng() * 3;
      const before = capsuleClearance(world, px, py, pz);
      if (before >= 0) continue;
      overlaps++;
      const s: KinState = {
        px, py, pz,
        vx: 0, vy: 0, vz: 0,
        grounded: false,
      };
      collideCapsule(world, s, 0, false);
      const after = capsuleClearance(world, s.px, s.py, s.pz);
      assert.ok(
        after > -0.01,
        `seed ${seed} left shell overlap ${after.toFixed(4)} from ${before.toFixed(4)} ` +
        `at ${px.toFixed(3)},${py.toFixed(3)},${pz.toFixed(3)}`,
      );
    }
  }
  assert.ok(overlaps > 300, `too few shallow overlaps exercised (${overlaps})`);
});

test('downhill snap keeps the capsule sphere clear of sloping ground', () => {
  for (const slope of [.57, .8, 1.1]) {
    const ny = 1 / Math.hypot(1, slope), horizontal = slope * ny / Math.SQRT2;
    for (const scale of [1, .2]) {
      const normal = { x: horizontal, y: ny, z: horizontal };
      const floor = planeWorld((x, y, z) => scale * (normal.x * x + normal.y * y + normal.z * z), normal);
      const state: KinState = { px: 0, py: .4, pz: 0, vx: 0, vy: 0, vz: 0, grounded: true };
      collideCapsule(floor, state, 0, true);
      assert.equal(state.grounded, true, 'a walkable descent retains ground support');
      assert.ok(state.py < .3, 'the test must exercise an actual downward snap');
      assert.ok(capsuleClearance(floor, state.px, state.py, state.pz) >= 0,
        `snap embedded the uphill capsule shell on slope ${slope}`);
      const normalDistance = normal.y * (state.py + PLAYER.RADIUS);
      assert.ok(normalDistance >= PLAYER.RADIUS, 'the entire bottom sphere stays outside the slope');
      assert.ok(normalDistance < PLAYER.RADIUS + .012, 'snapping leaves only the normal contact skin');
    }
  }
});

test('sampled-shell correctness fallback has bounded far-air query cost', () => {
  let fieldCalls = 0;
  const air = planeWorld(
    () => {
      fieldCalls++;
      return 100;
    },
    { x: 0, y: 1, z: 0 },
  );
  const s: KinState = {
    px: 0, py: 20, pz: 0,
    vx: 0, vy: 0, vz: 0,
    grounded: false,
  };
  collideCapsule(air, s, 0, false);
  // Five center samples + 5*14 shell samples + the downward support probe.
  // Keep this deterministic call-count guard instead of a flaky wall clock.
  assert.ok(fieldCalls <= 80, `far-air contact fallback used ${fieldCalls} field evaluations`);
});

test('ordinary grounded movement exits the compound-contact tail early', () => {
  let fieldCalls = 0;
  let contactChecks = 0;
  const floor = planeWorld(
    (_x, y) => {
      fieldCalls++;
      return y;
    },
    { x: 0, y: 1, z: 0 },
    () => {
      contactChecks++;
    },
  );
  const s = createMoveState(0, 0.006, 0);
  s.grounded = true;
  const forward: InputCmd = {
    seq: 1, buttons: BTN.FORWARD, weapon: 0, yaw: 0, pitch: 0, renderTick: 0, renderFrac: 0,
  };

  for (let tick = 0; tick < 30; tick++) {
    fieldCalls = 0;
    contactChecks = 0;
    stepMove(floor, s, forward, TICK_DT);
    assert.ok(s.grounded, `lost flat-floor support at tick ${tick}`);
    assert.ok(contactChecks <= 2, `grounded tick entered ${contactChecks} contact passes`);
    assert.ok(fieldCalls <= 125, `grounded tick used ${fieldCalls} field evaluations`);
  }
});

test('simulation is deterministic for identical inputs', () => {
  const run = (): number => {
    const world = new World(777);
    const rng = mulberry32(9);
    const spawn = world.findSpawn(rng);
    const s = createMoveState(spawn.x, spawn.y, spawn.z);
    const cmdRng = mulberry32(1234);
    let cmd = randomCmd(cmdRng, 1);
    for (let tick = 0; tick < 600; tick++) {
      if (tick % 5 === 0) cmd = randomCmd(cmdRng, tick);
      stepMove(world, s, cmd, TICK_DT);
    }
    return s.px + s.py * 1e3 + s.pz * 1e6;
  };
  assert.equal(run(), run());
});
