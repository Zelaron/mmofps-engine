import * as THREE from 'three';
import { WEAPONS } from '@shared/index';
import { buildWeaponModel, poseWeaponReload, type WeaponModel } from './weapon-models.js';

// First-person weapon rig. Bob while running, kick on fire, sway with the
// mouse, and part-level reload choreography (mags drop, actions break open,
// rockets slide home) driven by the normalized reload progress.

/** Muzzle flash quad size, lifetime, and fade-out growth per weapon. The
 * launchers burn longer and balloon into a brief fireball; the hitscan
 * weapons stay short and snappy. */
const FLASH_SIZE = [0.14, 0.17, 0.28, 0.34, 0.28, 0.3, 0.2, 0.15, 0.23, 0.22];
const FLASH_LIFE = [0.055, 0.055, 0.07, 0.09, 0.08, 0.06, 0.06, 0.04, 0.055, 0.085];
const FLASH_GROW = [0.6, 0.6, 0.8, 1.0, 0.9, 0.5, 0.6, 0.4, 0.75, 1.15];

/** Soft radial glow so the flash quads read as light, not cards. */
function makeFlashTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 31);
  grad.addColorStop(0, 'rgba(255,255,235,1)');
  grad.addColorStop(0.35, 'rgba(255,210,130,0.85)');
  grad.addColorStop(1, 'rgba(255,160,60,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

function makeSmokeTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 3, 32, 32, 31);
  grad.addColorStop(0, 'rgba(205,208,214,0.9)');
  grad.addColorStop(0.55, 'rgba(185,189,196,0.4)');
  grad.addColorStop(1, 'rgba(180,184,190,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

/** One camera-space exhaust puff from the launcher pool. */
interface Puff {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  vel: THREE.Vector3;
  life: number;
  max: number;
  base: number;
}
const PUFF_POOL = 10;
const PUFF_GROW = 2.6;

export class ViewModel {
  readonly group = new THREE.Group();
  private readonly rigs: WeaponModel[];
  private current = 0;
  private bobPhase = 0;
  private recoil = 0;
  private swayX = 0;
  private swayY = 0;
  private switchAnim = 0;
  private reloadProgress = -1;

  // The local muzzle flash is parented to the camera, NOT the world: a
  // world-space flash outlives the frame it spawned in, so a strafing
  // player sees it trail off beside the barrel. Camera space keeps it
  // glued to the gun regardless of how the player moves.
  private readonly flash = new THREE.Group();
  private readonly flashMat: THREE.MeshBasicMaterial;
  private readonly flashFace: THREE.Mesh;
  private flashLife = 0;
  private flashMax = 0.055;
  private flashBase = 0.12;
  private flashGrow = 0.6;
  /** While positive, the flash re-glues to the viewmodel muzzle each frame. */
  private flashOnGun = false;
  /** Camera-space launcher exhaust: fast, brief, moves with the player. */
  private readonly puffs: Puff[] = [];

  constructor(private readonly camera: THREE.Camera) {
    this.rigs = WEAPONS.map((_, i) => buildWeaponModel(i, true));
    for (const r of this.rigs) {
      r.group.visible = false;
      this.group.add(r.group);
    }
    this.rigs[0].group.visible = true;
    this.group.position.set(0.3, -0.3, -0.55);
    camera.add(this.group);

    this.flashMat = new THREE.MeshBasicMaterial({
      map: makeFlashTexture(),
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const quad = new THREE.PlaneGeometry(1, 1);
    this.flashFace = new THREE.Mesh(quad, this.flashMat);
    const petal1 = new THREE.Mesh(quad, this.flashMat);
    petal1.rotation.x = Math.PI / 2;
    const petal2 = new THREE.Mesh(quad, this.flashMat);
    petal2.rotation.set(Math.PI / 2, 0, Math.PI / 2);
    this.flash.add(this.flashFace, petal1, petal2);
    this.flash.visible = false;
    camera.add(this.flash);

    const smokeTex = makeSmokeTexture();
    const puffGeo = new THREE.PlaneGeometry(1, 1);
    for (let i = 0; i < PUFF_POOL; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: smokeTex,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(puffGeo, mat);
      mesh.visible = false;
      camera.add(mesh);
      this.puffs.push({ mesh, mat, vel: new THREE.Vector3(), life: 0, max: 1, base: 0.1 });
    }
  }

  /**
   * Launcher exhaust, spawned and simulated in CAMERA space for the same
   * reason the flash is: world-space smoke this close to the eye trails
   * behind (or drifts ahead of) a moving player and reads as a glitch.
   */
  private launchExhaust(big: boolean): void {
    const muzzle = new THREE.Vector3();
    this.muzzleCamPos(muzzle);
    let spawned = 0;
    const want = big ? 7 : 5;
    for (const p of this.puffs) {
      if (spawned >= want) break;
      if (p.life > 0) continue;
      spawned++;
      p.mesh.position.set(
        muzzle.x + (Math.random() - 0.5) * 0.1,
        muzzle.y + (Math.random() - 0.5) * 0.1,
        muzzle.z - Math.random() * 0.15,
      );
      // Mostly straight out of the barrel, with a little sideways bloom.
      p.vel.set(
        (Math.random() - 0.5) * 1.4,
        (Math.random() - 0.5) * 1.1 + 0.25,
        -(2.2 + Math.random() * 3) * (big ? 1.25 : 1),
      );
      p.life = p.max = 0.16 + Math.random() * 0.14;
      p.base = (0.07 + Math.random() * 0.07) * (big ? 1.35 : 1);
      p.mesh.visible = true;
    }
  }

  /** Flash pinned to the held weapon's muzzle. */
  private triggerFlash(size: number, life: number, grow: number): void {
    this.flashMax = life;
    this.flashLife = life;
    this.flashBase = size * (0.85 + Math.random() * 0.4);
    this.flashGrow = grow;
    this.flash.scale.setScalar(this.flashBase);
    this.flashFace.rotation.z = Math.random() * Math.PI;
    this.flash.visible = true;
  }

  /** Muzzle flash for the possessed vehicle's gun (viewmodel is hidden). */
  vehicleMuzzleFlash(): void {
    this.flashOnGun = false;
    this.flashMat.color.setHex(0xffffff);
    this.triggerFlash(0.4, 0.07, 0.8);
    this.flash.position.set(0.35, -0.3, -1.4);
  }

  /** Current weapon's muzzle position in camera space. */
  private muzzleCamPos(out: THREE.Vector3): THREE.Vector3 {
    const rig = this.rigs[this.current];
    return out
      .copy(rig.muzzle)
      .add(rig.group.position)
      .applyEuler(this.group.rotation)
      .add(this.group.position);
  }

  private glueFlashToMuzzle(): void {
    this.muzzleCamPos(this.flash.position);
  }

  setWeapon(i: number): void {
    if (i === this.current || i < 0 || i >= this.rigs.length) return;
    this.rigs[this.current].group.visible = false;
    this.current = i;
    this.rigs[i].group.visible = true;
    this.switchAnim = 1;
  }

  onFire(): void {
    this.recoil = 1;
    this.flashOnGun = true;
    this.flashMat.color.setHex(this.current === 9 ? 0xc49dff : 0xffffff);
    this.triggerFlash(
      FLASH_SIZE[this.current] ?? 0.15,
      FLASH_LIFE[this.current] ?? 0.055,
      FLASH_GROW[this.current] ?? 0.6,
    );
    if (this.current === 3 || this.current === 4) {
      this.launchExhaust(this.current === 3);
    }
  }

  onDryFire(): void {
    this.recoil = Math.max(this.recoil, 0.16);
  }

  /** null hides the reload pose; otherwise progress is normalized to [0, 1]. */
  setReloadProgress(progress: number | null): void {
    this.reloadProgress = progress === null
      ? -1
      : Math.max(0, Math.min(1, progress));
  }

  update(dt: number, groundSpeed: number, grounded: boolean, sway: { x: number; y: number }): void {
    if (grounded && groundSpeed > 0.5) {
      this.bobPhase += dt * Math.min(groundSpeed, 12) * 1.35;
    }
    this.recoil = Math.max(0, this.recoil - dt * 6.5);
    this.switchAnim = Math.max(0, this.switchAnim - dt * 5);

    this.swayX = this.swayX * 0.82 + sway.x * 0.0006;
    this.swayY = this.swayY * 0.82 + sway.y * 0.0006;

    const bobAmp = grounded ? Math.min(groundSpeed / 9.5, 1) * 0.014 : 0;
    const bx = Math.sin(this.bobPhase) * bobAmp;
    const by = -Math.abs(Math.cos(this.bobPhase)) * bobAmp * 0.9;

    const r = this.recoil * this.recoil;
    const reloadDip = this.reloadProgress < 0
      ? 0
      : Math.sin(Math.PI * this.reloadProgress);
    const aspect = (this.camera as THREE.PerspectiveCamera).aspect ?? 1;
    const portrait = Math.min(1, Math.max(.45, aspect / .8));
    this.group.scale.setScalar(aspect < .8 ? .85 : 1);
    this.group.position.set(
      0.3 * portrait + bx - this.swayX,
      -0.3 + by + this.swayY - this.switchAnim * 0.25 - reloadDip * 0.14,
      -0.55 + r * 0.09 + reloadDip * 0.045,
    );
    this.group.rotation.set(
      r * 0.14 + this.swayY * 0.6 + reloadDip * 0.16,
      -this.swayX * 0.6,
      -reloadDip * 0.38,
    );

    poseWeaponReload(this.rigs[this.current], this.current, this.reloadProgress, r);

    if (this.flashLife > 0) {
      this.flashLife -= dt;
      if (this.flashLife <= 0) {
        this.flash.visible = false;
        this.flashMat.opacity = 0;
      } else {
        // Re-glue every frame so the flash rides the bob/recoil/sway pose,
        // ballooning outward as it fades (strongest on the launchers).
        if (this.flashOnGun) this.glueFlashToMuzzle();
        const t = 1 - this.flashLife / this.flashMax;
        this.flash.scale.setScalar(this.flashBase * (1 + this.flashGrow * t));
        this.flashMat.opacity = 0.95 * Math.pow(this.flashLife / this.flashMax, 0.6);
      }
    }

    for (const p of this.puffs) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.mesh.visible = false;
        p.mat.opacity = 0;
        continue;
      }
      p.mesh.position.addScaledVector(p.vel, dt);
      p.vel.multiplyScalar(Math.max(0, 1 - 4.5 * dt));
      const t = 1 - p.life / p.max;
      p.mesh.scale.setScalar(p.base * (1 + PUFF_GROW * t));
      p.mat.opacity = 0.5 * Math.pow(p.life / p.max, 0.8);
    }
  }
}
