import * as THREE from 'three';
import { createIndustrialMaterial } from './industrial-material.js';
import {
  VEHICLE, vehicleDefinition, VEHICLE_VARIANT, validVehicleVariant, JET_GUN_MUZZLE, NOCTURNE_SCALE,
  GUNBOAT_GUN_PIVOT, DESTROYER_BATTERY_PIVOT, DESTROYER_BATTERY_LENGTH, GUNBOAT_BARREL_LENGTH, TRAIN_ARTILLERY_PIVOT, TRAIN_ARTILLERY_BARREL_LENGTH,
  crewGunPivot, CREW_GUN_LENGTH, artilleryPitch,
  viewDir, type SnapshotVehicle, type VehicleType,
} from '@shared/index';
import { VehicleGeometry } from './vehicle-geometry.js';
import { transportPose, TRAIN_ARTILLERY_MOUNT, type TransportRoute } from '@shared/transport';

const BODY = 0x71815b;
const TANK_BODY = 0x69765a;
const JET_BODY = 0xa7b7bd;
const DARK = 0x232b2c;
const METAL = 0x566264;
const GLASS = 0x396875;
const ARMOR = createIndustrialMaterial();
const WINDOWS = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: .16, metalness: .15, clearcoat: 1, clearcoatRoughness: .12 });
const GLOW = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });

// One immutable GPU template per type. Clones share geometry/materials, while
// wheels, turret transforms and exhaust visibility belong to each instance.
const TEMPLATES = new Map<number, THREE.Group>();
interface VehicleAnimation {
  wheels: THREE.Object3D[];
  steering: THREE.Object3D[];
  exhaust: THREE.Object3D | undefined;
  phase: number;
  turret?: THREE.Object3D;
  elevation?: THREE.Object3D;
  muzzle?: THREE.Object3D;
  flash?: THREE.Mesh<THREE.ConeGeometry, THREE.MeshBasicMaterial>;
  flashLife?: number;
  recoil?: THREE.Object3D;
}
const ANIMATION = new WeakMap<THREE.Group, VehicleAnimation>();
const MUZZLE_FLASH_GEOMETRY = new THREE.ConeGeometry(0.18, 0.65, 6);
const MUZZLE_FLASH_MATERIAL = new THREE.MeshBasicMaterial({ color: 0xffd990, transparent: true,
  opacity: .95, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
const VIOLET_FLASH_MATERIAL = MUZZLE_FLASH_MATERIAL.clone();
VIOLET_FLASH_MATERIAL.color.setHex(0xc577ff);
MUZZLE_FLASH_GEOMETRY.rotateX(-Math.PI / 2);
MUZZLE_FLASH_GEOMETRY.translate(0, 0, -0.3);

/**
 * Cosmetic hull attitude derived purely from replicated motion: the nose
 * follows the velocity vector (climbs slopes nose-up, dips over cliff
 * edges and in flight) and the hull banks into lateral slide. Pure
 * function of (velocity, heading) so every client derives the identical
 * attitude with no extra netcode; callers smooth the result per frame.
 */
export function vehicleAttitude(
  type: VehicleType,
  vx: number, vy: number, vz: number,
  heading: number,
): { pitch: number; roll: number } {
  const hspeed = Math.hypot(vx, vz);
  const speed = Math.hypot(hspeed, vy);
  if (speed < 1.5) return { pitch: 0, roll: 0 };
  // Weight by speed so a barely-rolling hull doesn't twitch.
  const engage = Math.min(1, (speed - 1.5) / 4);
  const heavy = type === VEHICLE.TANK ? 0.55 : 1;
  // Nose along the velocity slope. With forward = -Z, positive rotation.x
  // is nose-UP, matching climbing (vy > 0). The hspeed floor keeps a
  // near-vertical fall pegged at the nose-down clamp instead of blowing up.
  const slope = Math.atan2(vy, Math.max(2, hspeed));
  const pitch = Math.max(-0.75, Math.min(0.6, slope)) * engage * heavy;
  // Body-roll outward from lateral slide: velocity lagging right of the
  // heading during a hard left turn dips the right side, like suspension.
  const lateral = vx * Math.cos(heading) - vz * Math.sin(heading);
  const roll = Math.max(-0.3, Math.min(0.3, -lateral * 0.03)) * engage * heavy;
  return { pitch, roll };
}

function jeepTemplate(): THREE.Group {
  const root = new THREE.Group(), hull = new VehicleGeometry(), glass = new VehicleGeometry();
  hull.loft([
    { z: -1.82, y: 0.91, w: 0.81, h: 0.23 },
    { z: -1.3, y: 0.98, w: 0.9, h: 0.27 },
    { z: 1.65, y: 0.94, w: 0.9, h: 0.3 },
  ], BODY);
  hull.box(1.34, 0.07, 1.05, 0, 1.26, -1.03, 0x83916b); // raised hood
  hull.box(1.92, 0.18, 0.2, 0, 0.67, -1.89, DARK);
  hull.box(1.94, 0.17, 0.18, 0, 0.67, 1.78, DARK);
  hull.box(1.08, 0.31, 0.04, 0, 0.99, -1.847, DARK);
  for (let i = -3; i <= 3; i++) hull.box(0.065, 0.29, 0.065, i * 0.14, 0.99, -1.876, METAL);
  hull.box(1.26, 0.09, 0.1, 0, 1.3, -1.88, METAL); // bull bar
  for (const side of [-1, 1]) {
    hull.tube(0.038, [side * 0.66, 0.74, -1.93], [side * 0.66, 1.3, -1.93], METAL, 6);
    hull.tube(0.15, [side * 0.67, 1.04, -1.84], [side * 0.67, 1.04, -1.91], DARK, 12);
    hull.tube(0.112, [side * 0.67, 1.04, -1.912], [side * 0.67, 1.04, -1.922], 0xffe6a8, 12);
    hull.box(0.15, 0.12, 0.05, side * 0.69, 1.06, 1.954, 0xc94d36);
    hull.box(0.16, 0.12, 2.2, side * 0.98, 0.72, 0.02, DARK); // running board
    for (const z of [-1.18, 1.13]) hull.box(0.4, 0.13, 1.04, side * 0.95, 1.02, z, BODY);
    hull.box(0.055, 0.5, 1.65, side * 0.92, 1.17, 0.38, 0x5d6e49); // doors
    hull.box(0.065, 0.045, 0.19, side * 0.955, 1.34, 0.5, DARK);
    hull.box(0.1, 0.1, 1.73, side * 0.87, 1.96, 0.35, DARK);
    hull.tube(0.042, [side * 0.83, 1.23, -0.64], [side * 0.79, 1.94, -0.4], DARK, 6);
    hull.tube(0.046, [side * 0.87, 1.22, 1.22], [side * 0.82, 1.93, 1.12], DARK, 6);
    hull.box(0.075, 0.59, 0.075, side * 0.87, 1.65, 0.41, DARK);
    hull.box(0.2, 0.22, 0.1, side * 1.045, 1.61, -0.43, DARK); // mirrors
    hull.box(0.13, 0.16, 0.025, side * 1.045, 1.62, -0.369, 0x8aa4a2);
    glass.box(0.025, 0.38, 0.72, side * 0.864, 1.66, 0.0, GLASS);
    glass.box(0.025, 0.38, 0.6, side * 0.845, 1.66, 0.81, GLASS);
    hull.box(0.05, 0.025, 0.32, side * 0.38, 1.26, -1.1, DARK);
  }
  hull.box(1.8, 0.11, 1.64, 0, 2.0, 0.36, BODY);
  glass.box(1.51, 0.52, 0.035, 0, 1.64, -0.514, GLASS, -0.32);
  glass.box(1.4, 0.37, 0.035, 0, 1.65, 1.17, GLASS);
  hull.box(0.06, 0.62, 0.06, 0, 1.65, -0.52, DARK, -0.32);
  hull.box(1.66, 0.08, 0.08, 0, 1.37, -0.61, DARK);
  // Roof-mounted receiver and cylindrical barrel keep the gun recognizable.
  hull.tube(0.055, [0.42, 2.035, 0.52], [0.42, 2.16, 0.52], METAL, 6);
  const turret = new THREE.Group(); turret.name = 'turret';
  turret.position.set(0.42, 2.16, 0.52);
  const elevation = new THREE.Group(); elevation.name = 'weapon-elevation';
  const machineGun = new VehicleGeometry();
  machineGun.box(0.18, 0.14, 0.45, 0, 0.01, -0.14, DARK);
  machineGun.tube(0.038, [0, 0.02, -0.34], [0, 0.02, -1.13], DARK, 8);
  machineGun.box(0.21, 0.18, 0.25, 0.18, -0.01, -0.11, 0x928367);
  elevation.add(machineGun.mesh(ARMOR, 'jeep-machine-gun'));
  const muzzle = new THREE.Object3D(); muzzle.name = 'weapon-muzzle';
  muzzle.position.set(0, 0.02, -1.15); elevation.add(muzzle);
  turret.add(elevation); root.add(turret);
  // Spare tire, jerrycan, tow eyes and bumper hardware are part of the static batch.
  hull.tube(0.39, [0, 1.31, 1.75], [0, 1.31, 2.02], DARK, 14);
  hull.tube(0.2, [0, 1.31, 2.023], [0, 1.31, 2.04], BODY, 10);
  hull.box(0.31, 0.47, 0.19, -0.59, 1.26, 1.85, 0x9b8d60);
  hull.box(0.22, 0.055, 0.1, -0.59, 1.53, 1.85, DARK);
  root.add(hull.mesh(ARMOR, 'body'), glass.mesh(WINDOWS, 'glass'));

  const wheel = new VehicleGeometry();
  wheel.tube(0.46, [-0.185, 0, 0], [0.185, 0, 0], DARK, 14);
  for (const side of [-1, 1]) {
    wheel.tube(0.255, [side * 0.186, 0, 0], [side * 0.205, 0, 0], METAL, 10);
    wheel.tube(0.105, [side * 0.206, 0, 0], [side * 0.218, 0, 0], 0x8b9879, 8);
    for (let i = 0; i < 5; i++) {
      const a = i * Math.PI * 2 / 5;
      wheel.box(0.017, 0.063, 0.063, side * 0.223, Math.cos(a) * 0.163, Math.sin(a) * 0.163, DARK, a);
    }
  }
  for (let i = 0; i < 14; i++) {
    const a = i * Math.PI * 2 / 14;
    wheel.box(0.37, 0.055, 0.125, 0, Math.cos(a) * 0.455, Math.sin(a) * 0.455, 0x303839, a);
  }
  const wheelMesh = wheel.mesh(ARMOR, 'wheel');
  for (const side of [-1, 1]) {
    for (const z of [-1.18, 1.13]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 1.0, 0.485, z);
      pivot.name = z < 0 ? 'steering' : 'axle';
      pivot.add(wheelMesh.clone());
      root.add(pivot);
    }
  }
  return root;
}

function tankTemplate(): THREE.Group {
  const root = new THREE.Group(), hull = new VehicleGeometry(), gun = new VehicleGeometry();
  hull.loft([
    { z: -2.25, y: 0.9, w: 1.27, h: 0.16 },
    { z: -1.5, y: 1.05, w: 1.45, h: 0.42 },
    { z: 1.85, y: 1.03, w: 1.43, h: 0.42 },
    { z: 2.2, y: 0.98, w: 1.24, h: 0.26 },
  ], TANK_BODY);
  for (const side of [-1, 1]) {
    // The belt has a chamfered silhouette, individual top/bottom shoes and
    // exposed circular road wheels, all merged with the stationary hull.
    const x = side < 0 ? -1.65 : 1.13;
    hull.prism([[x, 0.11, -1.84], [x, 0.11, 1.86], [x, 0.4, 2.33], [x, 0.85, 2.3], [x, 1.0, 1.87], [x, 1.0, -1.88], [x, 0.76, -2.33], [x, 0.38, -2.33]], [0.52, 0, 0], DARK);
    for (let i = 0; i < 6; i++) {
      const z = -1.74 + i * 0.7;
      hull.tube(0.355, [side * 1.48, 0.48, z], [side * 1.673, 0.48, z], METAL, 12);
      hull.tube(0.25, [side * 1.675, 0.48, z], [side * 1.69, 0.48, z], TANK_BODY, 10);
      hull.tube(0.084, [side * 1.694, 0.48, z], [side * 1.71, 0.48, z], 0x9ba183, 8);
    }
    for (let i = 0; i < 17; i++) {
      const z = -1.88 + i * 0.23;
      hull.box(0.55, 0.055, 0.1, side * 1.39, 0.105, z, METAL);
      hull.box(0.55, 0.055, 0.1, side * 1.39, 1.035, z, METAL);
    }
    for (let i = 0; i < 4; i++) {
      hull.box(0.11, 0.43, 0.79, side * 1.65, 1.04, -1.34 + i * 0.89, i % 2 ? 0x7b8465 : TANK_BODY, 0, 0, side * 0.1);
    }
    hull.box(0.24, 0.14, 0.12, side * 1.02, 1.21, -1.99, 0xf0dfa7);
    hull.box(0.17, 0.11, 0.06, side * 1.11, 1.03, 2.211, 0xbc5b42);
    hull.tube(0.12, [side * 0.95, 1.49, 1.75], [side * 0.95, 1.5, 2.18], DARK, 8);
  }
  for (let i = 0; i < 8; i++) hull.box(1.65, 0.035, 0.075, 0, 1.466, 1.02 + i * 0.12, DARK);
  hull.box(1.78, 0.07, 0.39, 0, 1.46, -1.2, 0x899173, 0.25);
  hull.tube(0.83, [0, 1.45, 0.25], [0, 1.61, 0.25], DARK, 16);
  root.add(hull.mesh(ARMOR, 'body'));
  const turret = new THREE.Group();
  turret.name = 'turret';
  turret.position.set(0, 1.98, 0.25);
  const barrel = new VehicleGeometry();
  gun.loft([
    { z: -1.1, y: 1.9, w: 0.73, h: 0.2 },
    { z: -0.48, y: 1.98, w: 1.06, h: 0.36 },
    { z: 0.85, y: 1.98, w: 0.99, h: 0.35 },
    { z: 1.23, y: 1.91, w: 0.8, h: 0.21 },
  ], TANK_BODY);
  for (const side of [-1, 1]) {
    gun.box(0.24, 0.37, 1.33, side * 0.95, 2.02, 0.04, 0x7f896b, 0, side * -0.12, side * 0.18);
    gun.box(0.2, 0.31, 0.55, side * 0.88, 2.02, 0.99, 0x8e9273);
    for (let i = 0; i < 3; i++) gun.tube(0.071, [side * 0.91, 2.11, -0.66 + i * 0.17], [side * 1.09, 2.26, -0.74 + i * 0.17], DARK, 6);
  }
  barrel.tube(0.29, [0, 1.98, -0.82], [0, 1.98, -1.46], 0x7e896e, 12);
  barrel.tube(0.115, [0, 1.98, -1.35], [0, 1.98, -3.92], METAL, 12, 0.085);
  barrel.tube(0.17, [0, 1.98, -2.48], [0, 1.98, -2.93], TANK_BODY, 12);
  barrel.tube(0.13, [0, 1.98, -3.72], [0, 1.98, -4.0], DARK, 10);
  barrel.tube(0.082, [0, 1.98, -4.002], [0, 1.98, -4.012], 0x0c151a, 10);
  gun.tube(0.3, [-0.34, 2.32, 0.41], [-0.34, 2.43, 0.41], METAL, 12);
  gun.tube(0.26, [-0.34, 2.43, 0.41], [-0.34, 2.48, 0.41], 0x879174, 12);
  gun.box(0.34, 0.18, 0.25, 0.35, 2.4, -0.11, DARK);
  gun.box(0.23, 0.08, 0.02, 0.35, 2.43, -0.247, 0x7bc9d1);
  gun.tube(0.018, [0.72, 2.25, 0.89], [0.75, 2.74, 0.93], DARK, 5);
  const armor = gun.mesh(ARMOR, 'turret-armor'); armor.position.y = -1.98;
  const elevation = new THREE.Group(); elevation.name = 'weapon-elevation';
  elevation.position.z = -0.82;
  const barrelMesh = barrel.mesh(ARMOR, 'tank-cannon'); barrelMesh.position.set(0, -1.98, 0.82);
  elevation.add(barrelMesh); turret.add(armor, elevation);
  const muzzle = new THREE.Object3D(); muzzle.name = 'weapon-muzzle';
  muzzle.position.set(0, 0, -3.192); elevation.add(muzzle);
  root.add(turret);
  return root;
}

function jetTemplate(): THREE.Group {
  const root = new THREE.Group(), hull = new VehicleGeometry(), glass = new VehicleGeometry();
  hull.tube(0.055, [0, 0.99, -2.5], [JET_GUN_MUZZLE.x, JET_GUN_MUZZLE.y, JET_GUN_MUZZLE.z], DARK, 8);
  const muzzle = new THREE.Object3D(); muzzle.name = 'weapon-muzzle';
  muzzle.position.copy(JET_GUN_MUZZLE); root.add(muzzle);
  hull.loft([
    { z: -3.8, y: 1.12, w: 0.035, h: 0.035 },
    { z: -2.72, y: 1.25, w: 0.38, h: 0.29 },
    { z: -1.3, y: 1.26, w: 0.61, h: 0.46 },
    { z: 0.9, y: 1.17, w: 0.65, h: 0.45 },
    { z: 2.65, y: 1.16, w: 0.44, h: 0.36 },
    { z: 3.15, y: 1.16, w: 0.33, h: 0.28 },
  ], JET_BODY);
  hull.loft([{ z: -3.81, y: 1.12, w: 0.035, h: 0.035 }, { z: -3.12, y: 1.203, w: 0.245, h: 0.197 }], 0x637780);
  glass.loft([
    { z: -2.16, y: 1.54, w: 0.1, h: 0.09 },
    { z: -1.51, y: 1.75, w: 0.355, h: 0.345 },
    { z: -0.68, y: 1.77, w: 0.34, h: 0.28 },
    { z: -0.23, y: 1.58, w: 0.12, h: 0.12 },
  ], GLASS);
  hull.tube(0.025, [0, 1.7, -2.1], [0, 2.08, -1.46], 0x71878e, 5);
  hull.tube(0.023, [0, 2.08, -1.46], [0, 2.025, -0.69], 0x71878e, 5);
  for (const side of [-1, 1]) {
    // Swept leading edge, clipped tips and trailing control surfaces replace
    // the old rectangular wings. Thickness is real geometry, not alpha cards.
    hull.prism([[side * 0.43, 1.09, -1.6], [side * 3.65, 1.08, 0.61], [side * 3.55, 1.08, 1.34], [side * 0.47, 1.09, 0.91]], [0, 0.105, 0], JET_BODY);
    hull.prism([[side * 1.3, 1.201, 0.86], [side * 3.52, 1.191, 1.14], [side * 3.5, 1.191, 1.34], [side * 1.26, 1.201, 1.05]], [0, 0.012, 0], 0x62777e);
    hull.prism([[side * 0.29, 1.41, 1.84], [side * 1.62, 1.4, 2.62], [side * 1.5, 1.4, 3.2], [side * 0.29, 1.41, 2.94]], [0, 0.075, 0], 0x8a9da5);
    hull.prism([[side * 0.38, 1.34, 1.29], [side * 0.84, 2.57, 2.5], [side * 0.91, 2.6, 3.08], [side * 0.4, 1.35, 2.99]], [side * 0.075, 0, 0], JET_BODY);
    hull.prism([[side * 0.805, 2.41, 2.37], [side * 0.85, 2.56, 2.52], [side * 0.913, 2.59, 3.07], [side * 0.855, 2.4, 2.98]], [side * 0.012, 0, 0], 0xd68743);
    hull.box(0.33, 0.3, 0.46, side * 0.65, 1.06, -0.93, 0x506873, 0.15, side * 0.12);
    hull.box(0.3, 0.2, 0.025, side * 0.65, 1.05, -1.17, 0x142b36, 0.15); // dark intake mouths
    hull.box(0.06, 0.22, 0.62, side * 1.77, 0.96, 0.29, METAL);
    hull.tube(0.1, [side * 1.77, 0.79, -0.43], [side * 1.77, 0.79, 1.04], 0xc9cab8, 8);
    hull.tube(0.105, [side * 1.77, 0.79, -0.43], [side * 1.77, 0.79, -0.72], 0x637576, 8, 0.012);
    hull.box(0.28, 0.025, 0.42, side * 2.88, 1.198, 0.7, 0x304f60);
    hull.box(0.12, 0.06, 0.17, side * 3.58, 1.16, 1.16, side < 0 ? 0xdb6b57 : 0x75bd92);
    hull.tube(0.042, [side * 0.83, 0.2, 1.08], [side * 0.72, 0.94, 0.97], METAL, 6);
    hull.tube(0.23, [side * 0.75, 0.24, 1.08], [side * 0.93, 0.24, 1.08], DARK, 10);
    hull.box(0.18, 0.43, 0.53, side * 0.66, 0.72, 0.99, JET_BODY, 0, 0, side * 0.2);
  }
  hull.tube(0.04, [0, 0.23, -2.08], [0, 0.98, -1.99], METAL, 6);
  hull.tube(0.19, [-0.11, 0.2, -2.08], [0.11, 0.2, -2.08], DARK, 10);
  hull.tube(0.31, [0, 1.16, 2.77], [0, 1.16, 3.27], METAL, 14, 0.33);
  hull.tube(0.267, [0, 1.16, 3.271], [0, 1.16, 3.284], 0x17232a, 14);
  hull.box(.5,.12,.7,0,.78,.6,DARK);
  hull.tube(.17,[0,.78,.6],[0,.33,.6],METAL,8);
  hull.tube(.12,[0,.32,.6],[0,.28,.6],0x10161c,8);
  root.add(hull.mesh(ARMOR, 'body'), glass.mesh(WINDOWS, 'glass'));
  const exhaust = new VehicleGeometry();
  exhaust.tube(0.23, [0, 0, 0], [0, 0, 0.9], 0x4a99ed, 10, 0.025);
  exhaust.tube(0.14, [0, 0, 0.01], [0, 0, 0.55], 0xa9e2ff, 8, 0.035);
  const flame = exhaust.mesh(GLOW, 'exhaust');
  flame.position.set(0, 1.16, 3.29);
  flame.castShadow = false;
  flame.receiveShadow = false;
  flame.visible = false;
  root.add(flame);
  return root;
}

/** Curved airfoil ribbon: shaped sections make continuous blades, not flat wedges. */
function crescentRibbon(batch:VehicleGeometry, points:THREE.Vector3[], width:number, color:number):void {
  const curve=new THREE.CatmullRomCurve3(points),vertices:number[]=[],indices:number[]=[];
  const cross=[[-1,0],[-.65,.11],[.45,.10],[1,0],[.4,-.05],[-.7,-.055]];
  for(let i=0;i<=28;i++){
    const t=i/28,p=curve.getPoint(t),d=curve.getTangent(t),n=new THREE.Vector3(-d.z,0,d.x).normalize();
    const w=width*(.10+.90*Math.sin(Math.PI*(t*.88+.08)))*(1-t*.82);
    for(const [side,up] of cross)vertices.push(p.x+n.x*side*w,p.y+up*(.6+w),p.z+n.z*side*w);
    if(i>0)for(let j=0;j<6;j++){const a=(i-1)*6+j,b=(i-1)*6+(j+1)%6;indices.push(a,b,b+6,a,b+6,a+6);}
  }
  for(let i=1;i<5;i++)indices.push(0,i+1,i,168,168+i,168+i+1);
  const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));geo.setIndex(indices);batch.add(geo,color);
}

/** Skeletal crescent glider: open wing chambers and curved swept ribs surround a living-machine spine. */
function nocturneTemplate(): THREE.Group {
  const root=new THREE.Group(),hull=new VehicleGeometry(),glass=new VehicleGeometry(),glow=new VehicleGeometry();
  const obsidian=0x252432,edge=0x686075,violet=0xc360ee;
  hull.loft([{z:-4.3,y:1.08,w:.018,h:.02},{z:-3.0,y:1.16,w:.34,h:.19},
    {z:-1.4,y:1.30,w:.64,h:.37},{z:.2,y:1.18,w:.53,h:.36},
    {z:2.1,y:1.23,w:.34,h:.22},{z:4.1,y:1.45,w:.03,h:.025}],obsidian);
  glass.loft([{z:-2.65,y:1.41,w:.04,h:.025},{z:-1.7,y:1.73,w:.32,h:.24},
    {z:-.6,y:1.72,w:.34,h:.23},{z:.2,y:1.43,w:.025,h:.025}],0x503553);
  for(const side of [-1,1]){
    const p=(x:number,y:number,z:number)=>new THREE.Vector3(side*x,y,z);
    const rim=[p(.45,1.18,-.8),p(2.4,1.46,1.05),p(4.6,1.65,.54),p(5.25,1.30,-1.25),p(3.7,1.06,-3.55)];
    crescentRibbon(hull,rim,.88,obsidian);
    const inner=[p(.5,1.20,.2),p(2.25,1.4,1.65),p(4.2,1.5,.9),p(4.65,1.22,-.8),p(3.6,1.08,-3.2)];
    crescentRibbon(hull,inner,.18,edge);
    const luminous=new THREE.CatmullRomCurve3(rim.map(v=>v.clone().add(new THREE.Vector3(0,.105,0))));
    glow.add(new THREE.TubeGeometry(luminous,30,.026,5,false),violet);
    // Curving ribs leave large real openings through the wing.
    for(let i=0;i<6;i++){
      const a=i/5,arc=[p(.47+a*.20,1.27,.30+a*1.55),p(1.1+a*.38,1.78,.72+a*.73),
        p(2.0+a*.37,1.74,.74+a*.58),p(2.65+a*1.2,1.46,1.14-a*.06)];
      hull.add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(arc),11,.041,6,false),i%2?edge:0x443e52);
    }
    crescentRibbon(hull,[p(.29,1.3,1.3),p(1.38,1.70,2.35),p(1.75,1.92,3.23),p(.82,1.47,4.05)],.33,edge);
    crescentRibbon(hull,[p(.30,1.38,.5),p(.76,1.9,1.4),p(.55,2.23,2.8),p(.19,1.54,3.95)],.15,obsidian);
    for(let i=0;i<5;i++)hull.prism([[side*(.48+i*.05),1.24+i*.015,-.3+i*.30],
      [side*(.74+i*.07),1.34+i*.03,-.05+i*.30],[side*(.68+i*.07),1.12,-.01+i*.30]], [0,0,.10],edge);
    hull.tube(.18,[side*.59,1.02,1.25],[side*.59,1.02,2.38],edge,14,.26);
    glow.tube(.215,[side*.59,1.02,2.39],[side*.59,1.02,2.415],violet,14);
    hull.tube(.06,[side*.54,.18,.9],[side*.40,.94,.6],edge,8);
    hull.box(.22,.13,.85,side*.55,.17,.72,obsidian);
  }
  // A visible iris and nine small emitters explain the scatterstorm weapon.
  hull.tube(.16,[0,.99,-2.9],[0,.99,-3.27],edge,16,.13);
  for(let i=0;i<9;i++){const a=i*Math.PI*2/9;
    glow.tube(.018,[Math.cos(a)*.082,.99+Math.sin(a)*.082,-3.27],[Math.cos(a)*.082,.99+Math.sin(a)*.082,-3.31],0xe3a7ff,6);}
  glow.add(new THREE.OctahedronGeometry(.18),0xdb9cff,[0,.69,.2]);
  hull.box(.5,.12,.7,0,.78,.6,obsidian);
  hull.tube(.17,[0,.78,.6],[0,.33,.6],edge,8);
  hull.tube(.12,[0,.32,.6],[0,.28,.6],0x10161c,8);
  hull.tube(.055,[0,.18,-2.1],[0,.95,-1.95],edge,8);hull.box(.22,.12,.6,0,.12,-2.12,obsidian);
  const muzzle=new THREE.Object3D();muzzle.name='weapon-muzzle';muzzle.position.copy(JET_GUN_MUZZLE);
  root.add(hull.mesh(ARMOR,'body'),glass.mesh(WINDOWS,'glass'),glow.mesh(GLOW,'lance-conduits'),muzzle);
  const exhaust=new VehicleGeometry();for(const side of [-1,1])exhaust.tube(.22,[side*.59,0,0],[side*.59,0,1.4],violet,12,.02);
  const flame=exhaust.mesh(GLOW,'exhaust');flame.position.set(0,1.02,2.43);flame.visible=false;flame.castShadow=false;root.add(flame);
  root.scale.setScalar(NOCTURNE_SCALE);
  return root;
}

/** Broad siege chassis with crenellated armor cheeks and a ringed heavy gun. */
function bastionTemplate(): THREE.Group {
  const root = new THREE.Group(), hull = new VehicleGeometry(), gun = new VehicleGeometry(), barrel = new VehicleGeometry();
  const ivory = 0xb5b5a0, shade = 0x737b78, gold = 0xc49b55, red = 0x652b36;
  hull.loft([{ z: -2.85, y: 1.03, w: 1.30, h: .20 }, { z: -1.8, y: 1.15, w: 1.68, h: .53 },
    { z: 2.2, y: 1.14, w: 1.68, h: .51 }, { z: 2.7, y: 1.06, w: 1.4, h: .35 }], shade);
  for (const side of [-1, 1]) {
    const x = side < 0 ? -2.0 : 1.3;
    hull.prism([[x,.12,-2.2],[x,.12,2.17],[x,.5,2.8],[x,1.15,2.5],[x,1.3,-2.35],[x,.7,-2.88]], [.7,0,0], DARK);
    for (let i = 0; i < 7; i++) {
      const z = -2.13 + i * .7;
      hull.tube(.40, [side * 1.65,.56,z], [side * 2.025,.56,z], shade, 12);
      hull.tube(.22, [side * 2.028,.56,z], [side * 2.043,.56,z], gold, 10);
    }
    for (let i = 0; i < 20; i++) {
      hull.box(.72,.08,.13, side * 1.65,.12,-2.28+i*.235, METAL);
      hull.box(.72,.07,.13, side * 1.65,1.31,-2.28+i*.235, METAL);
    }
    for (let i = 0; i < 5; i++) {
      hull.box(.17,.64,.83,side*1.985,1.18,-1.82+i*.90,ivory,0,0,side*.12);
      hull.box(.035,.22,.70,side*2.085,1.34,-1.82+i*.90,red);
      hull.box(.042,.075,.83,side*2.1,.99,-1.82+i*.90,gold);
    }
    hull.box(.36,.18,.16,side*1.08,1.23,-2.62,0xffe8af);
    hull.box(.36,.24,.72,side*1.14,1.70,1.48,ivory);
    hull.tube(.12,[side*.95,1.59,2.3],[side*.95,2.06,2.44],DARK,10);
    hull.box(.22,.08,1.46,side*.82,1.70,-1.38,red,.18);
  }
  for(let i=0;i<9;i++) hull.box(1.2,.06,.09,0,1.68,1.25+i*.13,DARK);
  hull.tube(1.0,[0,1.6,.2],[0,1.84,.2],gold,20);
  for(const side of [-1,1]) {
    // Tall armored sponsons give the enlarged machine a fortress silhouette.
    hull.box(.26,.65,2.8,side*1.88,1.65,.2,ivory);
    hull.box(.05,.25,2.6,side*2.025,1.72,.2,red);
    for(let i=0;i<4;i++)hull.box(.32,.16,.36,side*1.89,2.05,-.95+i*.72,gold);
  }
  // An armored reactor deck replaces the former upward-facing artillery rack.
  hull.box(1.9,.25,.8,0,1.89,1.75,shade);
  for(let i=-3;i<=3;i++) hull.box(.12,.045,.62,i*.24,2.038,1.75,gold);
  root.add(hull.mesh(ARMOR,'body'));
  const turret = new THREE.Group(); turret.name='turret'; turret.position.set(0,2.3,.2);
  gun.loft([{z:-1.2,y:0,w:.85,h:.23},{z:-.65,y:.03,w:1.26,h:.47},
    {z:1.2,y:.02,w:1.24,h:.44},{z:1.48,y:-.02,w:.92,h:.3}],ivory);
  for(const side of [-1,1]) {
    gun.box(.22,.48,1.60,side*1.25,.03,.18,shade,0,side*-.08,side*.1);
    for(let i=0;i<4;i++) gun.box(.3,.23,.26,side*1.2,.47,-.58+i*.49,ivory);
    gun.box(.035,.32,.72,side*1.39,.10,.15,red);
    gun.tube(.075,[side*1.02,.33,-.55],[side*1.17,.51,-.85],gold,8);
  }
  gun.tube(.37,[-.48,.48,.57],[-.48,.65,.57],shade,16);
  gun.box(.30,.15,.36,.44,.55,.04,DARK);
  gun.box(.22,.07,.035,.44,.58,-.16,0xa4e2e3);
  const elevation=new THREE.Group(); elevation.name='weapon-elevation';
  barrel.tube(.37,[0,0,-.72],[0,0,-1.42],shade,16);
  barrel.tube(.19,[0,0,-1.22],[0,0,-4.60],METAL,16,.145);
  for(const z of [-1.54,-2.15,-2.75]) barrel.tube(.26,[0,0,z],[0,0,z-.17],gold,16);
  barrel.box(.49,.42,.58,0,0,-4.39,shade);
  barrel.tube(.139,[0,0,-4.685],[0,0,-4.71],0x111c21,16);
  barrel.box(.12,.055,1.3,0,.205,-2.05,0x9edbde);
  for(const side of [-1,1]) {
    barrel.tube(.052,[side*.27,0,-1.5],[side*.27,0,-4.45],gold,8);
    barrel.tube(.035,[side*.265,.065,-1.5],[side*.265,.065,-4.45],0xa6e8ed,8);
    gun.prism([[side*.92,.28,.44],[side*1.3,.75,.7],[side*1.13,.89,1.22],[side*.94,.3,1.31]],[0,0,.05],gold);
  }
  barrel.tube(.25,[0,0,-3.9],[0,0,-4.57],shade,16,.21);
  barrel.tube(.158,[0,0,-4.716],[0,0,-4.735],0xb7f3f0,16);
  elevation.add(barrel.mesh(ARMOR,'siege-cannon'));
  const muzzle=new THREE.Object3D(); muzzle.name='weapon-muzzle'; muzzle.position.set(0,0,-4.73); elevation.add(muzzle);
  turret.add(gun.mesh(ARMOR,'turret-armor'),elevation); root.add(turret); root.scale.setScalar(1.3); return root;
}

/** Keel-origin patrol hull; the fluid solver floats it at surfaceY - draft. */
function gunboatTemplate():THREE.Group {
  const root=new THREE.Group(),hull=new VehicleGeometry(),glass=new VehicleGeometry();
  const navy=0x425763,deck=0x85908b,trim=0xd2c9a7;
  hull.loft([{z:-5.3,y:1.15,w:.02,h:.15},{z:-3.65,y:.85,w:1.72,h:.72},
    {z:1.7,y:.72,w:2.12,h:.67},{z:4.7,y:.65,w:1.72,h:.60}],navy);
  hull.box(3.7,.12,7.3,0,1.45,.68,deck);
  hull.box(2.7,1.08,2.5,0,2.01,1.0,navy);
  hull.box(2.94,.16,2.73,0,2.63,1.0,trim);
  glass.box(2.43,.53,.04,0,2.18,-.274,0x416c79);
  for(const side of [-1,1]) {
    glass.box(.035,.52,1.9,side*1.37,2.18,.88,0x416c79);
    hull.box(.10,.69,.08,side*.42,2.14,-.29,navy);
    for(let i=0;i<6;i++) {
      const z=-2.65+i*1.15;
      hull.tube(.035,[side*1.87,1.43,z],[side*1.87,1.92,z],trim,6);
    }
    hull.tube(.038,[side*1.87,1.92,-2.65],[side*1.87,1.92,3.1],trim,6);
    hull.tube(.11,[side*1.10,1.48,3.13],[side*1.10,2.15,3.13],DARK,10);
    hull.add(new THREE.TorusGeometry(.34,.08,6,14),0xd08345,[side*2.12,1.13,1.75],[0,Math.PI/2,0]);
    hull.box(.15,.10,.28,side*1.8,1.7,-2.8,side<0?0xdf6952:0x87c58f);
    for(let i=0;i<3;i++) hull.box(.25,.04,.92,side*.85,1.55,3.1+i*.3,DARK);
  }
  hull.tube(.075,[0,2.71,1.65],[0,4.5,1.65],METAL,8);
  hull.box(1.65,.08,.13,0,4.13,1.65,trim);
  hull.box(.65,.14,.32,0,4.49,1.65,deck);
  hull.tube(.10,[0,1.43,-4.1],[0,1.85,-4.1],DARK,8);
  root.add(hull.mesh(ARMOR,'body'),glass.mesh(WINDOWS,'glass'));
  const turret=new THREE.Group();turret.name='turret';turret.position.copy(GUNBOAT_GUN_PIVOT);
  const armor=new VehicleGeometry();
  armor.loft([{z:-.65,y:0,w:.52,h:.2},{z:0,y:.03,w:.72,h:.39},{z:.62,y:.02,w:.55,h:.3}],navy);
  armor.box(.55,.07,.48,0,.42,.12,deck);
  turret.add(armor.mesh(ARMOR,'deck-turret'));
  const elevation=new THREE.Group();elevation.name='weapon-elevation';
  const barrel=new VehicleGeometry();
  barrel.tube(.25,[0,0,-.38],[0,0,-1.0],deck,14);
  barrel.tube(.14,[0,0,-.8],[0,0,-2.25],METAL,14,.11);
  barrel.tube(.20,[0,0,-2.0],[0,0,-GUNBOAT_BARREL_LENGTH],DARK,14,.16);
  barrel.tube(.105,[0,0,-2.401],[0,0,-2.408],0x10191d,14);
  const muzzle=new THREE.Object3D();muzzle.name='weapon-muzzle';muzzle.position.z=-GUNBOAT_BARREL_LENGTH;
  elevation.add(barrel.mesh(ARMOR,'deck-cannon'),muzzle);turret.add(elevation);root.add(turret);
  return root;
}

/** A four-engine heavy bomber, 19 m long with a 16 m straight wing, so it
 * parks inside a runway's edge lights. Ground contact is the origin. */
function condorTemplate():THREE.Group {
  const root=new THREE.Group(),body=new VehicleGeometry(),glass=new VehicleGeometry();
  const skin=0x6f7a6b,belly=0x4f5850,trim=0xc8c09a;
  body.loft([{z:-9.6,y:2.1,w:.25,h:.35},{z:-8.4,y:2.25,w:1,h:1},{z:-5,y:2.35,w:1.3,h:1.3},
    {z:4,y:2.4,w:1.25,h:1.25},{z:8,y:2.7,w:.7,h:.7},{z:9.6,y:3,w:.25,h:.25}],skin);
  body.box(16,.36,4.4,0,2.6,.5,skin);
  body.box(.3,3.2,2.4,0,4.2,8.6,skin);
  body.box(5.6,.24,1.8,0,3,8.8,skin);
  for(const side of [-1,1]) {
    for(const x of [2.6,5.4]) {
      body.tube(.5,[side*x,2.15,-3.4],[side*x,2.15,1],belly,12,.42);
      body.tube(.14,[side*x,2.15,-3.45],[side*x,2.15,-3.85],DARK,8);
      body.add(new THREE.CylinderGeometry(.95,.95,.04,18),0x1b1f22,[side*x,2.15,-3.55],[Math.PI/2,0,0]);
    }
    body.box(.22,.12,.5,side*7.9,2.62,.2,side<0?0xdf6952:0x87c58f);
    body.tube(.12,[side*2.6,1.6,0],[side*2.6,.3,0],METAL,6);
    body.add(new THREE.CylinderGeometry(.4,.4,.35,12),DARK,[side*2.6,.4,0],[0,0,Math.PI/2]);
  }
  body.tube(.1,[0,1.3,-7.4],[0,.3,-7.4],METAL,6);
  body.add(new THREE.CylinderGeometry(.3,.3,.28,12),DARK,[0,.3,-7.4],[0,0,Math.PI/2]);
  body.box(1.6,.1,4,0,1.06,.4,DARK);
  glass.box(1.6,.7,1.4,0,2.95,-8.2,0x416c79);
  root.add(body.mesh(ARMOR,'body'),glass.mesh(WINDOWS,'glass'));
  const muzzle=new THREE.Object3D();muzzle.name='weapon-muzzle';muzzle.position.set(0,2.05,-10.1);root.add(muzzle);
  return root;
}

/** Keel-origin capital ship, 34 m long. The bridge aims the forward battery;
 * the stern mount's AA launcher is drawn as the crew weapon. */
function destroyerTemplate():THREE.Group {
  const root=new THREE.Group(),hull=new VehicleGeometry(),glass=new VehicleGeometry();
  const grey=0x56646e,deck=0x7d847f,trim=0xc9c3a3,band=0x2c3438;
  hull.loft([{z:-17.4,y:2.7,w:.05,h:.5},{z:-15,y:2.05,w:1.9,h:1.55},{z:-10,y:1.75,w:3.3,h:1.72},
    {z:4,y:1.7,w:3.6,h:1.7},{z:13,y:1.75,w:3.25,h:1.72},{z:16,y:1.9,w:2.7,h:1.5}],grey);
  // Deck and waterline band follow the hull's taper toward bow and stern.
  hull.box(6.9,.14,23,0,3.4,1.5,deck);hull.box(5.4,.14,2.5,0,3.4,-11.25,deck);
  hull.box(3.4,.14,2.5,0,3.4,-13.75,deck);hull.box(5.8,.14,3,0,3.4,14.5,deck);
  hull.box(7.3,.18,23,0,1.45,1.5,band);hull.box(4.6,.18,5,0,1.45,-12.5,band);hull.box(6,.18,3,0,1.45,14.5,band);
  hull.box(5.2,3.2,6.4,0,5,-3.5,grey);
  hull.box(3.8,1.6,3.8,0,7.4,-4.2,grey);
  hull.box(4.1,.16,4.1,0,8.25,-4.2,trim);
  glass.box(3.5,.62,.05,0,7.55,-6.12,0x416c79);
  for(const side of [-1,1]) glass.box(.05,.6,3.2,side*1.92,7.55,-4.2,0x416c79);
  hull.box(1.8,4.8,2.4,0,5.8,2.6,grey);
  hull.box(1.9,.4,2.5,0,8.3,2.6,DARK);
  hull.tube(.12,[0,8.3,-2.2],[0,13.2,-2.2],METAL,8);
  hull.box(3.2,.12,.18,0,12.2,-2.2,trim);
  hull.box(1.4,.5,.3,0,13.3,-2.2,deck);
  hull.box(4,1.8,4.8,0,4.3,6.8,grey);
  hull.box(2.6,1.2,2.6,0,4,11.6,deck);
  for(const side of [-1,1]) {
    hull.tube(.04,[side*3.3,4,-9.5],[side*3.3,4,12.5],trim,6);
    for(let i=0;i<12;i++){const z=-9.5+i*2;hull.tube(.035,[side*3.3,3.47,z],[side*3.3,4,z],trim,6);}
  }
  root.add(hull.mesh(ARMOR,'body'),glass.mesh(WINDOWS,'glass'));
  const turret=new THREE.Group();turret.name='turret';turret.position.copy(DESTROYER_BATTERY_PIVOT);
  const armor=new VehicleGeometry();
  armor.loft([{z:-1.3,y:-.1,w:1,h:.5},{z:0,y:0,w:1.45,h:.7},{z:1.4,y:-.05,w:1.2,h:.6}],grey);
  armor.box(2.4,.1,2.6,0,.72,.1,deck);
  turret.add(armor.mesh(ARMOR,'battery-turret'));
  const elevation=new THREE.Group();elevation.name='weapon-elevation';
  const barrels=new VehicleGeometry();
  for(const x of [-.55,0,.55]) {
    barrels.tube(.2,[x,0,-.9],[x,0,-1.6],deck,12);
    barrels.tube(.13,[x,0,-1.5],[x,0,-DESTROYER_BATTERY_LENGTH],METAL,12,.11);
  }
  const muzzle=new THREE.Object3D();muzzle.name='weapon-muzzle';muzzle.position.z=-DESTROYER_BATTERY_LENGTH;
  elevation.add(barrels.mesh(ARMOR,'battery-guns'),muzzle);turret.add(elevation);root.add(turret);
  return root;
}

/** Hull forward is -Z. Resources are shared; transforms are unique per hull. */
export function buildVehicleHull(type: VehicleType, variant = 0): THREE.Group {
  if (type === VEHICLE.NONE) return new THREE.Group();
  variant = validVehicleVariant(type, variant);
  const key = type + variant * 10;
  let template = TEMPLATES.get(key);
  if (!template) {
    template = variant === VEHICLE_VARIANT.CONDOR ? condorTemplate() : variant === VEHICLE_VARIANT.DESTROYER ? destroyerTemplate() : variant === VEHICLE_VARIANT.NOCTURNE ? nocturneTemplate() : variant === VEHICLE_VARIANT.BASTION ? bastionTemplate() : type === VEHICLE.GUNBOAT ? gunboatTemplate() : type === VEHICLE.JEEP ? jeepTemplate() : type === VEHICLE.TANK ? tankTemplate() : jetTemplate();
    template.rotation.order = 'YXZ';
    TEMPLATES.set(key, template);
  }
  const root = template.clone(true);
  root.userData.variant = variant;
  const animation: VehicleAnimation = { wheels: [], steering: [], exhaust: undefined, phase: 0 };
  root.traverse((part) => {
    if (part.name === 'wheel') animation.wheels.push(part);
    else if (part.name === 'steering') animation.steering.push(part);
    else if (part.name === 'exhaust') animation.exhaust = part;
    else if (part.name === 'turret') animation.turret = part;
    else if (part.name === 'weapon-elevation') animation.elevation = part;
    else if (part.name === 'weapon-muzzle') animation.muzzle = part;
  });
  ANIMATION.set(root, animation);
  if (animation.muzzle) {
    animation.flash = new THREE.Mesh(MUZZLE_FLASH_GEOMETRY, variant === VEHICLE_VARIANT.NOCTURNE ? VIOLET_FLASH_MATERIAL : MUZZLE_FLASH_MATERIAL);
    animation.flash.name = 'attached-muzzle-flash';
    animation.flash.visible = false;
    animation.muzzle.add(animation.flash);
  }
  return root;
}

/** Local origin is the flatcar's deck center; copy its position/yaw without scale.
 * aimVehicleWeapon(), vehicleMuzzlePosition() and flashVehicleWeapon() also apply. */
export function trainArtilleryModel():THREE.Group {
  let template=TEMPLATES.get(1000);
  if(!template) {
    template=new THREE.Group();template.userData.artillery=true;
    const base=new VehicleGeometry(),shield=new VehicleGeometry(),barrel=new VehicleGeometry();
    const steel=0x66716a,edge=0x9b9d88,dark=0x2c3539;
    base.box(4.9,.65,7.2,0,.325,0,dark);
    base.tube(2.35,[0,.65,0],[0,1.05,0],METAL,24);
    for(const side of [-1,1]) {
      base.loft([{z:-2.8,y:2.3,w:.27,h:1.6},{z:1.8,y:2.3,w:.27,h:1.6}],steel,side*1.78);
      for(let i=0;i<6;i++)base.box(.36,.12,.75,side*2.15,1.1+i*.4,1.72,edge);
    }
    template.add(base.mesh(ARMOR,'artillery-mount'));
    const turret=new THREE.Group();turret.name='turret';turret.position.copy(TRAIN_ARTILLERY_PIVOT);
    shield.loft([{z:-2.8,y:-.2,w:1.85,h:.65},{z:.2,y:0,w:2.1,h:1.1},{z:3.2,y:-.3,w:1.7,h:.8}],steel);
    for(const side of [-1,1]) {
      shield.tube(.85,[side*1.6,0,0],[side*2.24,0,0],edge,20);
      shield.box(.12,1.2,2.2,side*2.15,.1,.65,0x38424a);
    }
    turret.add(shield.mesh(ARMOR,'artillery-cradle'));
    const elevation=new THREE.Group();elevation.name='weapon-elevation';
    barrel.tube(1.08,[0,0,2.25],[0,0,-3.0],dark,24,.9);
    barrel.tube(.82,[0,0,-2.5],[0,0,-15.1],steel,24,.51);
    for(const z of [-3.2,-5.1,-7.2,-9.2,-11.8,-14.1])barrel.tube(.84+(z+3.2)*.018,[0,0,z],[0,0,z-.28],edge,20);
    for(const side of [-1,1])barrel.tube(.14,[side*.96,-.48,1.55],[side*.96,-.48,-3.3],METAL,12);
    barrel.box(1.65,1.45,1.2,0,0,-15.3,dark);
    barrel.tube(.48,[0,0,-15.91],[0,0,-16.01],0x10181b,24);
    const muzzle=new THREE.Object3D();muzzle.name='weapon-muzzle';muzzle.position.z=-TRAIN_ARTILLERY_BARREL_LENGTH;
    const recoil=new THREE.Group();recoil.name='weapon-recoil';
    recoil.add(barrel.mesh(ARMOR,'artillery-barrel'),muzzle);elevation.add(recoil);turret.add(elevation);template.add(turret);
    TEMPLATES.set(1000,template);
  }
  return articulatedClone(template);
}

/** Standalone hull-pose attachment: add beside the visual hull, not underneath
 * its model scale. Shared hardpoint coordinates already account for variants. */
export function buildCrewWeapon(type:number,variant=0):THREE.Group {
  const key=1100+type+variant*10;let template=TEMPLATES.get(key);
  if(!template) {
    template=new THREE.Group();const turret=new THREE.Group();turret.name='turret';turret.position.copy(crewGunPivot(type,variant));
    const mount=new VehicleGeometry();mount.tube(.095,[0,-.6,0],[0,-.08,0],METAL,10);
    mount.box(.48,.12,.48,0,-.63,0,DARK);turret.add(mount.mesh(ARMOR,'crew-mount'));
    const elevation=new THREE.Group();elevation.name='weapon-elevation';const gun=new VehicleGeometry();
    gun.box(.25,.25,.63,0,0,-.12,DARK);gun.box(.2,.35,.32,-.21,-.04,-.06,0x758065);
    gun.tube(.072,[0,0,-.38],[0,0,-CREW_GUN_LENGTH],METAL,12);
    for(let i=0;i<5;i++)gun.tube(.095,[0,0,-.5-i*.13],[0,0,-.54-i*.13],DARK,10);
    gun.box(.055,.07,.12,0,.11,-1.12,DARK);
    const muzzle=new THREE.Object3D();muzzle.name='weapon-muzzle';muzzle.position.z=-CREW_GUN_LENGTH;
    elevation.add(gun.mesh(ARMOR,'crew-machine-gun'),muzzle);turret.add(elevation);template.add(turret);TEMPLATES.set(key,template);
  }
  return articulatedClone(template);
}

function articulatedClone(template:THREE.Group):THREE.Group {
  const root=template.clone(true),muzzle=root.getObjectByName('weapon-muzzle')!;
  const flash=new THREE.Mesh(MUZZLE_FLASH_GEOMETRY,MUZZLE_FLASH_MATERIAL);flash.name='attached-muzzle-flash';flash.visible=false;muzzle.add(flash);
  ANIMATION.set(root,{wheels:[],steering:[],exhaust:undefined,phase:0,
    turret:root.getObjectByName('turret'),elevation:root.getObjectByName('weapon-elevation'),muzzle,flash,
    recoil:root.getObjectByName('weapon-recoil')});
  return root;
}

/** Keep the short-lived flash in barrel space throughout driving and aiming. */
export function flashVehicleWeapon(root: THREE.Group): boolean {
  const rig = ANIMATION.get(root);
  if (!rig?.flash) return false;
  rig.flashLife = rig.recoil ? .18 : .065; rig.flash.visible = true; rig.flash.scale.setScalar(rig.recoil ? 8 : 1);
  if(rig.recoil)rig.recoil.position.z=.9;
  return true;
}

const AIM_DIRECTION = new THREE.Vector3();
const AIM_ROTATION = new THREE.Quaternion();

/** Reuses the articulated barrel attachment; independent of the view camera. */
export function vehicleMuzzlePosition(root: THREE.Group, target: THREE.Vector3): boolean {
  const muzzle = ANIMATION.get(root)?.muzzle;
  if (!muzzle) return false;
  muzzle.getWorldPosition(target);
  return true;
}

/** Ground weapon axes match the authoritative shot direction, even on banks. */
export function aimVehicleWeapon(root: THREE.Group, yaw: number, pitch: number): void {
  const rig = ANIMATION.get(root);
  if (!rig?.turret || !rig.elevation) return;
  const direction = viewDir(yaw, root.userData.artillery ? artilleryPitch(pitch) : pitch);
  root.updateWorldMatrix(true, false);
  root.getWorldQuaternion(AIM_ROTATION).invert();
  AIM_DIRECTION.set(direction.x, direction.y, direction.z).applyQuaternion(AIM_ROTATION);
  rig.turret.rotation.set(0, Math.atan2(-AIM_DIRECTION.x, -AIM_DIRECTION.z), 0);
  rig.elevation.rotation.x = Math.atan2(AIM_DIRECTION.y, Math.hypot(AIM_DIRECTION.x, AIM_DIRECTION.z));
}

export interface VehicleMotion {
  dt: number;
  /** Signed speed along the hull's forward direction, in metres per second. */
  speed: number;
  /** Normalized steering input, -1..1. */
  steering?: number;
  /** Engine load, 0..1; omitted values derive from speed. */
  throttle?: number;
}

/** Allocation-free visual motion; no simulation or networking changes. */
export function updateVehicleHull(root: THREE.Group, motion: VehicleMotion): void {
  const animation = ANIMATION.get(root);
  if (!animation) return;
  const dt = Math.max(0, Math.min(0.1, motion.dt));
  if (animation.flash) {
    animation.flashLife = Math.max(0, (animation.flashLife ?? 0) - dt);
    animation.flash.visible = animation.flashLife > 0;
    animation.flash.scale.setScalar(Math.min(1, animation.flashLife * 24)*(animation.recoil?8:1));
  }
  if(animation.recoil)animation.recoil.position.z*=Math.exp(-dt*8);
  animation.phase = (animation.phase - motion.speed * dt / 0.465) % (Math.PI * 2);
  for (const wheel of animation.wheels) wheel.rotation.x = animation.phase;
  const steering = Math.max(-1, Math.min(1, motion.steering ?? 0)) * 0.36;
  for (const pivot of animation.steering) pivot.rotation.y += (steering - pivot.rotation.y) * Math.min(1, dt * 12);
  if (animation.exhaust) {
    const load = Math.max(0, Math.min(1, motion.throttle ?? Math.abs(motion.speed) / 85));
    animation.exhaust.visible = Math.abs(motion.speed) > 2 || load > 0.05;
    animation.exhaust.scale.z = 0.25 + load * 1.2;
    animation.exhaust.scale.x = animation.exhaust.scale.y = 0.78 + load * 0.22;
  }
}

/** Release an instance. The three bounded, immutable GPU templates are retained. */
export function disposeVehicleHull(root: THREE.Group): void {
  root.removeFromParent();
  ANIMATION.delete(root);
}

interface ParkedModel {
  root: THREE.Group;
  type: number;
  variant: number;
  transportRoute?: number;
}

/** Soft beacon colors: jeep green, tank amber, jet sky blue. */
const BEACON_COLORS: Record<number, number> = {
  [VEHICLE.JEEP]: 0x7fdc8a,
  [VEHICLE.TANK]: 0xe0b25c,
  [VEHICLE.JET]: 0x7cc4e8,
  [VEHICLE.GUNBOAT]: 0x73d4c0,
};
const BEACON_GEOMETRY = new THREE.CylinderGeometry(0.5, 0.9, 90, 6, 1, true);
const BEACON_MATERIALS = new Map<number, THREE.MeshBasicMaterial>();

/**
 * A tall translucent light column over a parked hull. Parked vehicles
 * replicate out to ~1.8km specifically so these are findable from afar.
 */
function buildBeacon(type: number, variant = 0): THREE.Mesh {
  const color = variant === VEHICLE_VARIANT.NOCTURNE ? 0xbf7aef : variant === VEHICLE_VARIANT.BASTION ? 0xf6dd93 : BEACON_COLORS[type] ?? 0xffffff;
  let material = BEACON_MATERIALS.get(color);
  if (!material) {
    material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    BEACON_MATERIALS.set(color, material);
  }
  const beam = new THREE.Mesh(BEACON_GEOMETRY, material);
  beam.position.y = 46;
  return beam;
}

/** Renders parked vehicles straight from the latest snapshot list. */
export class VehicleModels {
  readonly group = new THREE.Group();
  private readonly models = new Map<number, ParkedModel>();
  /** Latest replicated list, kept for HUD proximity prompts. */
  latest: readonly SnapshotVehicle[] = [];
  private readonly routes = new Map<number,TransportRoute>();

  setTransportRoutes(routes: readonly TransportRoute[]): void {
    this.routes.clear();for(const route of routes)this.routes.set(route.id,route);
  }

  /** Use the same deterministic clock as the carriage renderer: parked guns
   * must not judder at snapshot frequency while the train glides beneath. */
  updateTransport(seconds: number): void {
    for(const model of this.models.values()) {
      if(model.transportRoute===undefined)continue;const route=this.routes.get(model.transportRoute);if(!route)continue;
      const pose=transportPose(route,seconds,route.carOffsets[route.artilleryCar??TRAIN_ARTILLERY_MOUNT.car]);
      model.root.position.set(pose.x,pose.y+TRAIN_ARTILLERY_MOUNT.y,pose.z);model.root.rotation.y=pose.yaw;
    }
  }

  update(vehicles: readonly SnapshotVehicle[] | undefined): void {
    if (!vehicles) return;
    this.latest = vehicles;
    const present = new Set<number>();
    for (const v of vehicles) {
      present.add(v.id);
      let m = this.models.get(v.id);
      if (!m || m.type !== v.type || m.variant !== (v.variant ?? 0) || m.transportRoute!==v.transportRoute) {
        if (m) disposeVehicleHull(m.root);
        const root = v.transportRoute!==undefined?trainArtilleryModel():buildVehicleHull(v.type as VehicleType, v.variant);
        root.add(buildBeacon(v.type, v.variant));
        m = { root, type: v.type, variant: v.variant ?? 0, transportRoute:v.transportRoute };
        this.models.set(v.id, m);
        this.group.add(m.root);
      }
      m.root.position.set(v.x, v.y, v.z);
      m.root.rotation.y = v.heading;
    }
    for (const [id, m] of this.models) {
      if (!present.has(id)) {
        disposeVehicleHull(m.root);
        this.models.delete(id);
      }
    }
  }

  /** Nearest enterable vehicle for the "press E" prompt, or null. */
  nearestPrompt(
    px: number, py: number, pz: number,
  ): { type: VehicleType; variant?: number; dist: number; transportRoute?: number } | null {
    let best: { type: VehicleType; variant?: number; dist: number; transportRoute?: number } | null = null;
    for (const v of this.latest) {
      const def = vehicleDefinition(v.type, v.variant);
      if (!def) continue;
      const point=this.models.get(v.id)?.root.position??v;
      const d = Math.hypot(point.x - px, point.y + def.radius - (py + 1), point.z - pz);
      if (d <= def.enterRange && (!best || d < best.dist)) {
        best = { type: v.type as VehicleType, variant: v.variant ?? 0, dist: d,transportRoute:v.transportRoute };
      }
    }
    return best;
  }

  dispose(): void {
    for (const [, m] of this.models) disposeVehicleHull(m.root);
    this.models.clear();
    this.latest = [];
  }
}
