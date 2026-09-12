import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { cityLiftPose, insideLift, type World } from '@shared/index';
import type { CityLiftSite, CityDistrict } from '@shared/cities';

function frameGeometry(): THREE.BufferGeometry {
  const pieces: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    pieces.push(new THREE.BoxGeometry(.09, .18, 2).translate(side * .95, -.11, 0));
    pieces.push(new THREE.BoxGeometry(2, .18, .09).translate(0, -.11, side * .95));
  }
  for (const x of [-.88, .88]) for (const z of [-.88, .88])
    pieces.push(new THREE.BoxGeometry(.24, .28, .24).translate(x, -.15, z));
  const geometry = mergeGeometries(pieces)!;
  pieces.forEach(g => g.dispose());
  return geometry;
}

/** Moving energy decks share two instanced draws. Static shafts, pylons and
 * roof landings belong to the canonical city geometry. */
export class CityLiftRenderer {
  readonly group = new THREE.Group();
  private readonly sites: readonly CityLiftSite[];
  private readonly cities: readonly CityDistrict[];
  private readonly frames: THREE.InstancedMesh;
  private readonly fields: THREE.InstancedMesh;
  private readonly transform = new THREE.Object3D();
  private readonly color = new THREE.Color();

  constructor(world: World) {
    this.sites = world.collectCityLifts();
    this.cities = world.collectCities();
    this.group.name = 'city-energy-lifts';
    this.frames = new THREE.InstancedMesh(frameGeometry(), new THREE.MeshLambertMaterial({ color: 0x829195 }), this.sites.length);
    const field = new THREE.PlaneGeometry(1.88, 1.88).rotateX(-Math.PI / 2);
    this.fields = new THREE.InstancedMesh(field, new THREE.MeshBasicMaterial({ transparent: true, opacity: .55,
      side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }), this.sites.length);
    this.frames.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.fields.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.frames.count = this.fields.count = 0;
    this.group.add(this.frames, this.fields);
  }

  update(seconds: number, x: number, z: number): void {
    let count = 0;
    for (const site of this.sites) {
      if (Math.hypot(site.x - x, site.z - z) > 1050) continue;
      // Keep the visible force field above a coincident landing slab. The
      // four-centimetre glow offset does not alter the canonical support deck.
      this.transform.position.set(site.x, cityLiftPose(site, seconds).y + .04, site.z);
      this.transform.scale.set(site.hx, 1, site.hz);
      this.transform.updateMatrix();
      this.frames.setMatrixAt(count, this.transform.matrix);
      this.fields.setMatrixAt(count, this.transform.matrix);
      this.color.setHex(site.cityId === 2 ? 0xc175ff : site.cityId === 3 ? 0xffd88b : 0x76dedc);
      this.fields.setColorAt(count, this.color);
      count++;
    }
    this.frames.count = this.fields.count = count;
    this.frames.instanceMatrix.needsUpdate = this.fields.instanceMatrix.needsUpdate = true;
    if (this.fields.instanceColor) this.fields.instanceColor.needsUpdate = true;
    if (count) { this.frames.computeBoundingSphere(); this.fields.computeBoundingSphere(); }
  }

  hint(seconds: number, x: number, y: number, z: number, yaw = 0): string | null {
    for (const site of this.sites) {
      if (Math.abs(site.x - x) > site.hx + 7 || Math.abs(site.z - z) > site.hz + 7 || y < site.bottom - 1 || y > site.top + 2) continue;
      const pose = cityLiftPose(site, seconds);
      if (insideLift(site, x, z) && Math.abs(y - pose.y) < .2) {
        return pose.waiting ? `LIFT DEPARTS IN ${Math.ceil(pose.untilDeparture)}s · step off to explore` : `ASCENT LIFT · ${pose.velocity > 0 ? 'rising' : 'descending'}`;
      }
      if (Math.min(Math.abs(y - site.bottom), Math.abs(y - site.top)) < 2)
        return `ROOFTOP LIFT · ${Math.abs(y - pose.y) < .5 ? 'step onto the light deck' : 'platform returning'}`;
    }
    const city = this.cities.find(c => Math.max(Math.abs(c.x - x), Math.abs(c.z - z)) < c.radius);
    if (city) {
      let nearest: CityLiftSite | undefined, distance = Infinity;
      for (const site of this.sites) {
        if (site.cityId !== city.id || Math.min(Math.abs(y - site.bottom), Math.abs(y - site.top)) > 3) continue;
        const d = Math.hypot(site.x - x, site.z - z);
        if (d < distance) { distance = d; nearest = site; }
      }
      if (nearest) {
        const bearing = Math.atan2(x - nearest.x, z - nearest.z) - yaw;
        const angle = Math.atan2(Math.sin(bearing), Math.cos(bearing));
        const arrow = Math.abs(angle) < Math.PI / 5 ? '\u2191' : Math.abs(angle) > Math.PI * 4 / 5 ? '\u2193' : angle > 0 ? '\u2190' : '\u2192';
        return `${city.name.toUpperCase()}\nROOFTOP LIFT ${arrow} ${Math.round(distance)}m`;
      }
      return city.name.toUpperCase();
    }
    return null;
  }

  dispose(): void {
    for (const mesh of [this.frames, this.fields]) {
      mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); mesh.dispose();
    }
    this.group.clear();
  }
}
