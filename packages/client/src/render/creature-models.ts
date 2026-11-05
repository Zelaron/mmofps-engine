import * as THREE from 'three';
import { CREATURE_DEFS } from '@shared/index';
import { CreatureGeometry, countershade, blendPaint, smooth01, smoothNoise, paintInto, type Paint, type Ring, type V3 } from './creature-geometry.js';
import type { CreatureRig, GaitRig, LegRig, HumanoidRig } from './creature-rigs.js';

/** Unlit glow (eyes, lures, embers) attached to one posed part instance. */
export interface GlowPoint { part: string; instance?: number; at: V3; size: V3; color: number; pulse?: number }
export interface SpeciesModel {
  rig: CreatureRig;
  parts: Record<string, THREE.BufferGeometry>;
  glow: GlowPoint[];
}

const look = (range: number, period: number, rate: number) => ({ range, period, rate });
const dead = (): [number, number] => [0, 0];
const build = (parts: Record<string, CreatureGeometry>) => Object.fromEntries(Object.entries(parts).map(([name, g]) => [name, g.build()]));
const sym = (side: number, p: V3): V3 => [side * p[0], p[1], p[2]];

// ---- Paint helpers --------------------------------------------------------------
/** Dark bands across the back and flanks (along Z), fading out under the belly. */
function stripes(base: Paint, dark: number, frequency: number, width = .3, axis: 'z' | 'y' = 'z'): Paint {
  const band = new THREE.Color(dark), tone = new THREE.Color();
  return (out, p, n) => {
    paintInto(out, base, p, n);
    const along = axis === 'z' ? p.z : p.y;
    const wave = Math.sin(along * frequency + smoothNoise(p.x * 6, p.y * 6, p.z * 6) * 2.2);
    const weight = smooth01(1 - width, 1 - width * .4, wave) * smooth01(-.45, .1, n.y);
    out.lerp(tone.copy(band), weight * .85);
  };
}
/** Patchy decay: noise-thresholded blotches of a second color. */
function blotches(base: Paint, spot: number, scale: number, threshold: number, amount = .8): Paint {
  const color = new THREE.Color(spot);
  return (out, p, n) => {
    paintInto(out, base, p, n);
    out.lerp(color, smooth01(threshold, threshold + .12, smoothNoise(p.x * scale + 3, p.y * scale, p.z * scale)) * amount);
  };
}
const darkTip = (base: Paint, dark: number, axis: (p: THREE.Vector3) => number, from: number, to: number) =>
  blendPaint(base, dark, p => smooth01(from, to, axis(p)));

// ---- Shape helpers --------------------------------------------------------------
/** Tapered limb segment running down local -Y with rounded joints. */
function limb(g: CreatureGeometry, length: number, widths: readonly number[], paint: Paint, depth = 1, segments = 7, top = .03,
  forward: readonly number[] = []): void {
  const rings: Ring[] = widths.map((w, i) => ({ p: [0, top - (length + top) * i / (widths.length - 1), -(forward[i] ?? 0)], w, h: w * depth }));
  g.loft(rings, paint, { segments, up: [0, 0, -1], capStart: widths[0] * .8, capEnd: widths[widths.length - 1] * .9, capSegments: 1 });
}
function eyes(g: CreatureGeometry, x: number, y: number, z: number, r: number, color: number, yaw = .4): void {
  for (let side = -1; side <= 1; side += 2) g.ellipsoid([side * x, y, z], [r * .75, r, r], color, [0, side * yaw, 0], 7, 5);
}
/** Leaf-shaped ear from base to tip, cupped toward `facing`. */
function ear(g: CreatureGeometry, base: V3, tip: V3, width: number, paint: Paint, facing: V3 = [0, 0, -1]): void {
  const mid: V3 = [base[0] * .45 + tip[0] * .55, base[1] * .45 + tip[1] * .55, base[2] * .45 + tip[2] * .55];
  g.loft([{ p: base, w: width * .7, h: width * .28 }, { p: mid, w: width, h: width * .3 }, { p: tip, w: width * .2, h: width * .12 }],
    paint, { segments: 6, up: facing, capStart: width * .2, capEnd: width * .25, capSegments: 0 });
}
function hoof(g: CreatureGeometry, ankle: number, width: number, skin: Paint, horn: number): void {
  g.loft([{ p: [0, .02, 0], w: width * .8, h: width * .85 }, { p: [0, -ankle * .5, -width * .45], w: width * .78, h: width * .8 }], skin,
    { segments: 7, capStart: width * .4, capSegments: 0 });
  // A vertical path keeps the hoof's sole ring level, so it rests exactly on the ground.
  g.loft([{ p: [0, -ankle * .5, -width * .55], w: width * .95, h: width * .85 }, { p: [0, -ankle + .004, -width * .55], w: width * 1.12, h: width * 1.15 }],
    horn, { segments: 8, capStart: width * .3, capEnd: .004, capSegments: 0 });
}
function paw(g: CreatureGeometry, ankle: number, size: number, fur: Paint, claw: number, toes = 4): void {
  g.loft([{ p: [0, .02, .01], w: size * .55, h: size * .55 }, { p: [0, -ankle * .55, -size * .25], w: size * .62, h: size * .6 }], fur,
    { segments: 7, capStart: size * .3, capSegments: 0 });
  g.ellipsoid([0, -ankle + size * .38, -size * .5], [size * .78, size * .4, size * .95], fur, [0, 0, 0], 8, 5);
  for (let i = 0; i < toes; i++) {
    const x = (i - (toes - 1) / 2) * size * .42;
    g.spike([[x, -ankle + size * .3, -size * 1.2], [x, -ankle + size * .14, -size * 1.42], [x, -ankle + .005, -size * 1.5]], size * .1, claw, 5, .1);
  }
}
function quill(g: CreatureGeometry, base: V3, direction: V3, length: number, radius: number, paint: Paint): void {
  const tip: V3 = [base[0] + direction[0] * length, base[1] + direction[1] * length, base[2] + direction[2] * length];
  const mid: V3 = [(base[0] + tip[0]) / 2, (base[1] + tip[1]) / 2 + length * .04, (base[2] + tip[2]) / 2];
  g.spike([base, mid, tip], radius, paint, 5, .08);
}

const gaitDefaults: GaitRig = {
  walkSpeed: .85, runSpeed: 4, walkStride: 1, runStride: 2.2, walkDuty: .62, runDuty: .34,
  walkLift: .08, runLift: .16, walkBob: .02, runBob: .06, walkPitch: .02, runPitch: .1,
  walkRoll: .02, runRoll: 0, sway: 0, runLean: .03,
};

/** Four legs: [LF, RF, LH, RH]; lateral-sequence walk, transverse gallop. */
function quadLegs(o: { frontHip: V3; hindHip: V3; frontFoot: [number, number]; hindFoot: [number, number];
  frontUpper: number; hindUpper: number; lower: number; ankle: number; frontThick?: number; hindThick?: number;
  run?: [number, number, number, number] }): LegRig[] {
  const run = o.run ?? [.55, .62, 0, .08], legs: LegRig[] = [];
  for (const front of [true, false]) for (let side = -1; side <= 1; side += 2) {
    const i = (front ? 0 : 2) + (side < 0 ? 0 : 1);
    legs.push({ hip: sym(side, front ? o.frontHip : o.hindHip), foot: [side * (front ? o.frontFoot : o.hindFoot)[0], (front ? o.frontFoot : o.hindFoot)[1]],
      upper: front ? o.frontUpper : o.hindUpper, lower: o.lower, ankle: o.ankle, hint: [0, 0, front ? -1 : 1],
      walk: [.25, .75, 0, .5][i], run: run[i], thick: front ? o.frontThick ?? 1 : o.hindThick ?? 1, limp: [-.45, -1, front ? -.35 : .4] });
  }
  return legs;
}
/** Six legs: [L1, R1, L2, R2, L3, R3]; metachronal walk blending into a tripod run. */
function hexLegs(o: { hips: readonly V3[]; feet: readonly [number, number][]; upper: number; lower: number; thick?: number[]; knee?: number; flip?: boolean }): LegRig[] {
  const walk = [.67, .17, .33, .83, 0, .5], run = [1, .5, .5, 1, 0, .5];
  return [0, 1, 2, 3, 4, 5].map(i => {
    const side = i % 2 ? 1 : -1, pair = i >> 1;
    return { hip: sym(side, o.hips[pair]), foot: [side * o.feet[pair][0], o.feet[pair][1]] as [number, number], upper: o.upper, lower: o.lower,
      ankle: 0, hint: [side * .55, o.knee ?? 1, (pair - 1) * .25], face: [side, 0, 0], walk: walk[i], run: run[i],
      thick: o.thick?.[pair] ?? 1, ...(o.flip ? { limp: [0, -.55, (pair - 1) * .3] as V3, limpOut: .4, limpReach: .55 }
        : { limp: [0, .02, (pair - 1) * .45] as V3, limpOut: 1, limpReach: .9 }) };
  });
}

// ---- 0 Ridge Grazer: slender ibex-like herbivore with ridged swept horns --------
function grazer(): SpeciesModel {
  const base = countershade(0x4b5638, 0x8a9a6c, 0xe6e2cc, .07, 7);
  // A gazelle-like dark flank band and a pale rump patch break the silhouette.
  const coat = blendPaint(blendPaint(base, 0x3d4530, (p, n) => smooth01(.7, .9, 1 - Math.abs(n.y + .05) * 3.2) * smooth01(.5, .2, Math.abs(p.z + .02)) * .85),
    0xe2dcc2, p => smooth01(.56, .66, p.z) * smooth01(-.14, -.02, p.y) * (1 - smooth01(.1, .2, p.y)) * .85);
  const body = new CreatureGeometry(), neck = new CreatureGeometry(), head = new CreatureGeometry(), tail = new CreatureGeometry();
  const upper = new CreatureGeometry(), lower = new CreatureGeometry(), foot = new CreatureGeometry();
  body.loft([
    { p: [0, .07, .63], w: .11, h: .11, hb: .12 },
    { p: [0, .07, .52], w: .19, h: .19, hb: .25 },
    { p: [0, .05, .34], w: .205, h: .19, hb: .26 },
    { p: [0, .04, .1], w: .215, h: .195, hb: .26 },
    { p: [0, .05, -.16], w: .225, h: .21, hb: .29 },
    { p: [0, .09, -.4], w: .2, h: .22, hb: .3 },
    { p: [0, .15, -.56], w: .13, h: .17, hb: .21 },
  ], coat, { segments: 14, capStart: .08, capEnd: .07, subdivide: 1 });
  neck.loft([
    { p: [0, 0, .07], w: .12, h: .16, hb: .17 },
    { p: [0, 0, -.1], w: .1, h: .125, hb: .145 },
    { p: [0, 0, -.27], w: .08, h: .095, hb: .1 },
    { p: [0, .005, -.43], w: .068, h: .08, hb: .082 },
  ], countershade(0x434c35, 0x8a9a6c, 0xe2dec6, .06, 8), { segments: 10, capEnd: .05 });
  const face = blendPaint(blendPaint(countershade(0x4e573d, 0x8d9b73, 0xddd8bf, .05, 10), 0xeee9d6,
    (p, n) => smooth01(-.24, -.32, p.z) * (n.y < .2 ? 1 : .55)), 0x343b2b, (p, n) => smooth01(.55, .9, n.y) * smooth01(-.05, -.2, p.z) * .7);
  head.loft([
    { p: [0, .02, .07], w: .062, h: .065, hb: .055 },
    { p: [0, .025, -.02], w: .088, h: .086, hb: .075 },
    { p: [0, .005, -.13], w: .08, h: .074, hb: .072 },
    { p: [0, -.02, -.24], w: .058, h: .058, hb: .06 },
    { p: [0, -.035, -.33], w: .049, h: .05, hb: .052 },
    { p: [0, -.04, -.372], w: .043, h: .04, hb: .044 },
  ], face, { segments: 12, capStart: .045, capEnd: .03 });
  head.ellipsoid([0, -.03, -.402], [.03, .02, .012], 0x1d1a15, [0, 0, 0], 7, 4);
  eyes(head, .072, .03, -.12, .021, 0x110e0b);
  for (let side = -1; side <= 1; side += 2) {
    ear(head, [side * .055, .07, .0], [side * .12, .16, .07], .045, countershade(0x4b5539, 0x8a9870, 0xd8ccb4, .03), [side * .3, .2, -1]);
    const horn = CreatureGeometry.curve([side * .038, .07, -.05], [side * .06, .34, -.02], [side * .1, .3, .3], 9);
    head.spike(horn, .03, darkTip(0xd2c39d, 0x5b5040, p => p.z, .12, .34), 7, .12, 7);
  }
  tail.loft([{ p: [0, 0, -.02], w: .035, h: .035 }, { p: [0, .005, .06], w: .042, h: .03 }, { p: [0, 0, .12], w: .03, h: .02 }],
    countershade(0x464f37, 0x87966d, 0xf0ece0, .04), { segments: 7, capStart: .02, capEnd: .04 });
  const leg = countershade(0x56623f, 0x7d8b63, 0xc4c1a2, .05, 12);
  // Thick muscular tops sit inside the body, so swinging legs stay attached.
  limb(upper, .38, [.088, .078, .058, .042, .037], leg, 1.25, 9, .08);
  limb(lower, .36, [.032, .028, .026, .027, .032], countershade(0x4f5a40, 0x6d7a58, 0x9a9c7e, .04), 1.1, 6);
  hoof(foot, .1, .036, 0x4d4a3a, 0x231f1a);
  return {
    rig: { kind: 'quadruped', scale: 1, gait: { ...gaitDefaults, walkStride: .95, runStride: 2.1 }, deathSeconds: .65, deadDrop: dead(),
      legs: quadLegs({ frontHip: [.1, -.08, -.38], hindHip: [.1, -.06, .44], frontFoot: [.12, -.37], hindFoot: [.12, .45],
        frontUpper: .35, hindUpper: .4, lower: .36, ankle: .1, frontThick: .9 }),
      look: look(.7, 3.2, 3), body: { y: .86, z: 0, breath: .012 }, neck: { at: [0, .15, -.5], pitch: .95, length: .43 },
      head: { pitch: -.62, alert: .3, grazes: true }, tail: { at: [0, .12, .62], pitch: 1.05, length: .2, segments: 2, alert: .9, run: .6 },
      crouch: .03 },
    parts: build({ body, neck, head, tail, upper, lower, foot }), glow: [],
  };
}

// ---- 1 Dune Stalker: striped sabre-fanged desert hunter --------------------------
function stalker(): SpeciesModel {
  const fur = stripes(countershade(0x5e3a1f, 0xb98650, 0xf0dcb6, .06, 8), 0x2e1b0f, 17, .36);
  const body = new CreatureGeometry(), neck = new CreatureGeometry(), head = new CreatureGeometry(), tail = new CreatureGeometry();
  const upper = new CreatureGeometry(), lower = new CreatureGeometry(), foot = new CreatureGeometry();
  body.loft([
    { p: [0, .05, .6], w: .11, h: .1, hb: .1 },
    { p: [0, .06, .47], w: .18, h: .16, hb: .21 },
    { p: [0, .07, .24], w: .18, h: .16, hb: .17 },
    { p: [0, .09, -.02], w: .21, h: .18, hb: .22 },
    { p: [0, .12, -.25], w: .235, h: .21, hb: .28 },
    { p: [0, .15, -.42], w: .22, h: .21, hb: .29 },
    { p: [0, .17, -.56], w: .15, h: .17, hb: .21 },
  ], fur, { segments: 14, capStart: .08, capEnd: .07, subdivide: 2 });
  const spine = countershade(0x2d2018, 0x3d2c20, 0x4a3727, .05);
  for (let i = 0; i < 7; i++) {
    const z = -.5 + i * .12, top = .15 + .2 + Math.cos(i * .3) * .02 - i * .012;
    quill(body, [0, top - .03, z], [0, .8, .6], .16 - i * .012, .035 - i * .002, spine);
  }
  neck.loft([{ p: [0, 0, .08], w: .14, h: .15, hb: .16 }, { p: [0, .01, -.08], w: .125, h: .125, hb: .14 }, { p: [0, .02, -.2], w: .11, h: .11, hb: .12 }],
    stripes(countershade(0x573519, 0xb07d48, 0xead2a8, .05), 0x2e1b0f, 17, .3), { segments: 10, capEnd: .06, subdivide: 1 });
  quill(neck, [0, .1, -.05], [0, .75, .65], .15, .032, spine);
  quill(neck, [0, .09, -.16], [0, .8, .6], .13, .03, spine);
  const face = blendPaint(blendPaint(stripes(countershade(0x6e4526, 0xb0804b, 0xead4ac, .05, 10), 0x3b2516, 30, .25), 0x2a1c14,
    (p, n) => smooth01(-.26, -.31, p.z) * smooth01(-.2, .3, n.y)), 0x1c130e, (p, n) => smooth01(.4, .8, -n.z) * smooth01(-.05, -.12, p.y) * .4);
  head.loft([
    { p: [0, .035, .07], w: .09, h: .085, hb: .08 },
    { p: [0, .04, -.02], w: .125, h: .105, hb: .1 },
    { p: [0, .025, -.13], w: .115, h: .085, hb: .095 },
    { p: [0, .005, -.23], w: .082, h: .068, hb: .075 },
    { p: [0, -.005, -.3], w: .066, h: .055, hb: .062 },
  ], face, { segments: 12, capStart: .05, capEnd: .03 });
  head.loft([{ p: [0, -.075, -.03], w: .095, h: .03 }, { p: [0, -.085, -.17], w: .07, h: .028 }, { p: [0, -.08, -.27], w: .05, h: .022 }],
    countershade(0x8a6038, 0xb88c5a, 0xe9d6b3, .04), { segments: 8, capStart: .03, capEnd: .02 });
  head.ellipsoid([0, -.005, -.322], [.03, .022, .014], 0x150f0b, [0, 0, 0], 7, 4);
  for (let side = -1; side <= 1; side += 2) {
    head.spike(CreatureGeometry.curve([side * .04, -.045, -.24], [side * .05, -.13, -.25], [side * .042, -.19, -.2], 6), .016,
      darkTip(0xf0e2bf, 0xb7a179, p => -p.y, .1, .19), 6, .1);
    ear(head, [side * .07, .1, .02], [side * .11, .19, .05], .05, countershade(0x3b2617, 0x8e6238, 0xd9b98c, .03), [side * .2, .1, -1]);
    head.ellipsoid([side * .068, .045, -.135], [.02, .018, .02], 0x170f09, [0, side * .5, 0], 7, 5);
  }
  tail.loft([{ p: [0, 0, -.02], w: .042, h: .042 }, { p: [0, 0, .1], w: .036, h: .036 }, { p: [0, 0, .22], w: .03, h: .03 }],
    stripes(countershade(0x573519, 0xa77847, 0xd9be92, .05), 0x2a190d, 26, .4), { segments: 6, capStart: .02, capEnd: .03 });
  limb(upper, .3, [.09, .08, .06, .047, .043], fur, 1.15, 9, .08);
  limb(lower, .28, [.042, .037, .034, .034, .038], countershade(0x6e4727, 0xa9794a, 0xd8bb92, .05), 1.05, 7);
  paw(foot, .075, .055, countershade(0x5e3d22, 0x9a6d42, 0xc4a174, .04), 0x1b130d);
  return {
    rig: { kind: 'quadruped', scale: 1, gait: { ...gaitDefaults, walkStride: .9, runStride: 2.3, runDuty: .3, runPitch: .15, walkLift: .07, runLift: .17,
      runBob: .07 }, deathSeconds: .6, deadDrop: dead(),
      legs: quadLegs({ frontHip: [.11, -.06, -.38], hindHip: [.1, -.05, .44], frontFoot: [.13, -.37], hindFoot: [.12, .45],
        frontUpper: .26, hindUpper: .32, lower: .28, ankle: .075, frontThick: 1.1, run: [.5, .6, 0, .1] }),
      look: look(.6, 2.6, 4), body: { y: .66, z: 0, breath: .014 }, neck: { at: [0, .2, -.5], pitch: .35, length: .2 },
      head: { pitch: -.18, alert: -.15 }, tail: { at: [0, .1, .6], pitch: .7, length: .66, segments: 3, alert: .1, run: .75 },
      crouch: .07, predator: true },
    parts: build({ body, neck, head, tail, upper, lower, foot }), glow: [
      { part: 'head', at: [-.074, .048, -.14], size: [.014, .012, .012], color: 0xffbe55 },
      { part: 'head', at: [.074, .048, -.14], size: [.014, .012, .012], color: 0xffbe55 }],
  };
}

// ---- 4 Bristleback: humped boar with tusks and a quill crest ---------------------
function bristleback(): SpeciesModel {
  const hide = blotches(countershade(0x3f352b, 0x76654f, 0x9f8f76, .1, 9), 0x2e2620, 5, .62, .6);
  const body = new CreatureGeometry(), neck = new CreatureGeometry(), head = new CreatureGeometry(), tail = new CreatureGeometry();
  const upper = new CreatureGeometry(), lower = new CreatureGeometry(), foot = new CreatureGeometry();
  body.loft([
    { p: [0, .05, .55], w: .16, h: .15, hb: .14 },
    { p: [0, .08, .4], w: .24, h: .21, hb: .21 },
    { p: [0, .1, .15], w: .28, h: .25, hb: .25 },
    { p: [0, .13, -.1], w: .3, h: .29, hb: .27 },
    { p: [0, .15, -.32], w: .28, h: .3, hb: .26 },
    { p: [0, .12, -.5], w: .2, h: .23, hb: .2 },
  ], hide, { segments: 14, capStart: .1, capEnd: .06, subdivide: 1 });
  const quills = darkTip(0x2f2720, 0xd3bf8f, p => p.y, .38, .52);
  for (let i = 0; i < 9; i++) for (let row = -1; row <= 1; row++) {
    if (row && i % 2) continue;
    const z = -.48 + i * .095, top = .15 + .3 - Math.pow((z + .3) * 1.1, 2) * .5;
    quill(body, [row * .07, top - .05, z], [row * .35, .85, .45], (.2 - Math.abs(i - 3) * .014) * (row ? .7 : 1), .028, quills);
  }
  neck.loft([{ p: [0, 0, .08], w: .2, h: .2, hb: .2 }, { p: [0, -.01, -.1], w: .19, h: .19, hb: .18 }], hide, { segments: 10, capEnd: .08 });
  const snout = blendPaint(countershade(0x3a3029, 0x6f604c, 0x8f7f69, .08, 10), 0x5b4038, p => smooth01(-.36, -.44, p.z));
  head.loft([
    { p: [0, .06, .08], w: .15, h: .15, hb: .14 },
    { p: [0, .04, -.07], w: .16, h: .15, hb: .13 },
    { p: [0, 0, -.22], w: .12, h: .11, hb: .1 },
    { p: [0, -.03, -.34], w: .09, h: .08, hb: .08 },
    { p: [0, -.04, -.43], w: .085, h: .072, hb: .075 },
  ], snout, { segments: 12, capStart: .06, capEnd: .015 });
  head.ellipsoid([0, -.04, -.448], [.075, .062, .012], 0x3a2421, [0, 0, 0], 9, 4);
  for (let side = -1; side <= 1; side += 2) {
    head.ellipsoid([side * .03, -.035, -.456], [.014, .02, .006], 0x120c0a, [0, 0, 0], 6, 3);
    head.spike(CreatureGeometry.curve([side * .07, -.07, -.3], [side * .14, -.06, -.36], [side * .14, .06, -.3], 7), .028,
      darkTip(0xece0bd, 0xb8a47c, p => p.y, -.02, .06), 6, .08);
    ear(head, [side * .1, .13, .03], [side * .17, .25, .09], .06, countershade(0x2f2721, 0x5e4f40, 0x8b7660, .05), [side * .3, .3, -1]);
    head.ellipsoid([side * .115, .065, -.15], [.016, .016, .016], 0x100b09, [0, side * .5, 0], 6, 4);
  }
  tail.loft([{ p: [0, 0, -.02], w: .03, h: .03 }, { p: [0, 0, .1], w: .022, h: .022 }], darkTip(hide, 0x2b231d, p => p.z, .02, .1),
    { segments: 6, capStart: .015, capEnd: .03 });
  limb(upper, .25, [.1, .09, .07, .056, .052], hide, 1.2, 9, .08);
  limb(lower, .22, [.05, .045, .041, .041, .046], countershade(0x3a3029, 0x5a4b3c, 0x7d6c58, .06), 1.1);
  hoof(foot, .08, .048, 0x3a3029, 0x1a1512);
  return {
    rig: { kind: 'quadruped', scale: 1, gait: { ...gaitDefaults, walkStride: .7, runStride: 1.5, walkDuty: .64, runDuty: .38, walkLift: .07, runLift: .12,
      walkBob: .018, runBob: .05, runPitch: .08 }, deathSeconds: .55, deadDrop: dead(),
      legs: quadLegs({ frontHip: [.15, -.1, -.33], hindHip: [.13, -.08, .39], frontFoot: [.17, -.32], hindFoot: [.15, .4],
        frontUpper: .22, hindUpper: .26, lower: .22, ankle: .08, frontThick: 1.1, run: [.5, 0, .02, .52] }),
      look: look(.45, 3.6, 2.5), body: { y: .6, z: 0, breath: .016 }, neck: { at: [0, .1, -.48], pitch: -.12, length: .15 },
      head: { pitch: -.32, alert: -.2 }, tail: { at: [0, .1, .55], pitch: .6, length: .2, segments: 2, alert: -.4, run: .3 },
      crouch: .05, predator: true },
    parts: build({ body, neck, head, tail, upper, lower, foot }), glow: [],
  };
}

// ---- 3 Crest Runner: flightless sprinting bird with a flame crest ----------------
function runner(): SpeciesModel {
  const plumage = countershade(0x2f5e61, 0x5f9a96, 0xd6e3d2, .06, 9);
  const body = new CreatureGeometry(), neck = new CreatureGeometry(), head = new CreatureGeometry(), tail = new CreatureGeometry();
  const upper = new CreatureGeometry(), lower = new CreatureGeometry(), foot = new CreatureGeometry();
  body.loft([
    { p: [0, .0, .44], w: .1, h: .08 },
    { p: [0, .01, .3], w: .21, h: .2, hb: .21 },
    { p: [0, .01, .06], w: .27, h: .26, hb: .3 },
    { p: [0, .03, -.18], w: .25, h: .26, hb: .29 },
    { p: [0, .08, -.33], w: .15, h: .16, hb: .17 },
  ], plumage, { segments: 14, capStart: .05, capEnd: .06, subdivide: 1 });
  const wing = countershade(0x1c3f42, 0x386a6c, 0x7fa69e, .05, 12);
  // Folded wings hug the flanks; dark primaries fan out over the rump.
  for (let side = -1; side <= 1; side += 2) {
    body.loft([{ p: [side * .2, .11, -.17], w: .11, h: .025 }, { p: [side * .27, .06, .04], w: .16, h: .035 }, { p: [side * .25, .03, .26], w: .13, h: .03 },
      { p: [side * .19, .0, .44], w: .05, h: .015 }], wing, { segments: 8, up: [side, 0, 0], capStart: .03, capEnd: .05, capSegments: 1, subdivide: 1 });
    for (let f = 0; f < 3; f++) quill(body, [side * .21, .06 - f * .045, .34], [side * .12, -.05 - f * .1, 1], .2 - f * .02, .028, darkTip(0x2b5357, 0x112426, p => p.z, .4, .52));
  }
  // Slim neck segments with fat rounded ends so the bend between them stays smooth.
  neck.loft([{ p: [0, 0, .04], w: .054, h: .058 }, { p: [0, 0, -.06], w: .048, h: .052 }, { p: [0, 0, -.18], w: .045, h: .049 },
    { p: [0, 0, -.235], w: .048, h: .051 }], countershade(0x6f9f97, 0x7cab9f, 0x8db7aa, .05), { segments: 9, capStart: .045, capEnd: .045 });
  head.loft([{ p: [0, .0, .05], w: .05, h: .05 }, { p: [0, .02, -.02], w: .072, h: .07, hb: .06 }, { p: [0, .015, -.09], w: .062, h: .06, hb: .05 },
    { p: [0, 0, -.13], w: .04, h: .04 }], countershade(0xa9b892, 0xd0d4af, 0xe8e6cf, .04), { segments: 10, capStart: .04, subdivide: 1 });
  head.loft([{ p: [0, -.005, -.12], w: .036, h: .034 }, { p: [0, -.02, -.21], w: .023, h: .021 }, { p: [0, -.035, -.29], w: .006, h: .006 }],
    darkTip(0xd09048, 0x7d4a1f, p => -p.z, .2, .29), { segments: 8, capEnd: .012, capSegments: 0 });
  eyes(head, .055, .035, -.055, .017, 0x0f1a19);
  for (let side = -1; side <= 1; side += 2) head.ellipsoid([side * .057, .035, -.055], [.008, .024, .024], 0xf1e1a8, [0, side * .4, 0], 6, 4);
  const crest = darkTip(0xe6bf6a, 0xc4412a, p => p.y, .14, .3);
  for (let i = 0; i < 6; i++) {
    const a = (i - 2.5) * .26;
    quill(head, [Math.sin(a) * .025, .07, -.03 + i * .014], [Math.sin(a) * .35, .9, .45 + i * .09], .24 - Math.abs(i - 2.5) * .03, .024, crest);
  }
  for (let i = 0; i < 5; i++) {
    const a = (i - 2) * .26;
    tail.loft([{ p: [Math.sin(a) * .02, 0, 0], w: .04, h: .014 }, { p: [Math.sin(a) * .15, .03, .2], w: .085, h: .014 },
      { p: [Math.sin(a) * .24, .05, .42], w: .05, h: .01 }], darkTip(0x2f6168, 0x0f2a2e, p => p.z, .25, .44),
    { segments: 6, up: [0, 1, 0], capStart: .01, capEnd: .05, capSegments: 0 });
  }
  // Feathered drumstick thighs taper into scaly shanks.
  limb(upper, .48, [.11, .095, .06, .036, .03], blendPaint(countershade(0x3c6c6c, 0x6a9a92, 0xb8c9b7, .05), 0xb9ad80, p => smooth01(-.3, -.38, p.y)), 1.2, 8, .08);
  limb(lower, .5, [.028, .026, .024, .024, .027], darkTip(0xc9b987, 0x8e7d55, p => -p.y, .3, .5), 1, 6);
  const scale = 0x8c7a52, claw = 0x2b241a;
  for (const toe of [-1, 0, 1]) foot.spike([[0, 0, 0], [toe * .05, -.03, -.08], [toe * .08, -.04, -.17]], .018, scale, 5, .3);
  for (const toe of [-1, 0, 1]) foot.spike([[toe * .08, -.035, -.16], [toe * .085, -.04, -.2]], .009, claw, 4, .1);
  foot.spike([[0, 0, 0], [0, -.03, .06]], .012, scale, 4, .3);
  return {
    rig: { kind: 'bird', scale: 1, gait: { ...gaitDefaults, walkSpeed: 1.35, runSpeed: 5.5, walkStride: 1.2, runStride: 3.1, walkDuty: .6, runDuty: .36,
      walkLift: .12, runLift: .3, walkBob: .025, runBob: .06, walkPitch: .02, runPitch: .03, walkRoll: .05, runRoll: .03, sway: .03, runLean: .32 },
    deathSeconds: .6, deadDrop: dead(), look: look(.9, 1.6, 10),
    legs: [-1, 1].map(side => ({ hip: [side * .12, -.15, .06] as V3, foot: [side * .13, .02] as [number, number], upper: .48, lower: .5, ankle: .045,
      hint: [0, 0, 1] as V3, walk: side < 0 ? 0 : .5, run: side < 0 ? 0 : .5, limp: [-.3, -1, .5] as V3 })),
    body: { y: 1.04, z: 0, pitch: .22, breath: .015 }, neck: { at: [0, .11, -.31], pitch: .62, length: .235, bend: .62, segments: 3 },
    head: { pitch: -.05 }, tail: { at: [0, .04, .36], pitch: -.35, length: .4 } },
    parts: build({ body, neck, head, tail, upper, lower, foot }), glow: [],
  };
}

// ---- 2 Cave Skitter: high-kneed cave spider with lantern eyes --------------------
function skitter(): SpeciesModel {
  const shell = countershade(0x26343d, 0x4d6470, 0x7b8f92, .08, 10);
  const body = new CreatureGeometry(), head = new CreatureGeometry(), abdomen = new CreatureGeometry();
  const upper = new CreatureGeometry(), lower = new CreatureGeometry();
  body.loft([{ p: [0, .02, .2], w: .12, h: .07 }, { p: [0, .03, .08], w: .22, h: .11, hb: .09 }, { p: [0, .03, -.08], w: .23, h: .12, hb: .09 },
    { p: [0, .02, -.22], w: .17, h: .09, hb: .08 }], shell, { segments: 14, capStart: .05, capEnd: .04 });
  for (let i = 0; i < 4; i++) body.ellipsoid([0, .13, -.12 + i * .08], [.05 - i * .006, .02, .035], 0x1c262d, [0, 0, 0], 7, 4);
  head.loft([{ p: [0, .01, .04], w: .14, h: .08, hb: .06 }, { p: [0, .02, -.06], w: .13, h: .085, hb: .07 }, { p: [0, 0, -.13], w: .09, h: .06, hb: .06 }],
    countershade(0x1f2a31, 0x3f525c, 0x627478, .06), { segments: 12, capStart: .03, capEnd: .04 });
  for (let side = -1; side <= 1; side += 2) {
    head.spike([[side * .04, -.03, -.13], [side * .05, -.1, -.17], [side * .025, -.17, -.14]], .028, darkTip(0xbfd3c5, 0x2b3a3b, p => -p.y, .1, .17), 6, .1);
    head.spike([[side * .08, -.01, -.1], [side * .13, -.02, -.2], [side * .12, -.1, -.26]], .018, shell, 5, .3);
  }
  const chevrons = blendPaint(countershade(0x1d272e, 0x3e535e, 0x5e6f73, .1, 8), 0xa9c7c0,
    (p, n) => smooth01(.55, .85, Math.sin(p.z * 24 - Math.abs(p.x) * 22)) * smooth01(.2, .6, n.y) * smooth01(.2, .1, Math.abs(p.x)));
  abdomen.loft([{ p: [0, 0, -.02], w: .12, h: .1 }, { p: [0, .06, .14], w: .27, h: .22, hb: .17 }, { p: [0, .07, .32], w: .28, h: .23, hb: .18 },
    { p: [0, .04, .5], w: .18, h: .15, hb: .12 }], chevrons, { segments: 16, capStart: .03, capEnd: .1, subdivide: 2 });
  abdomen.spike([[0, .02, .58], [0, .06, .68], [0, .14, .74]], .03, 0x8fb0b6, 5, .1);
  limb(upper, .42, [.045, .042, .036, .03], blendPaint(shell, 0x1a2329, p => smooth01(-.3, -.42, p.y)), 1, 7, .02);
  limb(lower, .56, [.032, .028, .022, .016, .006], stripes(countershade(0x2b3b44, 0x4f6672, 0x6b7f84, .05), 0x9ab7b4, 22, .18, 'y'), 1, 6, .02);
  const legs = hexLegs({ hips: [[.16, .0, -.13], [.2, 0, .0], [.17, .0, .13]], feet: [[.58, -.55], [.66, -.02], [.58, .5]], upper: .42, lower: .56, thick: [1, 1.05, 1], flip: true });
  const glow: SpeciesModel['glow'] = [];
  for (let side = -1; side <= 1; side += 2) for (let i = 0; i < 3; i++) glow.push({ part: 'head', at: [side * (.035 + i * .028), .07 - i * .012, -.1 + i * .035],
    size: [.018 - i * .003, .018 - i * .003, .018 - i * .003], color: 0x8ff0dc });
  return {
    rig: { kind: 'arthropod', scale: 1, gait: { ...gaitDefaults, walkStride: .55, runStride: 1.25, walkDuty: .6, runDuty: .46, walkLift: .1, runLift: .15,
      walkBob: .012, runBob: .025, walkRoll: .03, runRoll: .02, runLean: .05 }, deathSeconds: .5, deadDrop: dead(), look: look(.5, 1.8, 7), legs, flip: true,
    body: { y: .42, z: 0, breath: .02 }, head: { at: [0, .0, -.24], pitch: -.05 }, abdomen: { at: [0, .05, .18], pitch: -.12, bob: 1 } },
    parts: build({ body, head, abdomen, upper, lower }), glow,
  };
}

// ---- 5 Glow Beetle: domed jewel beetle with lantern spots -------------------------
function beetle(): SpeciesModel {
  const elytra = blendPaint(countershade(0x2d6d66, 0x5aa597, 0x23403f, .06, 6), 0x152625, p => smooth01(.022, .008, Math.abs(p.x)) * smooth01(-.16, -.1, p.z));
  const body = new CreatureGeometry(), head = new CreatureGeometry(), upper = new CreatureGeometry(), lower = new CreatureGeometry();
  body.loft([{ p: [0, .04, .38], w: .1, h: .07, hb: .05 }, { p: [0, .07, .26], w: .27, h: .21, hb: .09 }, { p: [0, .08, .06], w: .31, h: .26, hb: .1 },
    { p: [0, .07, -.12], w: .29, h: .23, hb: .1 }, { p: [0, .05, -.18], w: .25, h: .16, hb: .08 }], elytra, { segments: 18, capStart: .06, capEnd: .02, subdivide: 1 });
  body.loft([{ p: [0, .04, -.17], w: .22, h: .14, hb: .08 }, { p: [0, .04, -.27], w: .21, h: .13, hb: .08 }, { p: [0, .02, -.36], w: .15, h: .08, hb: .07 }],
    countershade(0x1b3236, 0x2f5157, 0x1a2a2c, .05), { segments: 12, capStart: .02, capEnd: .03 });
  body.loft([{ p: [0, -.02, .3], w: .14, h: .05 }, { p: [0, -.04, .06], w: .22, h: .06 }, { p: [0, -.03, -.2], w: .16, h: .05 }], 0xc9d27e,
    { segments: 10, capStart: .03, capEnd: .03 });
  head.loft([{ p: [0, 0, .03], w: .11, h: .08 }, { p: [0, -.005, -.06], w: .1, h: .07 }, { p: [0, -.02, -.12], w: .07, h: .05 }],
    countershade(0x152a2d, 0x2c4b50, 0x1f3335, .04), { segments: 10, capStart: .03, capEnd: .03 });
  const antenna = darkTip(0xbde4b0, 0x4f7a64, p => -p.z, .1, .4);
  for (let side = -1; side <= 1; side += 2) {
    head.spike(CreatureGeometry.curve([side * .05, .03, -.08], [side * .16, .25, -.2], [side * .26, .38, -.42], 8), .012, antenna, 5, .6);
    head.spike([[side * .04, -.03, -.12], [side * .05, -.05, -.18], [side * .015, -.06, -.21]], .02, 0x2b2620, 5, .1);
    head.ellipsoid([side * .085, .015, -.07], [.025, .03, .03], 0x0d1414, [0, 0, 0], 7, 4);
  }
  limb(upper, .2, [.035, .032, .028, .025], countershade(0x1d3134, 0x355a5c, 0x1d2d2e, .05), 1, 6, .02);
  limb(lower, .26, [.025, .022, .018, .013, .006], darkTip(0x2a4648, 0x101b1c, p => -p.y, .15, .26), 1, 6, .02);
  const legs = hexLegs({ hips: [[.14, -.05, -.22], [.17, -.05, -.04], [.15, -.05, .14]], feet: [[.36, -.42], [.42, -.04], [.37, .36]], upper: .2, lower: .26, knee: .8, flip: true });
  const glow: SpeciesModel['glow'] = [];
  for (let side = -1; side <= 1; side += 2) {
    // Lantern spots sit on the curved wing cases (surface y from the loft profile).
    for (let i = 0; i < 3; i++) {
      const z = -.06 + i * .12, x = side * (.1 + i * .035), shell = i === 0 ? .31 : i === 1 ? .3 : .25;
      glow.push({ part: 'body', at: [x, shell + .07 - Math.pow(Math.abs(x) / .3, 2) * .2, z], size: [.042 - i * .005, .022, .042 - i * .005], color: 0xd9f27a, pulse: 2.2 });
    }
    glow.push({ part: 'head', at: [side * .26, .38, -.42], size: [.03, .03, .03], color: 0xe9ffb7, pulse: 3 });
  }
  glow.push({ part: 'body', at: [0, -.03, .3], size: [.1, .04, .08], color: 0xf2e46c, pulse: 2.2 });
  return {
    rig: { kind: 'arthropod', scale: 1, gait: { ...gaitDefaults, walkSpeed: .45, runSpeed: 2.2, walkStride: .32, runStride: .7, walkDuty: .62, runDuty: .5,
      walkLift: .05, runLift: .08, walkBob: .008, runBob: .015, walkRoll: .03, runRoll: .02, runLean: 0 }, deathSeconds: .5, deadDrop: dead(),
    look: look(.4, 2.4, 3), legs, flip: true, body: { y: .27, z: 0, breath: .015 }, head: { at: [0, .03, -.36], pitch: .05 } },
    parts: build({ body, head, upper, lower }), glow,
  };
}

// ---- Humanoid undead and colossi -------------------------------------------------
interface Undead {
  skin: [number, number, number]; cloth: number; clothDark: number; eye: number;
  hip: number; waist: number; chest: number; depth: number; shoulder: number; torso: number; belly: number;
  head: number; jawDrop: number; arm: [number, number]; armThick: number; hand: number; claw: number;
  leg: [number, number]; legThick: number; foot: number; pelvisY: number;
  shirt: number; trousers: number; bone?: boolean; rock?: boolean; ribs?: boolean; hair?: number;
}
function undeadParts(u: Undead) {
  const skin = countershade(u.skin[0], u.skin[1], u.skin[2], .1, 9);
  const rotten = blotches(skin, u.skin[0], 7, .64, .7);
  const ribbed = u.ribs ? stripes(rotten, u.skin[0], 70, .28, 'y') : rotten;
  const rag = blotches(countershade(u.clothDark, u.cloth, u.cloth, .12, 14), u.clothDark, 11, .6, .8);
  // Torn cloth: noise-jagged hems and holes that expose the body underneath.
  const torn = (under: Paint, from: number, to: number) => blendPaint(under, rag, p => {
    const noise = smoothNoise(p.x * 16, p.y * 16, p.z * 16);
    return (p.y > from + noise * .1 && p.y < to - noise * .06 ? 1 : 0) * (noise > .74 ? 0 : 1);
  });
  const pelvis = new CreatureGeometry(), torso = new CreatureGeometry(), head = new CreatureGeometry();
  const arm = new CreatureGeometry(), forearm = new CreatureGeometry(), upper = new CreatureGeometry(), lower = new CreatureGeometry(), foot = new CreatureGeometry();
  pelvis.loft([{ p: [0, -.09, 0], w: u.hip * .9, h: u.depth * .8 }, { p: [0, .02, 0], w: u.hip, h: u.depth * .95 }, { p: [0, .11, 0], w: u.waist, h: u.depth * .85 }],
    u.trousers ? rag : rotten, { segments: 12, up: [0, 0, -1], capStart: .05, capEnd: .04, capSegments: 1 });
  // Ragged loincloth/coat tail hanging from the belt.
  pelvis.loft([{ p: [0, .08, 0], w: u.hip * 1.08, h: u.depth * 1.02 }, { p: [0, -.08, .01], w: u.hip * 1.12, h: u.depth * 1.06 },
    { p: [0, -.24, .02], w: u.hip * 1.12, h: u.depth * 1.05 }], rag, { segments: 14, up: [0, 0, -1], capStart: .02, capEnd: 0,
    displace: (ring, index, v, rings) => { if (ring === rings - 1) v.y += .07 - smoothNoise(index * 1.7, 3, 1) * .2 - (index % 3 === 0 ? .06 : 0); } });
  const L = u.torso;
  torso.loft([
    { p: [0, -.02, 0], w: u.waist, h: u.depth * .85, hb: u.depth * .8 },
    { p: [0, L * .25, -.01 - u.belly * .4], w: u.waist * 1.06 + u.belly * .4, h: u.depth * (1 + u.belly * 1.6), hb: u.depth * .85 },
    { p: [0, L * .55, 0], w: u.chest, h: u.depth * 1.05, hb: u.depth * .95 },
    { p: [0, L * .8, .01], w: u.shoulder * .92, h: u.depth * .95, hb: u.depth * .98 },
    { p: [0, L * .95, .025], w: u.shoulder * .62, h: u.depth * .7, hb: u.depth * .8 },
    { p: [0, L * 1.06, .02], w: u.head * .3, h: u.head * .3 },
  ], torn(ribbed, L * u.shirt, L * .93), { segments: 14, up: [0, 0, -1], capStart: .03, capEnd: .04, capSegments: 1, subdivide: 1 });
  for (let side = -1; side <= 1; side += 2) torso.ellipsoid([side * u.shoulder * .9, L * .86, .015], [u.armThick * 1.25, u.armThick * 1.1, u.armThick * 1.25],
    torn(rotten, L * u.shirt, L * .9), [0, 0, side * .3], 9, 6);
  const H = u.head;
  // Gaunt skull: sunken sockets, a slack jaw and patchy hair.
  const scalp = u.hair;
  const face = blendPaint(countershade(u.skin[0], u.skin[1], u.skin[2], .12, 12), scalp ?? u.skin[0], (p, n) => scalp === undefined ? 0
    : smooth01(H * .72, H * .9, p.y + n.z * H * .25) * (smoothNoise(p.x * 40, p.y * 40, p.z * 40) > .32 ? 1 : .15));
  head.loft([
    { p: [0, -.01, .005], w: H * .3, h: H * .3, hb: H * .3 },
    { p: [0, H * .28, -H * .05], w: H * .39, h: H * .5, hb: H * .42 },
    { p: [0, H * .6, -H * .02], w: H * .46, h: H * .55, hb: H * .56 },
    { p: [0, H * .92, 0], w: H * .44, h: H * .48, hb: H * .56 },
    { p: [0, H * 1.14, .01], w: H * .3, h: H * .3, hb: H * .38 },
  ], face, { segments: 12, up: [0, 0, -1], capEnd: H * .16, subdivide: 1 });
  head.loft([{ p: [0, H * .3, -H * .25], w: H * .38, h: H * .1 }, { p: [0, H * .18 - u.jawDrop, -H * .45], w: H * .3, h: H * .09 },
    { p: [0, H * .12 - u.jawDrop * 1.2, -H * .55], w: H * .18, h: H * .07 }], countershade(u.skin[0], u.skin[1], u.skin[2], .1),
  { segments: 9, capStart: H * .08, capEnd: H * .06 });
  head.ellipsoid([0, H * .3 - u.jawDrop * .5, -H * .5], [H * .22, H * .07 + u.jawDrop * .4, H * .07], 0x0c0807, [0, 0, 0], 8, 5);
  head.ellipsoid([0, H * .46, -H * .57], [H * .07, H * .08, H * .04], 0x120d0b, [0, 0, 0], 6, 4);
  for (let side = -1; side <= 1; side += 2) head.ellipsoid([side * H * .2, H * .62, -H * .5], [H * .12, H * .1, H * .08], 0x090605, [0, side * .3, 0], 8, 5);
  limb(arm, u.arm[0], [u.armThick, u.armThick * .9, u.armThick * .78, u.armThick * .72], torn(rotten, -.12, .2), 1, 8);
  limb(forearm, u.arm[1], [u.armThick * .78, u.armThick * .72, u.armThick * .6, u.armThick * .52], ribbed, 1, 8);
  // Hand: a flat palm and splayed clawed fingers below the wrist.
  const handTop = -u.arm[1];
  forearm.loft([{ p: [0, handTop + .01, 0], w: u.hand * .55, h: u.hand * .28 }, { p: [0, handTop - u.hand * .7, -.01], w: u.hand * .62, h: u.hand * .25 }],
    rotten, { segments: 8, up: [0, 0, -1], capStart: .01, capEnd: u.hand * .1, capSegments: 0 });
  for (let f = 0; f < 4; f++) {
    const x = (f - 1.5) * u.hand * .32;
    forearm.spike([[x, handTop - u.hand * .6, -.01], [x * 1.25, handTop - u.hand * 1.15, -u.hand * .25], [x * 1.3, handTop - u.hand * (1.45 + u.claw), -u.hand * .55]],
      u.hand * .11, darkTip(u.skin[1], 0x1a1612, p => -p.y, -handTop + u.hand * 1.1, -handTop + u.hand * 1.4), 5, .15);
  }
  forearm.spike([[u.hand * .3, handTop - u.hand * .2, -.02], [u.hand * .5, handTop - u.hand * .6, -u.hand * .4]], u.hand * .1, rotten, 5, .2);
  limb(upper, u.leg[0], [u.legThick, u.legThick * .95, u.legThick * .8, u.legThick * .7, u.legThick * .68], u.trousers ? rag : rotten, 1.05, 9);
  limb(lower, u.leg[1], [u.legThick * .72, u.legThick * .76, u.legThick * .58, u.legThick * .5, u.legThick * .55],
    torn(ribbed, -u.leg[1] * u.trousers, .1), 1.05, 8);
  // Flat-soled foot: a level loft whose underside sits exactly one ankle height below the joint.
  const ankle = u.foot * .38;
  foot.loft([{ p: [0, -ankle * .45, .05], w: u.legThick * .5, h: ankle * .55 }, { p: [0, -ankle * .5, -u.foot * .15], w: u.legThick * .6, h: ankle * .5 },
    { p: [0, -ankle * .55, -u.foot * .55], w: u.legThick * .58, h: ankle * .45 }], blotches(rotten, 0x231d18, 9, .5), { segments: 9, capStart: .03, capEnd: u.foot * .15 });
  return { pelvis, torso, head, arm, forearm, upper, lower, foot };
}
function undeadRig(u: Undead, scale: number, extra: Partial<HumanoidRig> & Pick<HumanoidRig, 'style' | 'gait'>): HumanoidRig {
  return {
    kind: 'humanoid', scale, deathSeconds: .7, deadDrop: dead(), look: look(.5, 2.8, 3),
    legs: [-1, 1].map(side => ({ hip: [side * u.hip * .55, -.04, 0] as V3, foot: [side * u.hip * .62, .02] as [number, number], upper: u.leg[0], lower: u.leg[1],
      ankle: u.foot * .38, hint: [0, 0, -1] as V3, walk: side < 0 ? 0 : .5, run: side < 0 ? 0 : .5, thick: 1, limp: [0, -1, .12] as V3, limpOut: .25, limpReach: .95 })),
    pelvis: { y: u.pelvisY, lean: 0, breath: .018 }, torso: { at: [0, .1, 0], lean: .2, length: u.torso }, head: { at: [0, u.torso * 1.02, .02], pitch: 0, roll: 0 },
    arms: { at: [u.shoulder * .92, u.torso * .86, .02], upper: u.arm[0], lower: u.arm[1], reach: .2, hang: .25, swing: .4, asymmetry: 0, spread: .12 },
    windupLift: 0, ...extra,
  };
}
function shambler(): SpeciesModel {
  const u: Undead = { skin: [0x6a735a, 0x9aa384, 0xb4b79a], cloth: 0x56604c, clothDark: 0x2c3227, eye: 0xf3d36b, hip: .16, waist: .14, chest: .2,
    depth: .13, shoulder: .23, torso: .56, belly: 0, head: .2, jawDrop: .05, arm: [.31, .3], armThick: .05, hand: .09, claw: .1,
    leg: [.46, .45], legThick: .075, foot: .21, pelvisY: .92, shirt: .1, trousers: .55, ribs: true, hair: 0x2a2620 };
  const p = undeadParts(u);
  return { rig: undeadRig(u, 1, { style: 'shamble', gait: { ...gaitDefaults, walkSpeed: .85, runSpeed: 2.6, walkStride: 1, runStride: 1.4, walkDuty: .66,
    runDuty: .58, walkLift: .05, runLift: .09, walkBob: .03, runBob: .045, walkRoll: .05, runRoll: .06, sway: .03, runLean: .1 },
  torso: { at: [0, .1, 0], lean: .38, length: u.torso }, head: { at: [0, u.torso * 1.02, .02], pitch: .2, roll: .15 },
  arms: { at: [u.shoulder * .92, u.torso * .86, .02], upper: u.arm[0], lower: u.arm[1], reach: .95, hang: .3, swing: .12, asymmetry: -.45, spread: .1 } }),
  parts: build(p), glow: eyesGlow(u, .6) };
}
function revenant(): SpeciesModel {
  const u: Undead = { skin: [0x4e4256, 0x7c6a86, 0x9a8aa0], cloth: 0x4a4250, clothDark: 0x221d26, eye: 0xff5a4a, hip: .14, waist: .12, chest: .165,
    depth: .11, shoulder: .2, torso: .55, belly: 0, head: .19, jawDrop: .07, arm: [.34, .34], armThick: .045, hand: .1, claw: .35,
    leg: [.48, .47], legThick: .066, foot: .21, pelvisY: .9, shirt: .45, trousers: .35, ribs: true, hair: 0x1b1720 };
  const p = undeadParts(u);
  return { rig: undeadRig(u, .86, { style: 'sprint', gait: { ...gaitDefaults, walkSpeed: .85, runSpeed: 5.5, walkStride: 1, runStride: 2.6, walkDuty: .64,
    runDuty: .36, walkLift: .07, runLift: .34, walkBob: .025, runBob: .05, walkRoll: .03, runRoll: .02, sway: .02, runLean: .5, kick: 1 },
  torso: { at: [0, .1, 0], lean: .25, length: u.torso }, head: { at: [0, u.torso * 1.02, .02], pitch: .12, roll: 0 },
  arms: { at: [u.shoulder * .92, u.torso * .86, .02], upper: u.arm[0], lower: u.arm[1], reach: .3, hang: .45, swing: .6, asymmetry: 0, spread: .18 } }),
  parts: build(p), glow: eyesGlow(u, .55) };
}
function brute(): SpeciesModel {
  const u: Undead = { skin: [0x46573f, 0x75896a, 0x93a383], cloth: 0x4e5640, clothDark: 0x262b20, eye: 0xc8ff6a, hip: .21, waist: .22, chest: .3,
    depth: .2, shoulder: .34, torso: .62, belly: .12, head: .17, jawDrop: .05, arm: [.42, .46], armThick: .1, hand: .15, claw: .12,
    leg: [.36, .36], legThick: .115, foot: .25, pelvisY: .74, shirt: .72, trousers: .3 };
  const p = undeadParts(u);
  // Hunched back plates and bone spurs; glowing plague boils on the belly.
  for (let i = 0; i < 4; i++) quill(p.torso, [(i % 2 ? .08 : -.08), u.torso * (.55 + i * .1), u.depth * .7], [i % 2 ? .3 : -.3, .6, .8], .14, .035, 0xd6cdb0);
  for (let i = 0; i < 5; i++) p.torso.ellipsoid([Math.sin(i * 2.3) * .14, u.torso * (.18 + (i % 3) * .12), -u.depth * 1.12 - .02], [.035, .035, .03], 0x9fbf55, [0, 0, 0], 7, 5);
  const glow = eyesGlow(u, .6);
  for (let i = 0; i < 3; i++) glow.push({ part: 'torso', at: [Math.sin(i * 2.3) * .14, u.torso * (.18 + (i % 3) * .12), -u.depth * 1.12 - .045], size: [.025, .025, .02],
    color: 0xb9f05a, pulse: 1.4 });
  return { rig: undeadRig(u, 1.5, { style: 'brute', gait: { ...gaitDefaults, walkSpeed: .6, runSpeed: 2, walkStride: .9, runStride: 1.25, walkDuty: .64,
    runDuty: .55, walkLift: .07, runLift: .11, walkBob: .03, runBob: .05, walkRoll: .05, runRoll: .06, sway: .05, runLean: .15 },
  torso: { at: [0, .1, 0], lean: .3, length: u.torso }, head: { at: [0, u.torso * .96, -.04], pitch: .3, roll: 0 },
  arms: { at: [u.shoulder * .95, u.torso * .82, .02], upper: u.arm[0], lower: u.arm[1], reach: .25, hang: .3, swing: .35, asymmetry: 0, spread: .22 },
  windupLift: 2.7 }), parts: build(p), glow };
}
function titan(): SpeciesModel {
  const u: Undead = { skin: [0x8f856b, 0xcdc3a5, 0xe2d9bd], cloth: 0x3d3a35, clothDark: 0x1d1b19, eye: 0x9df7ff, hip: .15, waist: .075, chest: .11,
    depth: .075, shoulder: .25, torso: .62, belly: 0, head: .22, jawDrop: .09, arm: [.4, .42], armThick: .045, hand: .14, claw: .3,
    leg: [.5, .5], legThick: .055, foot: .23, pelvisY: .98, shirt: 1.2, trousers: 0, bone: true, ribs: true };
  const p = undeadParts(u);
  const bone = countershade(0x9b9174, 0xd3c9ab, 0xe8dfc3, .1, 8);
  // Open rib cage, spine ridge and a crown of bone spikes.
  for (let rib = 0; rib < 5; rib++) for (let side = -1; side <= 1; side += 2) {
    const y = u.torso * (.36 + rib * .11), w = .2 * (1.12 - Math.abs(rib - 2) * .07);
    p.torso.spike(CreatureGeometry.curve([side * .02, y + .03, u.depth * .9], [side * w * 1.2, y + .01, .02], [side * .04, y - .06, -.16], 8), .021, bone, 5, .55);
  }
  for (let i = 0; i < 6; i++) quill(p.torso, [0, u.torso * (.25 + i * .13), u.depth * .9], [0, .3, 1], .12, .03, bone);
  for (let i = 0; i < 7; i++) {
    const a = (i - 3) * .42;
    quill(p.head, [Math.sin(a) * u.head * .55, u.head * 1.05, Math.cos(a) * u.head * .2 + .02], [Math.sin(a) * .6, 1, .35], .2 - Math.abs(i - 3) * .025, .028,
      darkTip(0xd8cfb2, 0x5c5444, q => q.y, u.head * 1.25, u.head * 2.1));
  }
  for (let side = -1; side <= 1; side += 2) quill(p.torso, [side * u.shoulder * .9, u.torso * .95, 0], [side * .5, 1, .2], .2, .04, bone);
  const glow = eyesGlow(u, .7);
  glow.push({ part: 'torso', at: [0, u.torso * .6, -.01], size: [.07, .08, .06], color: 0x6fe8d0, pulse: 1.2 });
  return { rig: undeadRig(u, 5.3, { style: 'giant', deathSeconds: .8, gait: { ...gaitDefaults, walkSpeed: .4, runSpeed: 1.6, walkStride: 1, runStride: 1.5,
    walkDuty: .64, runDuty: .52, walkLift: .1, runLift: .16, walkBob: .025, runBob: .04, walkRoll: .04, runRoll: .05, sway: .04, runLean: .12 },
  torso: { at: [0, .1, 0], lean: .18, length: u.torso }, head: { at: [0, u.torso * 1.02, .02], pitch: .1, roll: 0 },
  arms: { at: [u.shoulder * .92, u.torso * .86, .02], upper: u.arm[0], lower: u.arm[1], reach: .3, hang: .35, swing: .3, asymmetry: 0, spread: .2 },
  windupLift: 2.6 }), parts: build(p), glow };
}
function colossus(): SpeciesModel {
  const u: Undead = { skin: [0x2c2522, 0x4f4640, 0x5e544c], cloth: 0x3a302b, clothDark: 0x1a1513, eye: 0xff7a24, hip: .21, waist: .19, chest: .29,
    depth: .19, shoulder: .34, torso: .62, belly: 0, head: .18, jawDrop: .03, arm: [.42, .44], armThick: .095, hand: .16, claw: .05,
    leg: [.44, .44], legThick: .11, foot: .26, pelvisY: .9, shirt: 1.2, trousers: 0, rock: true };
  const p = undeadParts(u);
  // Basalt plates with ember fissures; horns and shoulder crags.
  const ember = 0xff8a2e, crag = countershade(0x241e1b, 0x463d37, 0x52463d, .14, 7);
  for (let side = -1; side <= 1; side += 2) {
    p.head.spike(CreatureGeometry.curve([side * u.head * .5, u.head * .95, 0], [side * u.head * 1.4, u.head * 1.3, .05], [side * u.head * 1.5, u.head * 2.1, -.05], 7),
      .045, darkTip(0x3a302a, 0xd36a2a, q => q.y, u.head * 1.4, u.head * 2.1), 6, .1);
    for (let i = 0; i < 3; i++) quill(p.torso, [side * (u.shoulder * .7 + i * .04), u.torso * (.9 - i * .05), .03 * i], [side * .7, .9, .2 + i * .2], .16 - i * .03, .06, crag);
  }
  for (let i = 0; i < 6; i++) p.torso.ellipsoid([Math.sin(i * 1.9) * .15, u.torso * (.2 + i * .12), -u.depth - .01], [.05, .012, .02], ember, [0, 0, Math.sin(i) * .8], 7, 4);
  const glow = eyesGlow(u, .75);
  glow.push({ part: 'torso', at: [0, u.torso * .55, -u.depth * .95], size: [.08, .1, .04], color: 0xff7a24, pulse: 1.6 });
  for (let side = 0; side < 2; side++) glow.push({ part: 'forearm', instance: side, at: [0, -u.arm[1] - .05, -.02], size: [.06, .05, .05], color: 0xff6a1a, pulse: 2 });
  return { rig: undeadRig(u, 6, { style: 'giant', deathSeconds: .8, gait: { ...gaitDefaults, walkSpeed: .4, runSpeed: 1.6, walkStride: .95, runStride: 1.4,
    walkDuty: .65, runDuty: .54, walkLift: .09, runLift: .14, walkBob: .025, runBob: .04, walkRoll: .04, runRoll: .05, sway: .05, runLean: .12 },
  torso: { at: [0, .1, 0], lean: .2, length: u.torso }, head: { at: [0, u.torso * .98, -.02], pitch: .2, roll: 0 },
  arms: { at: [u.shoulder * .95, u.torso * .84, .02], upper: u.arm[0], lower: u.arm[1], reach: .25, hang: .3, swing: .3, asymmetry: 0, spread: .25 },
  windupLift: 2.6 }), parts: build(p), glow };
}
function eyesGlow(u: Undead, size: number): GlowPoint[] {
  return [-1, 1].map(side => ({ part: 'head', at: [side * u.head * .2, u.head * .62, -u.head * .55] as V3, size: [u.head * .09 * size, u.head * .075 * size, u.head * .04] as V3, color: u.eye }));
}

// ---- 10 Ash Crawler / 12 Reef Prowler / 13 Tide Behemoth: armoured arthropods ----
function crustacean(o: { shell: [number, number, number]; accent: number; eye: number; spikes: number; tail: boolean; scale: number;
  crack?: number; barnacles?: boolean }): SpeciesModel {
  const shellPaint = o.crack !== undefined
    ? blendPaint(countershade(o.shell[0], o.shell[1], o.shell[2], .1, 8), o.crack, p => smooth01(.46, .5, smoothNoise(p.x * 9, p.y * 9, p.z * 9)) - smooth01(.5, .54, smoothNoise(p.x * 9, p.y * 9, p.z * 9)))
    : countershade(o.shell[0], o.shell[1], o.shell[2], .08, 8);
  const paint = o.barnacles ? blotches(shellPaint, 0xd7d6c5, 13, .66, .9) : shellPaint;
  const body = new CreatureGeometry(), head = new CreatureGeometry(), upper = new CreatureGeometry(), lower = new CreatureGeometry();
  const arm = new CreatureGeometry(), claw = new CreatureGeometry(), tail = new CreatureGeometry(), stinger = new CreatureGeometry();
  body.loft([{ p: [0, .02, .36], w: .2, h: .08, hb: .06 }, { p: [0, .06, .2], w: .4, h: .16, hb: .1 }, { p: [0, .07, -.02], w: .46, h: .2, hb: .11 },
    { p: [0, .06, -.22], w: .4, h: .17, hb: .1 }, { p: [0, .03, -.34], w: .26, h: .1, hb: .08 }], paint, { segments: 16, capStart: .06, capEnd: .05 });
  for (let i = 0; i < o.spikes; i++) {
    const z = -.25 + i * (.55 / Math.max(1, o.spikes - 1));
    quill(body, [0, .22 - Math.abs(z) * .12, z], [0, 1, .45], .14, .035, darkTip(o.accent, o.shell[0], p => p.y, .3, .38));
    for (let side = -1; side <= 1; side += 2) quill(body, [side * .38 * (1 - Math.abs(z + .02) * .9), .08, z], [side, .35, .2], .08, .025, o.accent);
  }
  if (o.barnacles) for (let i = 0; i < 9; i++) body.ellipsoid([Math.sin(i * 2.7) * .26, .2 - (i % 3) * .015, -.2 + i * .05], [.035, .025, .035], 0xe0dccb, [0, 0, 0], 7, 4);
  head.loft([{ p: [0, .02, .04], w: .18, h: .08, hb: .06 }, { p: [0, .02, -.06], w: .17, h: .08, hb: .06 }, { p: [0, -.01, -.12], w: .11, h: .05, hb: .05 }],
    paint, { segments: 12, capStart: .03, capEnd: .04 });
  for (let side = -1; side <= 1; side += 2) {
    head.spike([[side * .07, .05, -.06], [side * .09, .13, -.1], [side * .1, .17, -.11]], .018, o.shell[1], 5, .8);
    head.spike([[side * .04, -.03, -.12], [side * .05, -.07, -.18], [side * .015, -.09, -.2]], .022, o.shell[0], 5, .1);
  }
  arm.loft([{ p: [0, 0, .02], w: .05, h: .05 }, { p: [0, .0, -.16], w: .058, h: .055 }, { p: [0, 0, -.3], w: .05, h: .05 }], paint, { segments: 8, capStart: .03, capEnd: .04 });
  claw.loft([{ p: [0, 0, .03], w: .07, h: .06 }, { p: [0, .01, -.1], w: .1, h: .085 }, { p: [0, .0, -.2], w: .075, h: .06 }], paint, { segments: 10, capStart: .03, capEnd: .02 });
  claw.spike([[.0, .03, -.2], [.0, .04, -.3], [-.03, .02, -.38]], .045, darkTip(o.shell[1], o.accent, p => -p.z, .28, .38), 7, .1, 0, .7);
  claw.spike([[0, -.03, -.18], [.01, -.05, -.27], [-.02, -.04, -.33]], .03, darkTip(o.shell[1], o.accent, p => -p.z, .25, .33), 6, .1, 0, .7);
  limb(upper, .3, [.056, .05, .044, .038], paint, 1, 7, .02);
  limb(lower, .38, [.042, .036, .028, .018, .007], darkTip(o.shell[1], o.accent, p => -p.y, .28, .38), 1, 7, .02);
  const segments = o.tail ? 4 : 0;
  if (o.tail) {
    tail.loft([{ p: [0, 0, -.02], w: .085, h: .07 }, { p: [0, .01, .09], w: .09, h: .075 }, { p: [0, 0, .17], w: .07, h: .06 }], paint, { segments: 10, capStart: .03, capEnd: .03 });
    tail.ellipsoid([0, .07, .09], [.03, .02, .04], o.crack ?? o.accent, [0, 0, 0], 6, 4);
    stinger.loft([{ p: [0, 0, 0], w: .07, h: .07 }, { p: [0, -.01, .1], w: .08, h: .085 }], paint, { segments: 9, capStart: .03 });
    stinger.spike(CreatureGeometry.curve([0, -.02, .13], [0, -.08, .24], [0, -.2, .23], 6), .035, darkTip(o.accent, 0x1a120e, p => -p.y, .1, .2), 6, .1);
  }
  const legs = hexLegs({ hips: [[.27, -.03, -.16], [.31, -.03, .0], [.27, -.03, .16]], feet: [[.62, -.44], [.7, .02], [.6, .46]], upper: .3, lower: .38, knee: .9 });
  const parts: Record<string, CreatureGeometry> = { body, head, upper, lower, arm, claw };
  if (o.tail) { parts.tail = tail; parts.stinger = stinger; }
  const glow: GlowPoint[] = [-1, 1].map(side => ({ part: 'head', at: [side * .1, .17, -.11] as V3, size: [.03, .03, .03] as V3, color: o.eye }));
  if (o.tail) glow.push({ part: 'stinger', at: [0, -.03, .16], size: [.05, .05, .05], color: o.eye, pulse: 2.5 });
  return {
    rig: { kind: 'arthropod', scale: o.scale, gait: { ...gaitDefaults, walkStride: .6, runStride: 1.4, walkDuty: .6, runDuty: .45, walkLift: .1, runLift: .16,
      walkBob: .012, runBob: .025, walkRoll: .03, runRoll: .02, runLean: .04 }, deathSeconds: o.scale > 2 ? .8 : .55, deadDrop: dead(), look: look(.4, 2.2, 4), legs, flip: false,
    body: { y: .34, z: 0, breath: .012 }, head: { at: [0, .02, -.36], pitch: 0 },
    claws: { at: [.24, .0, -.3], upper: .3, lower: .3, spread: .35, raise: .9 },
    ...(o.tail ? { tail: { at: [0, .06, .38], segments, length: .7, curl: .55, stinger: true } } : {}) },
    parts: build(parts), glow,
  };
}

const builders: (() => SpeciesModel)[] = [
  grazer, stalker, skitter, runner, bristleback, beetle, shambler, revenant, brute, titan,
  () => crustacean({ shell: [0x231c18, 0x4a3b33, 0x5a483c], accent: 0xd67b3e, eye: 0xff9635, spikes: 4, tail: true, scale: 1, crack: 0xff7a2a }),
  colossus,
  () => crustacean({ shell: [0x2e6268, 0x4f929a, 0xc7d8cf], accent: 0x9cccc4, eye: 0xb9f3e2, spikes: 3, tail: false, scale: 1.2 }),
  () => crustacean({ shell: [0x284e54, 0x487c83, 0xb9ccc4], accent: 0xd8d2bd, eye: 0x86f2ff, spikes: 5, tail: false, scale: 7, barnacles: true }),
];

/** Procedural species catalog; visual sizes follow CREATURE_DEFS heights. */
export function buildSpeciesModel(species: number): SpeciesModel {
  if (!CREATURE_DEFS[species] || !builders[species]) throw new Error('unknown species ' + species);
  return builders[species]();
}
