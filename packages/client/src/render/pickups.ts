import * as THREE from 'three';
import {
  PICKUP_AMMO, PICKUP_HEALTH, PICKUP_WEAPON, WEAPONS,
  type SnapshotPickup,
} from '@shared/index';
import { cloneWorldWeapon } from './weapon-models.js';

// The authority currently caps the world at 48 live drops. Keep a separate
// client ceiling so a corrupt or future oversized snapshot can never grow the
// scene graph without bound.
export const MAX_PICKUP_VISUALS = 64;

const BOB_HEIGHT = 0.065;
const BOB_RATE = 2.15;
const HEALTH_SPIN_RATE = 0.55;
const AMMO_SPIN_RATE = 0.42;

const AMMO_ACCENTS = [
  0x57bce8, // sidearm / generic
  0x51e0e8, // pulse rifle
  0xffa14d, // scattergun
  0xf15e4d, // rockets
  0xf1c94b, // grenades
  0x9be851, // railgun slugs
  0xff6a3d, // nuke warheads
  0xe9c982, // carbine magazines
  0xb9e382, // flechette drums
  0x92dbfa, // prism cells
] as const;

interface PickupVisual {
  object: THREE.Group;
  kind: SnapshotPickup['kind'];
  weapon: number;
  x: number;
  y: number;
  z: number;
  phase: number;
}

/**
 * Snapshot-synchronized resource-drop models. All immutable geometry and
 * materials are shared; retiring a pickup only removes its small Object3D
 * hierarchy, while dispose() releases the shared GPU resources once.
 */
export class PickupModels {
  readonly group = new THREE.Group();

  private readonly visuals = new Map<number, PickupVisual>();
  private elapsed = 0;

  private readonly bodyGeometry = new THREE.BoxGeometry(0.9, 0.5, 0.66);
  private readonly lidGeometry = new THREE.BoxGeometry(0.78, 0.1, 0.54);
  private readonly strapGeometry = new THREE.BoxGeometry(0.13, 0.54, 0.7);
  private readonly crossTallGeometry = new THREE.BoxGeometry(0.12, 0.36, 0.035);
  private readonly crossWideGeometry = new THREE.BoxGeometry(0.36, 0.12, 0.035);
  private readonly bulletGeometry = new THREE.CylinderGeometry(0.04, 0.04, 0.25, 7);
  private readonly bulletTipGeometry = new THREE.ConeGeometry(0.04, 0.09, 7);
  private readonly haloGeometry = new THREE.RingGeometry(0.42, 0.55, 20);

  private readonly healthBodyMaterial = new THREE.MeshLambertMaterial({
    color: 0x218a55,
    emissive: 0x092b1a,
    flatShading: true,
  });
  private readonly ammoBodyMaterial = new THREE.MeshLambertMaterial({
    color: 0x303842,
    emissive: 0x090b0e,
    flatShading: true,
  });
  private readonly crossMaterial = new THREE.MeshBasicMaterial({
    color: 0xf4fff7,
    fog: true,
  });
  private readonly healthHaloMaterial = new THREE.MeshBasicMaterial({
    color: 0x65f29b,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
    side: THREE.DoubleSide,
    forceSinglePass: true,
  });
  private readonly ammoAccentMaterials = AMMO_ACCENTS.map(
    (color) => new THREE.MeshLambertMaterial({
      color,
      emissive: new THREE.Color(color).multiplyScalar(0.16),
      flatShading: true,
    }),
  );

  get count(): number {
    return this.visuals.size;
  }

  /** Replace the visible set with the complete pickup set from one snapshot. */
  sync(pickups: readonly SnapshotPickup[]): void {
    const present = new Set<number>();
    for (const pickup of pickups) {
      if (present.size >= MAX_PICKUP_VISUALS) break;
      if (!isValidPickup(pickup) || present.has(pickup.id)) continue;
      present.add(pickup.id);

      let visual = this.visuals.get(pickup.id);
      if (
        !visual ||
        visual.kind !== pickup.kind ||
        visual.weapon !== pickup.weapon
      ) {
        if (visual) this.group.remove(visual.object);
        visual = {
          object: this.createObject(pickup),
          kind: pickup.kind,
          weapon: pickup.weapon,
          x: pickup.x,
          y: pickup.y,
          z: pickup.z,
          phase: pickupPhase(pickup.id),
        };
        this.visuals.set(pickup.id, visual);
        this.group.add(visual.object);
      } else {
        visual.x = pickup.x;
        visual.y = pickup.y;
        visual.z = pickup.z;
      }
      this.place(visual);
    }

    for (const [id, visual] of this.visuals) {
      if (present.has(id)) continue;
      this.group.remove(visual.object);
      this.visuals.delete(id);
    }
  }

  update(dt: number, camera?: { x: number; y: number; z: number }): void {
    if (Number.isFinite(dt) && dt > 0) this.elapsed += Math.min(dt, 0.1);
    for (const visual of this.visuals.values()) {
      // A tiny loot model several kilometres behind the camera's fog still
      // submits every submesh without explicit distance culling.
      visual.object.visible = !camera || Math.hypot(visual.x - camera.x, visual.y - camera.y, visual.z - camera.z) < 260;
      if (visual.object.visible) this.place(visual);
    }
  }

  /** Safe to repeat during tab/network hard resynchronization. */
  clear(): void {
    for (const visual of this.visuals.values()) {
      this.group.remove(visual.object);
    }
    this.visuals.clear();
  }

  dispose(): void {
    this.clear();
    this.bodyGeometry.dispose();
    this.lidGeometry.dispose();
    this.strapGeometry.dispose();
    this.crossTallGeometry.dispose();
    this.crossWideGeometry.dispose();
    this.bulletGeometry.dispose();
    this.bulletTipGeometry.dispose();
    this.haloGeometry.dispose();
    this.healthBodyMaterial.dispose();
    this.ammoBodyMaterial.dispose();
    this.crossMaterial.dispose();
    this.healthHaloMaterial.dispose();
    for (const material of this.ammoAccentMaterials) material.dispose();
  }

  private place(visual: PickupVisual): void {
    visual.object.position.set(
      visual.x,
      visual.y + Math.sin(this.elapsed * BOB_RATE + visual.phase) * BOB_HEIGHT,
      visual.z,
    );
    const spinRate = visual.kind === PICKUP_HEALTH
      ? HEALTH_SPIN_RATE
      : AMMO_SPIN_RATE;
    visual.object.rotation.y = visual.phase + this.elapsed * spinRate;
  }

  private createObject(pickup: SnapshotPickup): THREE.Group {
    const root = new THREE.Group();
    root.name = `pickup-${pickup.id}`;
    root.userData.effect = 'pickup';
    root.userData.pickupId = pickup.id;
    root.userData.pickupKind = pickup.kind;
    root.userData.weapon = pickup.weapon;
    root.userData.weaponName = WEAPONS[pickup.weapon]?.name ?? '';

    if (pickup.kind === PICKUP_HEALTH) {
      this.buildHealthCrate(root);
    } else if (pickup.kind === PICKUP_WEAPON) {
      this.buildWeaponDrop(root, pickup.weapon);
    } else {
      this.buildAmmoCrate(root, pickup.weapon);
    }
    return root;
  }

  /** Cave weapon loot: the actual gun floating over a glowing halo. */
  private buildWeaponDrop(root: THREE.Group, weapon: number): void {
    const gun = cloneWorldWeapon(weapon);
    gun.scale.setScalar(1.35);
    gun.position.y = 0.25;
    gun.rotation.z = 0.14;
    root.add(gun);

    const accent = this.ammoAccentMaterials[accentIndex(weapon)];
    const halo = part(this.haloGeometry, accent, 'weapon-halo');
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = -0.27;
    halo.renderOrder = 2;
    root.add(halo);
  }

  private buildHealthCrate(root: THREE.Group): void {
    root.add(part(
      this.bodyGeometry,
      this.healthBodyMaterial,
      'health-body',
    ));

    // Crosses on both broad faces keep the pickup legible while it rotates.
    for (const z of [-0.348, 0.348]) {
      const tall = part(
        this.crossTallGeometry,
        this.crossMaterial,
        'health-cross',
      );
      tall.position.z = z;
      root.add(tall);
      const wide = part(
        this.crossWideGeometry,
        this.crossMaterial,
        'health-cross',
      );
      wide.position.z = z;
      root.add(wide);
    }

    const halo = part(
      this.haloGeometry,
      this.healthHaloMaterial,
      'health-halo',
    );
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = -0.27;
    halo.renderOrder = 2;
    root.add(halo);
  }

  private buildAmmoCrate(root: THREE.Group, weapon: number): void {
    const accent = this.ammoAccentMaterials[accentIndex(weapon)];
    root.add(part(this.bodyGeometry, this.ammoBodyMaterial, 'ammo-body'));

    const lid = part(this.lidGeometry, accent, 'ammo-accent');
    lid.position.y = 0.29;
    root.add(lid);

    const strap = part(this.strapGeometry, accent, 'ammo-accent');
    root.add(strap);

    // A pair of cartridges is a readable ammo mark at gameplay distance.
    // It uses the weapon's accent material, so rocket/grenade drops can also
    // be distinguished by color before reaching collection range.
    for (const x of [-0.105, 0.105]) {
      const cartridge = part(this.bulletGeometry, accent, 'ammo-mark');
      cartridge.position.set(x, -0.015, 0.355);
      root.add(cartridge);
      const tip = part(this.bulletTipGeometry, accent, 'ammo-mark');
      tip.position.set(x, 0.155, 0.355);
      root.add(tip);
    }
  }
}

function part(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  role: string,
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData.pickupPart = role;
  return mesh;
}

function accentIndex(weapon: number): number {
  if (!Number.isInteger(weapon) || weapon < 0) return 0;
  return weapon % AMMO_ACCENTS.length;
}

function pickupPhase(id: number): number {
  const hash = Math.imul(id ^ 0x5f35_6495, 0x9e37_79b1) >>> 0;
  return (hash / 0x1_0000_0000) * Math.PI * 2;
}

function isValidPickup(pickup: SnapshotPickup): boolean {
  return Number.isSafeInteger(pickup.id) &&
    pickup.id >= 0 &&
    (pickup.kind === PICKUP_HEALTH || pickup.kind === PICKUP_AMMO ||
     pickup.kind === PICKUP_WEAPON) &&
    Number.isInteger(pickup.weapon) &&
    Number.isFinite(pickup.x) &&
    Number.isFinite(pickup.y) &&
    Number.isFinite(pickup.z);
}
