import * as THREE from 'three';
import { buildCityBlock, cityParcelKind, type CityDistrict } from '@shared/cities';
import { WORLD } from '@shared/constants';
import type { World } from '@shared/worldgen';
import { capitalPropParts, type CapitalPropKind } from './capital-props.js';

export const CAPITAL_ORNAMENT_CAPACITY = 48;
export const CAPITAL_ORNAMENT_DISTANCE = 1100;
const KINDS: readonly CapitalPropKind[] = ['vesper-spire', 'vesper-portal', 'vesper-beacon',
  'aurelia-dome', 'aurelia-buttress', 'aurelia-standard'];
export interface CapitalOrnamentSite {
  kind: CapitalPropKind; x: number; y: number; z: number;
  width: number; height: number; depth: number; yaw: number;
}

/** Roof crowns borrow their actual support height from canonical collision.
 * They never enter an accessible terrace, lift lane or reward approach. */
export function capitalOrnamentSites(city: CityDistrict): readonly CapitalOrnamentSite[] {
  if (!city.theme) return [];
  const result: CapitalOrnamentSite[] = [];
  const blocks = new Map<string, ReturnType<typeof buildCityBlock>>();
  for (let bz = -3; bz <= 2; bz++) for (let bx = -3; bx <= 2; bx++) {
    const kind = cityParcelKind(city, bx, bz);
    if (!['tower', 'civic', 'warehouse'].includes(kind)) continue;
    const x = city.x + (bx + .5) * 64, z = city.z + (bz + .5) * 64;
    const key = `${Math.floor(x / 256)},${Math.floor(z / 256)}`;
    if (!blocks.has(key)) blocks.set(key, buildCityBlock(city, Math.floor(x / 256), Math.floor(z / 256)));
    const main = bx === 1 && bz === -1, cathedral = bx === -2 && bz === 0;
    const dark = city.theme === 'vesper';
    const solids = blocks.get(key)!.solids.filter(box => Math.abs(box.x - x) < 25 && Math.abs(box.z - z) < 25 &&
      (dark || !cathedral || Math.abs(box.x - x) < 1 && Math.abs(box.z - z) < 1));
    const crown = solids.reduce((a, b) => b.y + b.hy > a.y + a.hy ? b : a);
    const prop: CapitalPropKind = dark ? (cathedral ? 'vesper-portal' : kind === 'tower' ? 'vesper-spire' : 'vesper-beacon')
      : (main || cathedral || kind === 'tower' && (bx + bz) % 2 === 0 ? 'aurelia-dome' : kind === 'tower' ? 'aurelia-buttress' : 'aurelia-standard');
    const height = Math.min(main ? 14 : cathedral ? 22 : kind === 'tower' ? 15 : 9, WORLD.MAX_HEIGHT - 2 - crown.y - crown.hy);
    if (height < 2) continue;
    const width = prop === 'aurelia-dome' ? (cathedral ? 26 : main ? 20 : 23)
      : prop === 'aurelia-buttress' ? 5 : prop === 'vesper-portal' ? 24 : kind === 'tower' ? 13 : 6;
    result.push({ kind: prop, x: crown.x, y: crown.y + crown.hy, z: crown.z,
      width, height, depth: prop === 'vesper-portal' ? 9 : width,
      yaw: (bx + bz) % 2 === 0 ? 0 : Math.PI * .5 });
  }
  return Object.freeze(result);
}

/** Fixed shared instancing pools: no new lights, shadow maps or per-frame
 * geometry. Distant capitals contribute neither instances nor draw calls. */
export class CapitalDetails {
  readonly group = new THREE.Group();
  readonly stats = { sites: 0, draws: 0, triangles: 0 };
  private readonly pools = new Map<CapitalPropKind, THREE.InstancedMesh[]>();
  private readonly sites = new Map<number, readonly CapitalOrnamentSite[]>();
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly rotation = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private active = '';
  private disposed = false;

  constructor(private readonly world: Pick<World, 'collectCities'>) {
    this.group.name = 'capital-roof-ornaments';
    for (const kind of KINDS) {
      const meshes = capitalPropParts(kind).map(part => {
        const mesh = new THREE.InstancedMesh(part.geometry, part.material, CAPITAL_ORNAMENT_CAPACITY);
        mesh.name = kind;
        mesh.count = 0;
        mesh.visible = false;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.group.add(mesh);
        return mesh;
      });
      this.pools.set(kind, meshes);
    }
  }

  update(x: number, z: number): boolean {
    if (this.disposed || !Number.isFinite(x) || !Number.isFinite(z)) return false;
    const cities = this.world.collectCities().filter(city => city.theme &&
      Math.hypot(city.x - x, city.z - z) < CAPITAL_ORNAMENT_DISTANCE);
    const signature = cities.map(city => city.id).join(',');
    if (signature === this.active) return false;
    this.active = signature;
    for (const meshes of this.pools.values()) for (const mesh of meshes) { mesh.count = 0; mesh.visible = false; }
    this.stats.sites = this.stats.draws = this.stats.triangles = 0;
    for (const city of cities) {
      if (!this.sites.has(city.id)) this.sites.set(city.id, capitalOrnamentSites(city));
      for (const site of this.sites.get(city.id)!) {
        const meshes = this.pools.get(site.kind)!;
        if (meshes[0].count >= CAPITAL_ORNAMENT_CAPACITY) continue;
        this.position.set(site.x, site.y, site.z);
        this.scale.set(site.width, site.height, site.depth);
        this.rotation.setFromAxisAngle(this.up, site.yaw);
        this.matrix.compose(this.position, this.rotation, this.scale);
        for (const mesh of meshes) {
          mesh.setMatrixAt(mesh.count++, this.matrix);
          const geometry = mesh.geometry;
          this.stats.triangles += (geometry.index?.count ?? geometry.attributes.position.count) / 3;
        }
        this.stats.sites++;
      }
    }
    for (const meshes of this.pools.values()) for (const mesh of meshes) if (mesh.count) {
      mesh.visible = true;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      this.stats.draws++;
    }
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const meshes of this.pools.values()) for (const mesh of meshes) mesh.dispose();
    // Prototype geometry/materials belong to the shared immutable cache.
    this.pools.clear(); this.sites.clear(); this.group.clear();
  }
}
