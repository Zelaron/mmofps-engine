import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { WEAPONS } from '@shared/weapons';
import { createWeaponSurface } from './weapon-surface.js';

// Procedural weapon models shared by the first-person viewmodel and the
// third-person player rigs. Each build exposes the parts the reload
// choreography moves (slide/bolt, magazine, break-action breech, and the
// round being inserted) plus their rest transforms so posing is idempotent.

export interface WeaponModel {
  group: THREE.Group;
  /** Pistol slide or rifle charging bolt. */
  slide: THREE.Object3D | null;
  /** Detachable magazine. */
  mag: THREE.Object3D | null;
  /** Break-action pivot (scattergun barrels, grenade launcher chamber). */
  breech: THREE.Object3D | null;
  /** The round shown mid-insertion (rocket, shells, grenade). */
  shell: THREE.Object3D | null;
  /** Muzzle tip in the model's local space (barrel points -z). */
  muzzle: THREE.Vector3;
  rests: { obj: THREE.Object3D; pos: THREE.Vector3; rot: THREE.Euler }[];
}

// Three shared surfaces: painted/turned metal, rubber/composite, and small
// illuminated inserts. Vertex colours preserve the finish of every component
// when those components are baked into one draw per surface/animated assembly.
const METAL = createWeaponSurface(false);
const COMPOSITE = createWeaponSurface(true);
const LIT = new THREE.MeshBasicMaterial({ vertexColors: true });
const C = { steel: 0x6b7886, dark: 0x232c35, black: 0x111920, rubber: 0x26313b,
  silver: 0xa3b2bd, tan: 0xb89a62, olive: 0x68715a, cyan: 0x64e4ef, amber: 0xf6ba55 };
type XYZ = readonly [number, number, number];

function part(geometry: THREE.BufferGeometry, color: number, x = 0, y = 0, z = 0,
  material: THREE.Material = METAL): THREE.Mesh {
  const rgb = new THREE.Color(color);
  const colors = new Float32Array(geometry.getAttribute('position').count * 3);
  for (let i = 0; i < colors.length; i += 3) { colors[i] = rgb.r; colors[i + 1] = rgb.g; colors[i + 2] = rgb.b; }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  return mesh;
}

function boxAt(w: number, h: number, d: number, color: number, x: number, y: number, z: number,
  material: THREE.Material = METAL): THREE.Mesh {
  return part(new THREE.BoxGeometry(w, h, d), color, x, y, z, material);
}

/** Cross-section loft: broad bevels catch light without a normal map. */
function shaped(sections: readonly { z: number; y: number; w: number; h: number }[], color: number,
  material: THREE.Material = METAL): THREE.Mesh {
  const cross = [[-.74, -1], [.74, -1], [1, -.62], [1, .62], [.74, 1], [-.74, 1], [-1, .62], [-1, -.62]];
  const positions: number[] = [], indices: number[] = [];
  for (const s of sections) for (const [x, y] of cross) positions.push(x * s.w / 2, s.y + y * s.h / 2, s.z);
  for (let ring = 0; ring < sections.length - 1; ring++) for (let i = 0; i < 8; i++) {
    const a = ring * 8 + i, b = ring * 8 + (i + 1) % 8;
    indices.push(a, b, b + 8, a, b + 8, a + 8);
  }
  const last = (sections.length - 1) * 8;
  for (let i = 1; i < 7; i++) indices.push(0, i + 1, i, last, last + i, last + i + 1);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  const flat = geometry.toNonIndexed(); geometry.dispose(); flat.computeVertexNormals();
  return part(flat, color, 0, 0, 0, material);
}

function bevel(w: number, h: number, d: number, color: number, x: number, y: number, z: number,
  material: THREE.Material = METAL): THREE.Mesh {
  const edge = Math.min(w, h, d) * .12;
  const mesh = shaped([
    { z: -d / 2, y: 0, w: w - edge * 2, h: h - edge * 2 },
    { z: -d / 2 + edge, y: 0, w, h },
    { z: d / 2 - edge, y: 0, w, h },
    { z: d / 2, y: 0, w: w - edge * 2, h: h - edge * 2 },
  ], color, material);
  mesh.position.set(x, y, z); return mesh;
}

function cylAt(r: number, len: number, color: number, x: number, y: number, z: number, seg: number,
  material: THREE.Material = METAL): THREE.Mesh {
  const mesh = part(new THREE.CylinderGeometry(r, r, len, seg), color, x, y, z, material);
  mesh.rotation.x = Math.PI / 2; return mesh;
}

/** A real bore with an annular rim, interior wall and recessed dark back. */
function bore(g: THREE.Group, radius: number, len: number, color: number, x: number, y: number,
  z: number, segments: number, aperture = .72): void {
  const outer = part(new THREE.CylinderGeometry(radius, radius, len, segments, 1, true), color, x, y, z);
  outer.rotation.x = Math.PI / 2; g.add(outer);
  const innerRadius = radius * aperture;
  const interior = new THREE.CylinderGeometry(innerRadius, innerRadius, len, segments, 1, true);
  // Reverse the winding AND normals so the bore is visible from within, while
  // retaining front-face culling for every other merged metal component.
  const index = interior.index!;
  for (let i = 0; i < index.count; i += 3) {
    const a = index.getX(i); index.setX(i, index.getX(i + 2)); index.setX(i + 2, a);
  }
  const normals = interior.getAttribute('normal');
  for (let i = 0; i < normals.count; i++) normals.setXYZ(i, -normals.getX(i), -normals.getY(i), -normals.getZ(i));
  const inner = part(interior, C.black, x, y, z, COMPOSITE); inner.rotation.x = Math.PI / 2; g.add(inner);
  const rim = part(new THREE.RingGeometry(innerRadius, radius, segments), color, x, y, z - len / 2);
  rim.rotation.y = Math.PI; g.add(rim);
  g.add(part(new THREE.RingGeometry(innerRadius, radius, segments), color, x, y, z + len / 2));
  const back = part(new THREE.CircleGeometry(innerRadius, segments), 0x05090c, x, y, z + len / 2 - .002, COMPOSITE);
  back.rotation.y = Math.PI; g.add(back);
}

function grip(g: THREE.Group, x: number, y: number, z: number, width = .068, height = .15, angle = -.2, d = true): void {
  const body = bevel(width, height, .085, C.rubber, x, y, z, COMPOSITE); body.rotation.x = angle; g.add(body);
  if (d) for (let i = 0; i < 4; i++) {
    const rib = boxAt(width + .003, .009, .067, C.black, x, y - .048 + i * .029, z, COMPOSITE);
    rib.rotation.x = angle; g.add(rib);
  }
}

function guard(g: THREE.Group, y: number, z: number, d: boolean): void {
  // An open guard, with a separate hooked trigger rather than a solid block.
  g.add(boxAt(.015, .014, .105, C.dark, 0, y - .049, z));
  const front = boxAt(.015, .055, .014, C.dark, 0, y - .023, z - .052); front.rotation.x = -.22; g.add(front);
  if (d) { const trigger = boxAt(.012, .034, .011, C.silver, 0, y - .018, z + .015); trigger.rotation.x = .32; g.add(trigger); }
}

function rail(g: THREE.Group, y: number, z: number, length: number, d: boolean): void {
  g.add(bevel(.051, .014, length, C.dark, 0, y, z));
  if (d) for (let p = -length / 2 + .015; p < length / 2; p += .027) {
    g.add(boxAt(.061, .012, .012, C.steel, 0, y + .009, z + p));
  }
}

function sight(g: THREE.Group, x: number, y: number, z: number, d: boolean, color = C.cyan): void {
  g.add(bevel(.074, .017, .092, C.dark, x, y, z));
  g.add(boxAt(.012, .064, .021, C.dark, x - .031, y + .035, z));
  g.add(boxAt(.012, .064, .021, C.dark, x + .031, y + .035, z));
  g.add(boxAt(.055, .011, .021, C.steel, x, y + .068, z));
  if (d) g.add(boxAt(.016, .008, .014, color, x, y + .023, z + .035, LIT));
}

function stock(g: THREE.Group, color: number, rear: number, d: boolean): void {
  g.add(shaped([
    { z: .14, y: .007, w: .053, h: .055 }, { z: .23, y: -.018, w: .063, h: .085 },
    { z: rear - .018, y: -.022, w: .082, h: .13 }, { z: rear, y: -.025, w: .078, h: .13 },
  ], color, COMPOSITE));
  g.add(bevel(.085, .137, .024, C.black, 0, -.025, rear, COMPOSITE));
  if (d) g.add(bevel(.069, .027, .098, C.rubber, 0, .028, rear - .064, COMPOSITE));
}

/** Bake only siblings; reload pivots remain separate transformable groups. */
function pack(g: THREE.Group): void {
  for (const child of [...g.children]) if (child instanceof THREE.Group) pack(child);
  const batches = new Map<THREE.Material, THREE.BufferGeometry[]>();
  for (const child of [...g.children]) {
    if (!(child instanceof THREE.Mesh)) continue;
    child.updateMatrix();
    const geo = child.geometry.index ? child.geometry.toNonIndexed() : child.geometry.clone();
    geo.applyMatrix4(child.matrix);
    for (const name of Object.keys(geo.attributes)) if (!['position', 'normal', 'color'].includes(name)) geo.deleteAttribute(name);
    const mat = child.material as THREE.Material;
    const batch = batches.get(mat) ?? []; batch.push(geo); batches.set(mat, batch);
    child.geometry.dispose(); g.remove(child);
  }
  for (const [material, geometries] of batches) {
    const geometry = mergeGeometries(geometries, false)!;
    for (const source of geometries) source.dispose();
    geometry.computeBoundingBox(); geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = material === METAL ? 'metal' : material === LIT ? 'illuminated-inserts' : 'composite';
    g.add(mesh);
  }
}

function finish(group: THREE.Group,
  parts: { slide?: THREE.Object3D; mag?: THREE.Object3D; breech?: THREE.Object3D; shell?: THREE.Object3D },
  muzzle: [number, number, number]): WeaponModel {
  pack(group);
  const rests: WeaponModel['rests'] = [];
  for (const [name, obj] of Object.entries(parts)) {
    if (obj) { obj.name = name; rests.push({ obj, pos: obj.position.clone(), rot: obj.rotation.clone() }); }
  }
  if (parts.shell) parts.shell.visible = false;
  return { group, slide: parts.slide ?? null, mag: parts.mag ?? null, breech: parts.breech ?? null,
    shell: parts.shell ?? null, muzzle: new THREE.Vector3(...muzzle), rests };
}

function buildSidearm(d: boolean): WeaponModel {
  const seg = d ? 24 : 10, g = new THREE.Group();
  g.add(bevel(.091, .068, .225, C.dark, 0, 0, -.023));
  bore(g, .025, .06, C.steel, 0, .07, -.23, seg);
  const slide = new THREE.Group(); slide.position.set(0, .07, -.05);
  slide.add(bevel(.099, .076, .3, 0x8b9aa6, 0, 0, 0));
  // Recessed ejection port, separate extractor and rear serrations.
  if (d) {
    slide.add(boxAt(.0015, .027, .075, C.black, .0497, .008, -.028, COMPOSITE));
    slide.add(bevel(.004, .017, .045, C.steel, .052, -.002, -.005));
    for (let i = 0; i < 6; i++) for (const side of [-1, 1]) {
      slide.add(boxAt(.002, .034, .006, C.dark, side * .0498, 0, .054 + i * .013));
    }
  }
  for (const side of [-1, 1]) slide.add(boxAt(.018, .017, .018, C.black, side * .03, .046, .12));
  slide.add(boxAt(.013, .019, .018, C.black, 0, .046, -.13));
  slide.add(boxAt(.007, .007, .004, C.amber, 0, .052, -.119, LIT));
  g.add(slide); grip(g, 0, -.12, .065, .083, .186, -.15, d); guard(g, -.028, -.047, d);
  if (d) {
    rail(g, -.046, -.11, .1, true);
    const pin = cylAt(.011, .094, C.silver, 0, -.012, .046, 12); pin.rotation.set(0, 0, Math.PI / 2); g.add(pin);
  }
  const mag = new THREE.Group(); mag.position.set(0, -.12, .06); mag.rotation.x = -.15;
  mag.add(bevel(.06, .18, .073, C.steel, 0, -.01, 0));
  mag.add(bevel(.09, .025, .105, C.black, 0, -.108, 0, COMPOSITE)); g.add(mag);
  return finish(g, { slide, mag }, [0, .07, -.26]);
}

function buildPulseRifle(d: boolean): WeaponModel {
  const seg = d ? 24 : 10, g = new THREE.Group();
  const ceramic = 0xb9c4c3, copper = 0xba7850;
  const casing = (w: number, h: number, length: number, color: number, x: number, y: number, z: number,
    material: THREE.Material = METAL) => d
      ? part(new RoundedBoxGeometry(w, h, length, 1, Math.min(w, h, length) * .18), color, x, y, z, material)
      : bevel(w, h, length, color, x, y, z, material);
  g.add(casing(.098, .111, .31, C.dark, 0, .005, -.015));
  for (const side of [-1, 1]) {
    g.add(casing(.009, .078, .23, ceramic, side * .049, .007, -.025, COMPOSITE));
    // A separate cheek plate, with exposed metal edges and a service slot.
    if (d) {
      g.add(boxAt(.0018, .008, .105, C.black, side * .054, -.014, -.051, COMPOSITE));
      g.add(boxAt(.002, .006, .054, C.cyan, side * .055, -.014, -.071, LIT));
      for (const z of [-.118, .065]) {
        const pin = cylAt(.006, .111, C.steel, 0, .024, z, 8);
        pin.rotation.set(0, 0, Math.PI / 2); if (side === 1) g.add(pin);
      }
    }
  }
  // An open cooling cage surrounds a real barrel and copper induction rings.
  // These gaps change the silhouette instead of painting vents on a box.
  g.add(cylAt(.022, .37, C.steel, 0, .015, -.415, seg));
  g.add(bevel(.094, .026, .274, ceramic, 0, .057, -.315, COMPOSITE));
  g.add(bevel(.078, .028, .26, C.rubber, 0, -.05, -.305, COMPOSITE));
  for (const z of [-.426, -.346, -.266, -.186]) for (const side of [-1, 1]) {
    g.add(boxAt(.012, .079, .014, C.dark, side * .043, .008, z));
  }
  if (d) for (let i = 0; i < 6; i++) {
    g.add(cylAt(.0265, .008, copper, 0, .015, -.406 + i * .032, 12));
  }
  for (const side of [-1, 1]) g.add(boxAt(.006, .008, .20, C.cyan, side * .025, .019, -.312, LIT));
  bore(g, .032, .085, C.dark, 0, .015, -.6175, seg, .65);
  stock(g, ceramic, .325, d); grip(g, 0, -.11, .11, .066, .146, -.2, d); guard(g, -.04, .024, d);
  rail(g, .075, -.15, .45, d);
  if (d) {
    g.add(casing(.071, .023, .079, C.dark, 0, .091, -.035));
    const hood = part(new THREE.TorusGeometry(.032, .007, 6, 16), C.steel, 0, .129, -.035);
    hood.scale.y = .85; g.add(hood);
    g.add(boxAt(.009, .006, .011, C.cyan, 0, .107, -.006, LIT));
    for (let i = 0; i < 3; i++) g.add(boxAt(.078, .006, .012, C.black, 0, -.065, -.35 + i * .04, COMPOSITE));
  } else sight(g, 0, .09, -.035, false);
  const mag = new THREE.Group(); mag.position.set(0, -.12, -.066); mag.rotation.x = .2;
  mag.add(shaped([{ z: -.048, y: -.034, w: .052, h: .165 }, { z: .03, y: -.016, w: .058, h: .185 },
    { z: .048, y: -.008, w: .05, h: .166 }], C.rubber, COMPOSITE));
  mag.add(bevel(.064, .026, .105, ceramic, 0, -.111, 0, COMPOSITE));
  if (d) for (const side of [-1, 1]) {
    mag.add(bevel(.006, .105, .052, C.steel, side * .029, -.014, .005));
    mag.add(boxAt(.002, .071, .018, C.cyan, side * .033, -.016, 0, LIT));
  }
  g.add(mag);
  const slide = new THREE.Group(); slide.position.set(.053, .027, .055);
  slide.add(bevel(.026, .023, .054, C.silver, 0, 0, 0)); g.add(slide);
  return finish(g, { slide, mag }, [0, .015, -.66]);
}

function buildScattergun(d: boolean): WeaponModel {
  const seg = d ? 28 : 10, g = new THREE.Group();
  stock(g, 0x835c3b, .352, d);
  g.add(bevel(.096, .105, .174, C.steel, 0, .011, .049));
  const neck = bevel(.07, .081, .15, 0x735032, 0, -.039, .155, COMPOSITE); neck.rotation.x = -.28; g.add(neck);
  guard(g, -.033, .075, d);
  g.add(bevel(.024, .019, .086, C.dark, .011, .079, .075));
  if (d) for (const side of [-1, 1]) {
    const hinge = cylAt(.024, .006, C.silver, side * .049, -.012, -.016, 20); hinge.rotation.set(0, 0, Math.PI / 2); g.add(hinge);
    g.add(bevel(.003, .036, .079, 0x394651, side * .0484, .009, .058));
  }
  const breech = new THREE.Group(); breech.position.set(0, .02, -.03);
  for (const side of [-1, 1]) {
    bore(breech, .033, .44, C.dark, side * .036, .015, -.24, seg, .79);
    breech.add(cylAt(.036, .036, C.steel, side * .036, .015, -.035, seg));
  }
  breech.add(shaped([{ z: -.355, y: -.034, w: .066, h: .028 }, { z: -.31, y: -.045, w: .104, h: .052 },
    { z: -.123, y: -.045, w: .112, h: .065 }, { z: -.078, y: -.027, w: .079, h: .052 }], 0x94633b, COMPOSITE));
  breech.add(boxAt(.012, .008, .4, C.steel, 0, .046, -.232));
  breech.add(cylAt(.006, .014, C.amber, 0, .057, -.439, 12, LIT));
  if (d) for (let i = 0; i < 7; i++) breech.add(boxAt(.098, .007, .009, 0x513821, 0, -.072, -.29 + i * .024, COMPOSITE));
  const shell = new THREE.Group();
  for (const side of [-1, 1]) {
    shell.add(cylAt(.026, .069, 0xa34f38, side * .036, .015, .003, seg));
    shell.add(cylAt(.028, .013, C.tan, side * .036, .015, .038, seg));
  }
  breech.add(shell); g.add(breech);
  return finish(g, { breech, shell }, [0, .035, -.49]);
}

function buildRocketLauncher(d: boolean): WeaponModel {
  const seg = d ? 32 : 12, g = new THREE.Group();
  bore(g, .071, .72, C.olive, 0, .02, -.14, seg, .93);
  bore(g, .092, .095, C.dark, 0, .02, -.5225, seg, .76);
  bore(g, .086, .08, C.dark, 0, .02, .259, seg, .76);
  for (const z of [-.37, -.04, .178]) g.add(cylAt(.077, .024, C.steel, 0, .02, z, seg));
  grip(g, 0, -.12, .07, .069, .15, -.12, d); grip(g, 0, -.117, -.19, .068, .126, .12, d);
  guard(g, -.046, .003, d);
  g.add(bevel(.079, .044, .28, C.rubber, 0, -.061, .174, COMPOSITE));
  g.add(bevel(.029, .108, .18, C.dark, -.086, .034, -.105));
  bore(g, .03, .165, C.steel, -.091, .109, -.136, seg, .68);
  g.add(cylAt(.022, .002, 0x42848c, -.091, .109, -.052, seg, LIT));
  if (d) {
    for (const z of [-.41, -.393]) g.add(cylAt(.0725, .008, C.amber, 0, .02, z, seg));
    g.add(bevel(.041, .018, .083, C.dark, 0, .095, -.275));
    for (let i = 0; i < 3; i++) g.add(boxAt(.01, .004, .014, C.amber, -.013 + .013 * i, .106, -.275, LIT));
    for (const side of [-1, 1]) g.add(bevel(.009, .019, .2, 0x3e493b, side * .07, .025, -.195));
  }
  const shell = new THREE.Group(); shell.position.set(0, .02, .16);
  shell.add(cylAt(.044, .26, C.olive, 0, 0, 0, seg));
  const nose = part(new THREE.ConeGeometry(.044, .1, seg), 0xb2523a, 0, 0, -.18); nose.rotation.x = -Math.PI / 2; shell.add(nose);
  for (const angle of [0, Math.PI / 2]) { const fin = boxAt(.104, .007, .073, C.steel, 0, 0, .09); fin.rotation.z = angle; shell.add(fin); }
  g.add(shell); return finish(g, { shell }, [0, .02, -.57]);
}

function buildGrenadeLauncher(d: boolean): WeaponModel {
  const seg = d ? 28 : 12, g = new THREE.Group();
  g.add(bevel(.106, .099, .242, 0x8c927a, 0, .004, .063));
  stock(g, C.olive, .371, d); grip(g, 0, -.13, .13, .074, .162, -.12, d); guard(g, -.045, .04, d);
  // Open ladder sight with several elevation marks, readable in silhouette.
  g.add(boxAt(.012, .116, .018, C.dark, -.047, .108, .014));
  g.add(boxAt(.012, .116, .018, C.dark, .013, .108, .014));
  for (let i = 0; i < (d ? 4 : 2); i++) g.add(boxAt(.059, .007, .019, C.tan, -.017, .067 + i * (d ? .026 : .077), .014));
  if (d) g.add(bevel(.014, .03, .045, C.amber, .06, .023, .065));
  const breech = new THREE.Group(); breech.position.set(0, -.01, -.08);
  breech.add(cylAt(.09, .205, C.olive, 0, .008, .016, seg));
  for (const z of [-.081, .114]) breech.add(cylAt(.096, .015, C.steel, 0, .008, z, seg));
  bore(breech, .058, .32, C.dark, 0, .02, -.24, seg, .75);
  bore(breech, .074, .065, C.steel, 0, .02, -.3875, seg, .69);
  // Ribbed barrel sleeve avoids the old oversized featureless sphere chamber.
  for (let i = 0; i < (d ? 7 : 3); i++) breech.add(cylAt(.065, .012, C.dark, 0, .02, -.315 + i * (d ? .027 : .077), seg));
  breech.add(bevel(.095, .05, .17, C.rubber, 0, -.048, -.225, COMPOSITE));
  const shell = new THREE.Group(); shell.position.set(0, .008, .02);
  shell.add(cylAt(.051, .089, C.tan, 0, 0, .021, seg));
  const nose = part(new THREE.SphereGeometry(.051, seg, d ? 10 : 5, 0, Math.PI * 2, 0, Math.PI / 2), 0xc48b3e, 0, 0, -.024);
  nose.rotation.x = -Math.PI / 2; shell.add(nose);
  shell.add(cylAt(.055, .012, C.silver, 0, 0, .071, seg));
  breech.add(shell); g.add(breech);
  return finish(g, { breech, shell }, [0, .01, -.5]);
}

function buildRailgun(d: boolean): WeaponModel {
  const seg = d ? 24 : 10, g = new THREE.Group();
  g.add(bevel(.101, .105, .34, 0x82919c, 0, -.005, .025));
  for (const side of [-1, 1]) {
    g.add(shaped([{ z: -.62, y: .004, w: .026, h: .059 }, { z: -.55, y: .006, w: .032, h: .076 },
      { z: -.17, y: .006, w: .038, h: .082 }], C.steel).translateX(side * .044));
    g.add(boxAt(.008, .028, .4, C.cyan, side * .022, .006, -.376, LIT));
  }
  for (const z of d ? [-.52, -.41, -.3, -.19] : [-.5, -.22]) {
    g.add(boxAt(.132, .021, .037, C.dark, 0, .056, z));
    g.add(boxAt(.132, .021, .037, C.dark, 0, -.044, z));
    for (const side of [-1, 1]) g.add(bevel(.018, .118, .037, C.dark, side * .06, .006, z));
  }
  bore(g, .022, .09, C.black, 0, .005, -.545, seg);
  stock(g, 0x566773, .341, d); grip(g, 0, -.12, .12, .067, .149, -.2, d); guard(g, -.048, .033, d);
  rail(g, .063, .003, .22, d);
  bore(g, .029, .164, C.dark, 0, .112, .004, seg);
  g.add(cylAt(.021, .002, C.cyan, 0, .112, .087, seg, LIT));
  g.add(bevel(.028, .033, .075, C.dark, 0, .081, .024));
  if (d) for (const side of [-1, 1]) for (let i = 0; i < 4; i++) g.add(boxAt(.003, .005, .052, C.black, side * .051, -.016 + i * .014, .035, COMPOSITE));
  const mag = new THREE.Group(); mag.position.set(0, -.1, -.02);
  mag.add(bevel(.067, .147, .108, C.dark, 0, -.02, 0));
  mag.add(bevel(.071, .022, .112, C.cyan, 0, -.086, 0, LIT));
  if (d) for (const side of [-1, 1]) mag.add(boxAt(.002, .055, .066, 0x517b86, side * .034, -.022, 0));
  g.add(mag);
  const slide = new THREE.Group(); slide.position.set(.062, .02, .11); slide.add(bevel(.025, .024, .055, C.silver, 0, 0, 0)); g.add(slide);
  return finish(g, { slide, mag }, [0, .005, -.62]);
}

function buildNukeGun(d: boolean): WeaponModel {
  const seg = d ? 28 : 10, g = new THREE.Group();
  g.add(shaped([{ z: -.24, y: .016, w: .121, h: .126 }, { z: -.17, y: .009, w: .188, h: .177 },
    { z: .14, y: .007, w: .176, h: .163 }, { z: .185, y: -.002, w: .108, h: .099 }], 0x727762));
  g.add(bevel(.135, .135, .266, C.dark, 0, .008, -.357));
  // Four shield petals surround a recessed bore instead of a solid square cap.
  bore(g, .064, .095, C.steel, 0, .01, -.4925, seg, .76);
  for (const angle of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
    const petal = bevel(.099, .025, .185, C.olive, 0, 0, -.412);
    petal.position.x = Math.sin(angle) * .073; petal.position.y = .01 + Math.cos(angle) * .073; petal.rotation.z = -angle; g.add(petal);
  }
  stock(g, C.olive, .375, d); grip(g, 0, -.14, .1, .076, .157, -.12, d); guard(g, -.067, .006, d);
  g.add(bevel(.09, .027, .145, C.rubber, 0, -.105, -.22, COMPOSITE));
  g.add(bevel(.105, .023, .114, C.dark, 0, .111, -.033));
  sight(g, 0, .122, -.034, d, 0x99ef77);
  if (d) {
    for (const side of [-1, 1]) {
      g.add(bevel(.017, .058, .12, C.dark, side * .091, .015, -.005));
      g.add(boxAt(.002, .022, .067, 0x94dd6b, side * .1, .022, -.006, LIT));
      for (let i = 0; i < 5; i++) {
        const stripe = boxAt(.003, .055, .013, C.amber, side * .089, 0, .055 + i * .021); stripe.rotation.x = -.3; g.add(stripe);
      }
    }
    for (const z of [-.455, -.427, -.399, -.371]) g.add(boxAt(.109, .008, .011, C.black, 0, .092, z, COMPOSITE));
  }
  const mag = new THREE.Group(); mag.position.set(0, -.13, -.1);
  mag.add(cylAt(.092, .17, C.olive, 0, 0, 0, seg));
  for (const z of [-.088, .088]) mag.add(cylAt(.097, .018, C.dark, 0, 0, z, seg));
  mag.add(cylAt(.04, .196, C.steel, 0, 0, 0, seg));
  for (let i = 0; i < (d ? 8 : 4); i++) {
    const angle = i * Math.PI * 2 / (d ? 8 : 4);
    const rib = boxAt(.019, .015, .137, i % 2 ? C.dark : C.amber, Math.sin(angle) * .09, Math.cos(angle) * .09, 0);
    rib.rotation.z = -angle; mag.add(rib);
  }
  g.add(mag); return finish(g, { mag }, [0, .01, -.54]);
}

function buildBurstCarbine(d: boolean): WeaponModel {
  const seg = d ? 24 : 10, g = new THREE.Group();
  // A compact bullpup: magazine behind the trigger, raised bridge sight and
  // warm ceramic panels make it recognizable beside the long pulse rifle.
  g.add(shaped([{ z: -.35, y: .006, w: .08, h: .086 }, { z: -.25, y: .01, w: .11, h: .12 },
    { z: .27, y: -.005, w: .098, h: .135 }, { z: .335, y: -.021, w: .081, h: .117 }], 0xb6a37d));
  g.add(bevel(.085, .134, .025, C.black, 0, -.02, .342, COMPOSITE));
  g.add(cylAt(.021, .14, C.steel, 0, .015, -.401, seg));
  bore(g, .031, .105, C.dark, 0, .015, -.5175, seg, .65);
  grip(g, 0, -.107, -.014, .065, .14, -.2, d); guard(g, -.041, -.085, d);
  g.add(bevel(.077, .037, .17, C.rubber, 0, -.057, -.263, COMPOSITE));
  for (const z of [-.17, .09]) g.add(bevel(.038, .046, .043, C.dark, 0, .094, z));
  rail(g, .12, -.033, .32, d); sight(g, 0, .137, .017, d, C.amber);
  if (d) {
    for (const side of [-1, 1]) {
      for (let i = 0; i < 5; i++) g.add(boxAt(.002, .027, .012, C.black, side * .0552, .01, -.202 + i * .024, COMPOSITE));
      for (let i = 0; i < 3; i++) g.add(boxAt(.002, .005, .017, C.amber, side * .052, .043, .012 + i * .024, LIT));
    }
  }
  const mag = new THREE.Group(); mag.position.set(0, -.115, .188); mag.rotation.x = .12;
  mag.add(bevel(.065, .159, .092, C.rubber, 0, -.015, 0, COMPOSITE));
  mag.add(bevel(.072, .024, .102, C.steel, 0, -.102, 0));
  if (d) for (const side of [-1, 1]) for (let i = 0; i < 3; i++) g.add(boxAt(.003, .06, .006, C.steel, side * .033, -.022, -.025 + i * .025));
  g.add(mag);
  const slide = new THREE.Group(); slide.position.set(-.061, .048, -.065);
  slide.add(bevel(.034, .019, .049, C.silver, 0, 0, 0)); g.add(slide);
  return finish(g, { slide, mag }, [0, .015, -.57]);
}

function buildFlechetteRepeater(d: boolean): WeaponModel {
  const seg = d ? 24 : 10, g = new THREE.Group();
  // Short ventilated barrel, circular dart cassette and a skeletal stock.
  g.add(bevel(.108, .101, .29, 0x6a7b72, 0, .006, -.038));
  g.add(shaped([{ z: -.397, y: .015, w: .076, h: .076 }, { z: -.32, y: .014, w: .098, h: .104 },
    { z: -.177, y: .014, w: .104, h: .104 }], C.dark));
  bore(g, .04, .103, C.steel, 0, .015, -.4635, seg, .73);
  for (const side of [-1, 1]) g.add(boxAt(.014, .02, .204, C.steel, side * .03, .016, .212));
  g.add(bevel(.083, .139, .026, C.black, 0, -.026, .321, COMPOSITE));
  grip(g, 0, -.108, .093, .069, .15, -.17, d); guard(g, -.04, .012, d);
  const foregrip = bevel(.065, .083, .075, C.rubber, 0, -.092, -.277, COMPOSITE); foregrip.rotation.x = .3; g.add(foregrip);
  rail(g, .069, -.066, .285, d); sight(g, 0, .087, .018, d, 0xff9565);
  if (d) for (const side of [-1, 1]) {
    for (let i = 0; i < 5; i++) g.add(boxAt(.003, .037, .012, C.black, side * .052, .013, -.291 + i * .023, COMPOSITE));
    g.add(bevel(.003, .018, .084, 0xc97743, side * .055, .023, -.047));
  }
  const mag = new THREE.Group(); mag.position.set(0, -.137, -.105);
  const drum = cylAt(.084, .105, C.dark, 0, 0, 0, seg); drum.rotation.set(0, 0, Math.PI / 2); mag.add(drum);
  for (const side of [-1, 1]) {
    const plate = cylAt(.073, .009, 0x8b9b8d, side * .056, 0, 0, seg); plate.rotation.set(0, 0, Math.PI / 2); mag.add(plate);
    const axle = cylAt(.026, .014, C.dark, side * .061, 0, 0, seg); axle.rotation.set(0, 0, Math.PI / 2); mag.add(axle);
    if (d) for (let i = 0; i < 6; i++) {
      const angle = i * Math.PI / 3;
      const spoke = boxAt(.01, .008, .04, 0xc97743, side * .062, Math.sin(angle) * .047, Math.cos(angle) * .047);
      spoke.rotation.x = -angle; mag.add(spoke);
    }
  }
  g.add(mag);
  const slide = new THREE.Group(); slide.position.set(.065, .019, .033);
  slide.add(bevel(.029, .02, .066, C.silver, 0, 0, 0)); g.add(slide);
  return finish(g, { slide, mag }, [0, .015, -.515]);
}

function buildPrismProjector(d: boolean): WeaponModel {
  const seg = d ? 24 : 10, g = new THREE.Group(), glow = 0xcaa5ff;
  g.add(shaped([{ z: -.19, y: .014, w: .139, h: .127 }, { z: -.103, y: .012, w: .113, h: .103 },
    { z: .14, y: .003, w: .096, h: .115 }], 0x8e9eab));
  stock(g, 0x526471, .338, d); grip(g, 0, -.118, .107, .071, .15, -.15, d); guard(g, -.045, .018, d);
  // A faceted, illuminated crystal is held between three emitter prongs.
  const crystal = part(new THREE.OctahedronGeometry(.061, 0), glow, 0, .015, -.334, LIT);
  const facets = crystal.geometry.getAttribute('normal'), tint = crystal.geometry.getAttribute('color');
  for (let i = 0; i < tint.count; i++) {
    const light = .62 + .38 * Math.max(0, facets.getY(i) * .7 + facets.getX(i) * .45 - facets.getZ(i) * .2);
    tint.setXYZ(i, tint.getX(i) * light, tint.getY(i) * light, tint.getZ(i) * light);
  }
  crystal.scale.z = 2.55; g.add(crystal);
  for (let i = 0; i < 3; i++) {
    const angle = i * Math.PI * 2 / 3;
    const prong = shaped([{ z: -.573, y: 0, w: .027, h: .025 }, { z: -.5, y: 0, w: .034, h: .039 },
      { z: -.17, y: 0, w: .042, h: .053 }], C.dark);
    prong.position.set(Math.sin(angle) * .075, .015 + Math.cos(angle) * .075, 0); prong.rotation.z = -angle; g.add(prong);
    if (d) {
      const strip = boxAt(.015, .005, .233, glow, 0, 0, -.321, LIT);
      strip.position.x = Math.sin(angle) * .088; strip.position.y = .015 + Math.cos(angle) * .088; strip.rotation.z = -angle; g.add(strip);
    }
  }
  bore(g, .042, .082, C.silver, 0, .015, -.549, seg, .62);
  rail(g, .078, .013, .176, d); sight(g, 0, .096, .018, d, glow);
  const mag = new THREE.Group(); mag.position.set(0, -.112, -.065);
  mag.add(bevel(.072, .142, .099, C.dark, 0, -.014, 0));
  mag.add(bevel(.079, .026, .107, glow, 0, -.086, 0, LIT));
  if (d) for (const side of [-1, 1]) {
    mag.add(boxAt(.003, .071, .04, glow, side * .037, -.018, 0, LIT));
    for (let i = 0; i < 4; i++) g.add(boxAt(.003, .007, .054, C.black, side * .057, -.012 + i * .016, -.04, COMPOSITE));
  }
  g.add(mag); return finish(g, { mag }, [0, .015, -.59]);
}

/** detail=true builds the articulated first-person model, false a cheaper rig. */
export function buildWeaponModel(weapon: number, detail: boolean): WeaponModel {
  switch (weapon) {
    case 0: return buildSidearm(detail);
    case 1: return buildPulseRifle(detail);
    case 2: return buildScattergun(detail);
    case 3: return buildRocketLauncher(detail);
    case 5: return buildRailgun(detail);
    case 6: return buildNukeGun(detail);
    case 7: return buildBurstCarbine(detail);
    case 8: return buildFlechetteRepeater(detail);
    case 9: return buildPrismProjector(detail);
    default: return buildGrenadeLauncher(detail);
  }
}

/** Local contact points let third-person hands follow each actual grip. */
const GRIPS: readonly { trigger: XYZ; support: XYZ }[] = [
  { trigger: [0, -.11, .08], support: [-.036, -.1, .032] },
  { trigger: [0, -.11, .11], support: [0, -.064, -.3] },
  { trigger: [0, -.07, .14], support: [0, -.061, -.25] },
  { trigger: [0, -.12, .07], support: [0, -.117, -.19] },
  { trigger: [0, -.13, .13], support: [0, -.071, -.3] },
  { trigger: [0, -.12, .12], support: [0, -.065, -.24] },
  { trigger: [0, -.14, .1], support: [0, -.105, -.22] },
  { trigger: [0, -.107, -.014], support: [0, -.06, -.263] },
  { trigger: [0, -.108, .093], support: [0, -.092, -.277] },
  { trigger: [0, -.118, .107], support: [0, -.062, -.19] },
];
export function weaponGripPoints(weapon: number): { trigger: XYZ; support: XYZ } {
  return GRIPS[weapon] ?? GRIPS[1];
}

// Remote weapons do not animate reload pivots. Bake their visible rest pose
// once into at most three shared draws, regardless of component count.
const WORLD_TEMPLATES = new Map<number, THREE.Group>();
export function cloneWorldWeapon(weapon: number): THREE.Group {
  const id = Number.isInteger(weapon) && weapon >= 0 && weapon < WEAPONS.length ? weapon : 1;
  let template = WORLD_TEMPLATES.get(id);
  if (!template) {
    const model = buildWeaponModel(id, false), source = model.group;
    source.updateMatrixWorld(true);
    template = new THREE.Group();
    template.userData.muzzle = model.muzzle.toArray();
    source.traverseVisible((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const mesh = new THREE.Mesh(obj.geometry.clone().applyMatrix4(obj.matrixWorld), obj.material);
      template!.add(mesh);
    });
    source.traverse((obj) => { if (obj instanceof THREE.Mesh) obj.geometry.dispose(); });
    pack(template);
    WORLD_TEMPLATES.set(id, template);
  }
  return template.clone();
}

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
const ramp = (p: number, a: number, b: number): number => clamp01((p - a) / (b - a));

/**
 * Pose the animated parts for this frame. `progress` is the normalized
 * reload progress or -1 when idle; `kick` (0..1) is the fire recoil that
 * cycles the slide/bolt. Restores rest transforms first, so calling it
 * every frame is idempotent.
 */
export function poseWeaponReload(m: WeaponModel, weapon: number, progress: number, kick = 0): void {
  for (const r of m.rests) {
    r.obj.position.copy(r.pos);
    r.obj.rotation.copy(r.rot);
  }
  if (m.shell) m.shell.visible = false;
  if (m.slide) m.slide.position.z += (weapon === 0 ? 0.07 : 0.05) * kick;
  const p = progress;
  if (p < 0) return;

  switch (weapon) {
    case 0: {
      // Slide locks back, the empty mag drops clear, a fresh one seats,
      // then the slide snaps home.
      const open = ramp(p, 0, 0.08) * (1 - ramp(p, 0.86, 0.94));
      if (m.slide) m.slide.position.z += 0.085 * open;
      const out = ramp(p, 0.08, 0.3) * (1 - ramp(p, 0.5, 0.74));
      if (m.mag) {
        m.mag.position.y -= 0.3 * out;
        m.mag.rotation.x -= 0.4 * out;
      }
      break;
    }
    case 1:
    case 5:
    case 7:
    case 8:
    case 9: {
      // Rifle mag / railgun capacitor cell: out, hold, back in, then rack.
      const out = ramp(p, 0.05, 0.3) * (1 - ramp(p, 0.5, 0.75));
      if (m.mag) {
        m.mag.position.y -= 0.32 * out;
        m.mag.rotation.x += 0.45 * out;
      }
      const rack = ramp(p, 0.8, 0.87) * (1 - ramp(p, 0.9, 0.97));
      if (m.slide) m.slide.position.z += 0.09 * rack;
      break;
    }
    case 2: {
      const open = ramp(p, 0.04, 0.22) * (1 - ramp(p, 0.78, 0.92));
      if (m.breech) m.breech.rotation.x -= 0.55 * open;
      if (m.shell) {
        m.shell.visible = open > 0.5 && p < 0.75;
        m.shell.position.z += 0.1 * (1 - ramp(p, 0.35, 0.62));
      }
      break;
    }
    case 3: {
      // A fresh rocket slides into the rear of the tube.
      if (m.shell) {
        m.shell.visible = p > 0.16 && p < 0.85;
        m.shell.position.z += 0.55 * (1 - ramp(p, 0.22, 0.72));
        m.shell.position.y += 0.12 * (1 - ramp(p, 0.18, 0.4));
      }
      break;
    }
    case 6: {
      // Nuke launcher: the shielded warhead drum swings down and out,
      // rotates to the next cassette, and slams back up.
      const out = ramp(p, 0.08, 0.3) * (1 - ramp(p, 0.68, 0.9));
      if (m.mag) {
        m.mag.position.y -= 0.22 * out;
        m.mag.position.z += 0.1 * out;
        m.mag.rotation.z += Math.PI * ramp(p, 0.35, 0.62);
      }
      break;
    }
    default: {
      const open = ramp(p, 0.05, 0.2) * (1 - ramp(p, 0.8, 0.93));
      if (m.breech) m.breech.rotation.x -= 0.7 * open;
      if (m.shell) {
        m.shell.visible = p > 0.34 && p < 0.78;
        m.shell.position.y -= 0.28 * (1 - ramp(p, 0.4, 0.7));
        m.shell.position.z -= 0.08 * (1 - ramp(p, 0.4, 0.7));
      }
      break;
    }
  }
}
