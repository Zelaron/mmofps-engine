import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CAVE_BIOME, caveBiomeAt, cavePathPoint, hash2i, unit, type CaveSite, type World } from '@shared/index';
import { renderProfile } from './device-profile.js';

export const CAVE_DECORATION_BUDGET = 768;
export const CAVE_ANCHOR_CACHE_LIMIT = 768;
const UP = new THREE.Vector3(0, 1, 0);
type CaveSource = Pick<World, 'collectCaveSites' | 'sdf' | 'trace'> & Partial<Pick<World, 'seed' | 'column'>>;
interface Anchor { key: string; site?: CaveSite; x: number; y: number; z: number; salt: number }
interface Placement {
  pool: THREE.InstancedMesh;
  x: number; y: number; z: number;
  sx: number; sy: number; sz: number;
  nx: number; ny: number; nz: number; color: number;
  yaw?: number;
}
interface CachedAnchor extends Anchor { placements?: Placement[] }

function colored(geometry: THREE.BufferGeometry, base: number, top: number): THREE.BufferGeometry {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  if (g !== geometry) geometry.dispose();
  const p = g.getAttribute('position');
  const colors = new Float32Array(p.count * 3);
  const low = new THREE.Color(base), high = new THREE.Color(top), color = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    color.copy(low).lerp(high, Math.max(0, Math.min(1, p.getY(i))));
    color.toArray(colors, i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

/** Faceted, offset mineral growth instead of a perfect rotational cone. */
function pendantGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.CylinderGeometry(0.015, 1, 1, 6, 3);
  geometry.translate(0, 0.5, 0);
  const positions = geometry.getAttribute('position');
  for (let i = 0; i < positions.count; i++) {
    const y = positions.getY(i);
    positions.setX(i, positions.getX(i) * (1 - y * 0.12) + y * y * 0.22);
    positions.setZ(i, positions.getZ(i) + y * y * 0.13);
  }
  const result = colored(geometry, 0x66675b, 0xb2ac92);
  result.computeVertexNormals();
  return result;
}

function fungusGeometry(): THREE.BufferGeometry {
  const stalk = new THREE.CylinderGeometry(0.055, 0.08, 0.35, 5);
  stalk.translate(0, 0.17, 0);
  const cap = new THREE.SphereGeometry(0.3, 7, 3, 0, Math.PI * 2, 0, Math.PI / 2);
  cap.scale(1, 0.52, 1);
  cap.translate(0, 0.34, 0);
  const parts = [colored(stalk, 0x626a64, 0x738b7f), colored(cap, 0x708c7f, 0xccf1c8)];
  const geometry = mergeGeometries(parts)!;
  for (const part of parts) part.dispose();
  return geometry;
}

function waymarkerGeometry(): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0.85); shape.lineTo(-0.42, 0.2); shape.lineTo(-0.13, 0.2);
  shape.lineTo(-0.13, -0.65); shape.lineTo(0.13, -0.65); shape.lineTo(0.13, 0.2);
  shape.lineTo(0.42, 0.2); shape.closePath();
  const arrow = new THREE.ExtrudeGeometry(shape, { depth: 0.045, bevelEnabled: false });
  arrow.rotateX(-Math.PI / 2); arrow.translate(0, 0.075, 0);
  return arrow;
}

/** Capped decoration and waymarker pools backed by stable world-space anchors.
 * Overlapping cells retain their sampled geometry; only new anchors need
 * incremental probes. The central authored walk lane remains clear. */
export class CaveDetails {
  readonly group = new THREE.Group();
  private readonly capacity = renderProfile().touch ? 120 : 240;
  private readonly markerCapacity = renderProfile().touch ? 24 : 48;
  private readonly rockGeometry = pendantGeometry();
  private readonly mineralGeometry = new THREE.CylinderGeometry(0.03, 0.24, 1, 5, 1).translate(0, 0.5, 0);
  private readonly fungusGeometry = fungusGeometry();
  private readonly rockMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
  private readonly mineralMaterial = new THREE.MeshPhongMaterial({ color: 0xffffff, shininess: 65,
    emissive: 0x164c51, emissiveIntensity: 0.35, specular: 0x88bac0 });
  private readonly fungusMaterial = new THREE.MeshLambertMaterial({ vertexColors: true,
    emissive: 0x265e50, emissiveIntensity: 0.28 });
  private readonly markerMaterial = new THREE.MeshLambertMaterial({ color: 0xffffff,
    emissive: 0xe09b28, emissiveIntensity: 0.5 });
  private readonly pendants = this.pool('cave-ceiling-formations', this.rockGeometry, this.rockMaterial);
  private readonly minerals = this.pool('cave-minerals', this.mineralGeometry, this.mineralMaterial);
  private readonly fungi = this.pool('cave-fungi', this.fungusGeometry, this.fungusMaterial);
  private readonly markers = this.pool('cave-exit-waymarkers', waymarkerGeometry(), this.markerMaterial, this.markerCapacity);
  private readonly pools = [this.pendants, this.minerals, this.fungi, this.markers];
  private readonly pending: CachedAnchor[] = [];
  private readonly cache = new Map<string, CachedAnchor>();
  private readonly active = new Set<string>();
  private readonly visible = new Map<THREE.InstancedMesh, Placement[]>();
  private collecting: Placement[] | undefined;
  private deepMode = false;
  private cell = '';
  private disposed = false;
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private readonly rotation = new THREE.Quaternion();
  private readonly heading = new THREE.Quaternion();
  private readonly matrix = new THREE.Matrix4();
  private readonly tint = new THREE.Color();

  constructor(private readonly world: CaveSource) {
    this.group.name = 'cave-details';
    this.group.add(...this.pools);
  }

  get stats(): { formations: number; minerals: number; fungi: number; pending: number; cached: number } {
    return { formations: this.pendants.count, minerals: this.minerals.count,
      fungi: this.fungi.count, pending: this.pending.length, cached: this.cache.size };
  }

  update(x: number, z: number, y?: number): void {
    if (this.disposed || !Number.isFinite(x) || !Number.isFinite(z)) return;
    const height = y !== undefined && Number.isFinite(y) ? y : undefined;
    // A player bobbing around the shallow/deep threshold must not switch
    // decoration systems every frame. Both retain overlapping old anchors.
    if (height === undefined || height > -4) this.deepMode = false;
    else if (height < -12) this.deepMode = true;
    const layer = height === undefined ? 0 : Math.floor(height / 16);
    const cell = `${Math.floor(x / 32)},${Math.floor(z / 32)},${this.deepMode ? layer : 'surface'}`;
    let changed = false;
    if (cell !== this.cell) {
      this.cell = cell;
      // Retirement is wider than discovery. Walking over a query boundary
      // cannot discard a nearby cluster, even if its site drops from a list.
      for (const key of this.active) {
        const a = this.cache.get(key)!;
        const radius = a.site ? 270 : 112;
        if (Math.hypot(a.x - x, a.z - z) > radius ||
            (height !== undefined && Math.abs(a.y - height) > 56)) this.active.delete(key);
      }
      // Low-lying authored galleries can sit below sea level too. Their
      // real route metadata, rather than absolute Y alone, retains arrows
      // back to daylight while ordinary deep rooms keep the local lattice.
      const route = this.deepMode ? this.world.column?.(x, z).cave : undefined;
      const inGallery = route && height! >= route.floor - 0.5 && height! <= route.floor + route.site.height + 4;
      const sites = this.deepMode && !inGallery ? [] : this.world.collectCaveSites(x - 170, x + 170, z - 170, z + 170)
        .filter(s => Math.hypot(s.x + s.dx * 36 - x, s.z + s.dz * 36 - z) < 210)
        .sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z))
        .slice(0, 2);
      for (const site of sites) this.queueSite(site);
      if (this.deepMode) this.queueDeep(x, height!, z);
      // At most 384 active anchor records, even after long vertical or
      // diagonal travel. Retire the most distant records first; the cache
      // retains their samples for backtracking within its separate budget.
      if (this.active.size > 384) {
        const nearest = [...this.active].sort((a, b) =>
          this.distance(this.cache.get(a)!, x, height, z) - this.distance(this.cache.get(b)!, x, height, z));
        for (const key of nearest.slice(384)) this.active.delete(key);
      }
      this.pending.length = 0;
      for (const key of this.active) {
        const a = this.cache.get(key)!;
        if (!a.placements) this.pending.push(a);
      }
      this.pending.sort((a, b) => this.distance(a, x, height, z) - this.distance(b, x, height, z));
      this.trimCache();
      changed = true;
    }
    // At most two anchors (six traces) per frame, nearest first. New rooms
    // fill incrementally without a large main-thread spike.
    for (let i = 0; i < 2 && this.pending.length; i++) {
      const a = this.pending.shift()!;
      this.collecting = [];
      this.sample(a);
      a.placements = this.collecting;
      this.collecting = undefined;
      changed = true;
    }
    if (!changed) return;
    this.renderActive();
    for (const mesh of this.pools) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      if (mesh.count > 0) mesh.computeBoundingSphere();
    }
  }

  private distance(a: Anchor, x: number, y: number | undefined, z: number): number {
    return Math.hypot(a.x - x, a.z - z, y === undefined ? 0 : a.y - y);
  }

  private anchor(a: Anchor): void {
    const cached = this.cache.get(a.key) ?? a;
    // Move reused anchors to the end of the bounded cache's eviction order.
    this.cache.delete(a.key);
    this.cache.set(a.key, cached);
    this.active.add(a.key);
  }

  private trimCache(): void {
    for (const key of this.cache.keys()) {
      if (this.cache.size <= CAVE_ANCHOR_CACHE_LIMIT) break;
      if (!this.active.has(key)) this.cache.delete(key);
    }
  }

  /** Deep noise chambers have no hillside site. Sample a stable local lattice
   * around the camera, including teleporter arrivals and rooms between pads. */
  private queueDeep(x: number, y: number, z: number): void {
    const cx = Math.floor(x / 32) * 2, cz = Math.floor(z / 32) * 2, cy = Math.floor(y / 16);
    for (let k = -1; k <= 1; k++) for (let j = -4; j <= 4; j++) for (let i = -4; i <= 4; i++) {
      if (i * i + j * j > 18) continue;
      const ix = cx + i, iz = cz + j, iy = cy + k;
      const salt = hash2i(hash2i(ix, iz, this.world.seed ?? 0), iy, 0x639af);
      this.anchor({ key: `deep:${ix},${iy},${iz}`, x: ix * 16 + 8 + (unit(salt) - 0.5) * 6,
        y: iy * 16 + 8, z: iz * 16 + 8 + (unit(salt ^ 0x357ab) - 0.5) * 6, salt });
    }
  }

  private queueSite(site: CaveSite): void {
    for (const forward of [36, 48, 60]) {
      const p = cavePathPoint(site, forward);
      for (const side of [-1, 1]) this.anchor({key: `site:${site.x},${site.z}:${forward + side}`, site, x: p.x - site.dz * site.width * 0.58 * side,
        y: p.y + 3.2, z: p.z + site.dx * site.width * 0.58 * side, salt: forward + side});
    }
    const center = cavePathPoint(site, site.length);
    for (let i = 0; i < 10; i++) {
      const angle = i * Math.PI * 0.2;
      // Both approaches own the same chamber anchors. Duplicating their
      // ceiling roots would waste probes and create overlapping geometry.
      this.anchor({key: `chamber:${center.x.toFixed(4)},${center.z.toFixed(4)}:${100 + i}`, site, x: center.x + Math.cos(angle) * site.chamberRadius * 0.60,
        y: center.y + 3.8, z: center.z + Math.sin(angle) * site.chamberRadius * 0.60, salt: 100 + i});
    }
  }

  private sample(a: Anchor): void {
    if (this.world.sdf(a.x, a.y, a.z) < 0.8) return;
    const rand = (salt: number) => unit(hash2i(a.site?.seed ?? this.world.seed ?? 0, a.salt, salt));
    const deep = !a.site;
    const biome = caveBiomeAt(this.world.seed ?? 0, a.x, a.z);
    const ice = biome === CAVE_BIOME.GLACIAL, copper = biome === CAVE_BIOME.COPPER;
    const fungal = biome === CAVE_BIOME.FUNGAL;
    const rockTint = ice ? 0x9bd5f2 : copper ? 0xd39869 : fungal ? 0x819a72 : 0xffebc2;
    const thickness = ice ? 0.7 : copper ? 1.45 : 1;
    const lengthScale = ice ? 1.25 : copper ? 0.72 : fungal ? 0.65 : 1;
    const ceiling = this.world.trace(a.x, a.y, a.z, 0, 1, 0, deep ? 48 : 28);
    if (ceiling.hit && ceiling.ny < -0.3 && ceiling.dist > 4) {
      const length = Math.min(ceiling.dist - 3, (deep ? 1.8 + rand(0) * 5.0 : 0.8 + rand(0) * 2.1) * lengthScale);
      // Ceiling-only formations stay well above a player's reachable capsule.
      this.place(this.pendants, ceiling.x, ceiling.y + 0.13, ceiling.z,
        (0.25 + rand(1) * 0.37) * (deep ? 1.8 : 1) * thickness, length,
        (0.24 + rand(2) * 0.3) * (deep ? 1.8 : 1) * thickness, 0, -1, 0, rockTint);
      if (deep) for (let i = 0; i < 2; i++) {
        // Roots stay on the sampled ceiling plane; companions taper beneath
        // the broad central root and never intrude on the player's headroom.
        const ox = (rand(4 + i) - 0.5) * 0.75, oz = (rand(6 + i) - 0.5) * 0.75;
        const oy = -(ceiling.nx * ox + ceiling.nz * oz) / ceiling.ny;
        this.place(this.pendants, ceiling.x + ox, ceiling.y + oy + 0.13, ceiling.z + oz,
          (0.22 + rand(10 + i) * 0.25) * thickness, length * (0.4 + rand(12 + i) * 0.3),
          (0.22 + rand(14 + i) * 0.25) * thickness, 0, -1, 0, rockTint);
      }
    }
    const floor = this.world.trace(a.x, a.y, a.z, 0, -1, 0, deep ? 20 : 8);
    if (floor.hit && floor.ny > 0.72) {
      if (a.site && a.salt < 100) {
        // Amber arrows stand on the sampled gallery shoulder and point
        // uphill to actual daylight, never into a wall or a lower cavern.
        const route = cavePathPoint(a.site, a.salt);
        const side = Math.sign(-(floor.x - route.x) * a.site.dz + (floor.z - route.z) * a.site.dx);
        const ox = a.site.dz * side * 1.3, oz = -a.site.dx * side * 1.3;
        const oy = -(floor.nx * ox + floor.nz * oz) / floor.ny;
        this.place(this.markers, floor.x + ox, floor.y + oy, floor.z + oz, 1, 1, 1,
          floor.nx, floor.ny, floor.nz, 0xffd27a, Math.atan2(a.site.dx, a.site.dz));
      }
      for (let i = 0; i < 3; i++) {
        const size = (0.5 + rand(10 + i) * 0.7) * (deep ? 1.5 : 1) * (fungal ? 1.65 : ice ? 0.65 : 1);
        const offsetX = (rand(20 + i) - 0.5) * 0.4;
        const offsetZ = (rand(30 + i) - 0.5) * 0.4;
        // Follow the sampled floor plane when spreading the small cluster;
        // a fixed Y would suspend the downhill stalks over a sloping alcove.
        const offsetY = -(floor.nx * offsetX + floor.nz * offsetZ) / floor.ny;
        this.place(this.fungi, floor.x + offsetX, floor.y + offsetY - 0.03,
          floor.z + offsetZ, size, size, size, 0, 1, 0, fungal ? 0xa9eed8 : copper ? 0xf1b875 : ice ? 0x8fbced : 0xd1e4cb);
      }
    }
    // Wall clusters are small surface growth, raised above the walk lane.
    const center = a.site ? cavePathPoint(a.site, a.salt < 100 ? a.salt : a.site.length) : null;
    const angle = rand(45) * Math.PI * 2;
    const dx = center ? a.x - center.x : Math.cos(angle), dz = center ? a.z - center.z : Math.sin(angle);
    const distance = Math.max(0.1, Math.hypot(dx, dz));
    const wall = this.world.trace(a.x, a.y, a.z, dx / distance, 0, dz / distance, deep ? 36 : 20);
    if (!wall.hit || Math.abs(wall.ny) > 0.6) return;
    const color = ice ? 0x92d7ff : copper ? 0xe7a45a : fungal ? 0x82dca5 : 0xf1dba0;
    const horizontal = Math.hypot(wall.nx, wall.nz);
    for (let i = 0; i < 4; i++) {
      const across = (rand(60 + i) - 0.5) * 0.32;
      const rise = (rand(70 + i) - 0.5) * 0.55;
      // Jitter in the wall's tangent plane, keeping every mineral root
      // embedded instead of moving some crystals along the outward normal.
      this.place(this.minerals,
        wall.x - wall.nx * 0.10 - wall.nz / horizontal * across - wall.nx * wall.ny / horizontal * rise,
        wall.y - wall.ny * 0.10 + horizontal * rise,
        wall.z - wall.nz * 0.10 + wall.nx / horizontal * across - wall.nz * wall.ny / horizontal * rise,
        0.55 + rand(90 + i) * 0.7, 0.32 + rand(100 + i) * 0.8,
        0.6 + rand(110 + i) * 0.6, wall.nx, wall.ny + 0.3, wall.nz, color);
    }
  }

  private place(mesh: THREE.InstancedMesh, x: number, y: number, z: number,
    sx: number, sy: number, sz: number, nx: number, ny: number, nz: number, color: number, yaw?: number): void {
    this.collecting!.push({ pool: mesh, x, y, z, sx, sy, sz, nx, ny, nz, color, yaw });
  }

  private renderActive(): void {
    // Repack synchronously from retained samples. Rendering never observes
    // an empty intermediate pool, and anchor transforms do not depend on
    // the player's current cell, eye height, or sampling frame.
    const available = new Set<Placement>();
    for (const key of this.active) for (const p of this.cache.get(key)!.placements ?? []) available.add(p);
    for (const mesh of this.pools) {
      // A newly completed farther sample must not displace a visible near
      // cluster just because its lattice key sorts first. Keep existing
      // slots until their anchor actually leaves the retained neighborhood.
      const retained = (this.visible.get(mesh) ?? []).filter(p => available.has(p));
      const selected = new Set(retained);
      for (const p of available) {
        if (retained.length >= mesh.instanceMatrix.count) break;
        if (p.pool === mesh && !selected.has(p)) retained.push(p);
      }
      this.visible.set(mesh, retained);
      mesh.count = 0;
      for (const { x, y, z, sx, sy, sz, nx, ny, nz, color, yaw } of retained) {
        this.position.set(x, y, z); this.scale.set(sx, sy, sz);
        this.direction.set(nx, ny, nz).normalize();
        this.rotation.setFromUnitVectors(UP, this.direction);
        if (yaw !== undefined) this.rotation.multiply(this.heading.setFromAxisAngle(UP, yaw));
        this.matrix.compose(this.position, this.rotation, this.scale);
        mesh.setMatrixAt(mesh.count, this.matrix);
        mesh.setColorAt(mesh.count++, this.tint.setHex(color));
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  private pool(name: string, geometry: THREE.BufferGeometry, material: THREE.Material, capacity = this.capacity): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.name = name; mesh.count = 0;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    return mesh;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.pending.length = 0; this.active.clear(); this.cache.clear(); this.visible.clear();
    for (const mesh of this.pools) {
      mesh.count = 0; mesh.dispose(); mesh.geometry.dispose();
    }
    this.rockMaterial.dispose(); this.mineralMaterial.dispose(); this.fungusMaterial.dispose();
    this.markerMaterial.dispose();
    this.group.clear();
  }
}
