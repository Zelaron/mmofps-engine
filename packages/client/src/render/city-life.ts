import * as THREE from 'three';
import type { World } from '@shared/worldgen';
import { cityLifePlan, cityCivilianPose, type CityVenue, type CityVenueKind, type CityLifeMarker } from '@shared/city-life';
import { disjointStructureBoxes } from '@shared/structures';
import { CivilianModels, MAX_VISIBLE_CIVILIANS, type CivilianRenderItem } from './civilian-models.js';
import { VehicleGeometry } from './vehicle-geometry.js';
import { renderProfile } from './device-profile.js';

export const MAX_VISIBLE_VENUES = 16;
const KINDS: readonly CityVenueKind[] = ['market', 'clinic', 'workshop', 'canteen', 'archive', 'residence', 'aerodrome'];
const IDENTITY = new THREE.Quaternion();

function signs(): THREE.Texture {
  if (typeof document === 'undefined') return new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 1024;
  const context = canvas.getContext('2d')!;
  const headings = ['EXCHANGE', 'AID STATION', 'WORKSHOP', 'CANTEEN', 'ARCHIVE', 'LODGINGS', 'NOCTURNE', 'AERODROME'];
  const sub = ['GUIDED ROCKETS • SUPPLIES', 'HEALTH • MEDICAL CARE', 'GUIDED ROCKET AMMO', 'FOOD • HEALTH', 'EQUIPMENT • RECORDS', 'ROOMS • EQUIPMENT', 'BOMBER • BOARD AT RUNWAY', 'FOLLOW THE CYAN SIGNS'];
  for (let i = 0; i < 8; i++) {
    context.fillStyle = i === 1 ? '#233d35' : '#182630'; context.fillRect(0, i * 128, 512, 128);
    context.strokeStyle = i === 1 ? '#b8e1b6' : i >= 6 ? '#65e4de' : '#ddbf77'; context.lineWidth = 5; context.strokeRect(5, i * 128 + 5, 502, 118);
    context.fillStyle = '#f0e8ca'; context.font = 'bold 44px sans-serif'; context.textAlign = 'center'; context.fillText(headings[i], 256, i * 128 + 59);
    context.font = 'bold 21px sans-serif'; context.fillStyle = '#9fc5c9'; context.fillText(sub[i], 256, i * 128 + 99);
  }
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 4; return texture;
}

function venueProps(kind: CityVenueKind, material: THREE.Material): THREE.BufferGeometry {
  const model = new VehicleGeometry(), metal = 0x627a80, paper = 0xc8c2a2;
  if (kind === 'clinic') {
    model.box(.55, 1.9, .08, 0, 2.7, -6.5, 0xc7e8ce); model.box(1.9, .55, .08, 0, 2.7, -6.5, 0xc7e8ce);
    for (let i = 0; i < 4; i++) model.add(new THREE.CylinderGeometry(.16, .16, .43, 10), i % 2 ? 0x8bbfc0 : paper, [-6.8, 1.54, -3 + i * .7]);
  } else if (kind === 'market' || kind === 'canteen') {
    for (let i = 0; i < 7; i++) {
      model.add(new THREE.SphereGeometry(.23, 9, 6), [0xc88e48, 0x7caa59, 0xb86c54][i % 3], [-6.8 + i % 2 * .3, 1.53, -4 + i * .65]);
      if (i < 3) model.box(.8, .11, .53, -6.8, 1.35, -4 + i * 1.1, paper);
    }
    model.box(2.6, 1.5, .10, 0, 2.5, -6.5, 0x334c47);
    for (let i = 0; i < 4; i++) model.box(1.8 - i * .2, .035, .025, 0, 2.9 - i * .3, -6.43, paper);
  } else if (kind === 'archive' || kind === 'residence') {
    for (let i = 0; i < 13; i++) model.box(.24, .48 + i % 3 * .1, .45, -6.8, 1.6 + i % 2 * .04, -4.8 + i * .4, [paper, 0x805d56, 0x5d8790][i % 3]);
    model.box(3.3, 1.8, .10, 0, 2.4, -6.5, 0x5d6c79);
    model.box(2.5, 1.2, .025, 0, 2.4, -6.43, 0xb5bba5);
  } else {
    for (let i = 0; i < 4; i++) model.add(new THREE.CylinderGeometry(.24, .24, .4, 12).rotateZ(Math.PI / 2), metal, [-6.8, 1.59, -3.8 + i * .9]);
    model.box(1.5, 1.1, .15, -6.7, 2.15, -1.2, 0x25383f); model.box(1.25, .8, .035, -6.7, 2.18, -1.30, 0x63b9b0);
    model.box(3.2, 1.8, .10, 0, 2.5, -6.5, 0x314754);
    for (const side of [-1, 1]) model.tube(.035, [side * 1.1, 1.9, -6.41], [-side * 1.1, 3.1, -6.41], 0x88c5c5, 6);
  }
  return model.mesh(material, `venue-${kind}`).geometry;
}

/** Local city detail is independent of networked combat entities. Every room
 * wall and stair uses its shared collision box; props stay on that furniture. */
export class CityLife {
  readonly group = new THREE.Group();
  readonly stats = { venues: 0, civilians: 0, boxes: 0, draws: 0, triangles: 0 };
  private readonly population = new CivilianModels();
  private readonly geometry = new THREE.BoxGeometry(2, 2, 2);
  private readonly material = new THREE.MeshLambertMaterial({ color: 0xffffff });
  private readonly propMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
  private readonly walls = new THREE.InstancedMesh(this.geometry, this.material, 1400);
  private readonly props = new Map<CityVenueKind, THREE.InstancedMesh>();
  private readonly signTexture = signs();
  private readonly signGeometry = new THREE.PlaneGeometry(1, 1);
  private readonly signMaterial = new THREE.MeshBasicMaterial({ map: this.signTexture, side: THREE.DoubleSide });
  private readonly signs = new THREE.InstancedMesh(this.signGeometry, this.signMaterial, 48);
  private readonly arrowGeometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([
    -1, 0, -4, 1, 0, -4, 1, 0, 1, -1, 0, -4, 1, 0, 1, -1, 0, 1,
    -3, 0, 0, 3, 0, 0, 0, 0, 5,
  ], 3));
  private readonly arrowMaterial = new THREE.MeshBasicMaterial({ color: 0x65e4de, side: THREE.DoubleSide });
  private readonly arrows = new THREE.InstancedMesh(this.arrowGeometry, this.arrowMaterial, 16);
  private readonly signIndexes = new THREE.InstancedBufferAttribute(new Float32Array(48), 1);
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly rotation = new THREE.Quaternion();
  private readonly tint = new THREE.Color();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private signature = '';
  private disposed = false;

  constructor(private readonly world: Pick<World, 'collectCities'>) {
    this.group.name = 'city-life'; this.walls.name = 'city-venue-solids'; this.walls.count = 0;
    this.signGeometry.setAttribute('instanceSign', this.signIndexes);
    this.signMaterial.customProgramCacheKey = () => 'city-life-sign-atlas-v1';
    this.signMaterial.onBeforeCompile = shader => {
      shader.vertexShader = 'attribute float instanceSign;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\nvMapUv.y = (vMapUv.y + 7.0 - instanceSign) / 8.0;');
    };
    this.signs.name = 'city-venue-signs'; this.signs.count = 0;
    this.arrows.name = 'aerodrome-direction-arrows'; this.arrows.count = 0;
    this.group.add(this.walls, this.signs, this.arrows, this.population.group);
    for (const kind of KINDS) {
      const mesh = new THREE.InstancedMesh(venueProps(kind, this.propMaterial), this.propMaterial, MAX_VISIBLE_VENUES);
      mesh.name = `city-venue-props-${kind}`; mesh.count = 0; this.props.set(kind, mesh); this.group.add(mesh);
    }
  }

  update(x: number, y: number, z: number, seconds: number): void {
    if (this.disposed || ![x, y, z, seconds].every(Number.isFinite)) return;
    const cities = this.world.collectCities().filter(city => Math.hypot(city.x - x, city.z - z) < city.radius + 450);
    const plans = cities.map(city => cityLifePlan(city));
    const venues = plans.flatMap(plan => plan.venues).filter(v => Math.hypot(v.x - x, v.z - z) < 300 && Math.abs(v.y - y) < 110)
      .sort((a, b) => Math.hypot(a.x - x, a.y - y, a.z - z) - Math.hypot(b.x - x, b.y - y, b.z - z)).slice(0, MAX_VISIBLE_VENUES);
    const markers = plans.flatMap(plan => plan.markers).filter(m => Math.hypot(m.x - x, m.z - z) < 1500);
    const signature = venues.map(v => v.id).join(',') + ':' + markers.map(m => m.id).join(',');
    if (signature !== this.signature) { this.signature = signature; this.rebuild(venues, markers, plans.flatMap(p => p.solids)); }
    const visible = new Set(venues.filter(v => Math.abs(v.y - y) < 14).map(v => v.id));
    const population: CivilianRenderItem[] = [];
    for (const civilian of plans.flatMap(p => p.civilians)) {
      if (!visible.has(civilian.venueId)) continue;
      const pose = cityCivilianPose(civilian, seconds);
      if (Math.hypot(pose.x - x, pose.z - z) < 170) population.push({ civilian, pose });
    }
    population.sort((a, b) => Math.hypot(a.pose.x - x, a.pose.z - z) - Math.hypot(b.pose.x - x, b.pose.z - z));
    this.population.update(population.slice(0, renderProfile().touch ? 24 : MAX_VISIBLE_CIVILIANS), seconds);
    this.stats.civilians = this.population.stats.count;
    this.stats.draws = (this.walls.count ? 1 : 0) + (this.signs.count ? 1 : 0) + (this.arrows.count ? 1 : 0) + [...this.props.values()].filter(m => m.count).length + this.population.stats.draws;
    this.stats.triangles = this.walls.count * 12 + this.signs.count * 2 + this.arrows.count * 3 + this.population.stats.triangles;
    for (const mesh of this.props.values()) this.stats.triangles += mesh.count * (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) / 3;
  }

  private rebuild(venues: CityVenue[], markers: CityLifeMarker[], solids: ReturnType<typeof cityLifePlan>['solids']): void {
    this.walls.count = this.signs.count = 0; for (const mesh of this.props.values()) mesh.count = 0;
    const ids = new Set(venues.map(v => v.id));
    const boxes = disjointStructureBoxes(solids.filter(box => ids.has(box.venueId))) as typeof solids;
    for (const box of boxes.slice(0, 1400)) {
      this.matrix.compose(this.position.set(box.x, box.y, box.z), IDENTITY, this.scale.set(box.hx, box.hy, box.hz));
      this.walls.setMatrixAt(this.walls.count, this.matrix);
      const cityId = Math.floor(box.venueId / 1000), palette = cityId === 2 ? [0x536474, 0x354451] : cityId === 3 ? [0xc0b597, 0x978b71] : [0xa8a69a, 0x6a828b];
      this.walls.setColorAt(this.walls.count++, this.tint.set(box.surface === 'wood' ? 0x907554 : box.surface === 'metal' ? 0x596e77 : palette[box.surface === 'roof' ? 1 : 0]));
    }
    const sign = (index: number, x: number, y: number, z: number, width: number, height: number, yaw: number): void => {
      this.rotation.setFromAxisAngle(this.up, yaw); this.matrix.compose(this.position.set(x, y, z), this.rotation, this.scale.set(width, height, 1));
      this.signs.setMatrixAt(this.signs.count, this.matrix); this.signIndexes.setX(this.signs.count++, index);
    };
    for (const venue of venues) {
      const mesh = this.props.get(venue.kind)!;
      this.rotation.setFromAxisAngle(this.up, venue.yaw); this.matrix.compose(this.position.set(venue.x, venue.y, venue.z), this.rotation, this.scale.set(venue.hx / 8, 1, venue.hz / 7));
      mesh.setMatrixAt(mesh.count++, this.matrix);
      sign(KINDS.indexOf(venue.kind), venue.x + Math.sin(venue.yaw) * (venue.hz + .46), venue.y + (venue.kind === 'aerodrome' ? 6 : 4.1),
        venue.z + Math.cos(venue.yaw) * (venue.hz + .46), venue.kind === 'aerodrome' ? 19 : 6.5, venue.kind === 'aerodrome' ? 3 : 1.35, venue.yaw);
    }
    this.arrows.count = 0;
    for (const marker of markers) {
      const yaw = Math.atan2(marker.targetX - marker.x, marker.targetZ - marker.z);
      sign(7, marker.x, marker.y + 6.5, marker.z, 12, 3, yaw);
      this.rotation.setFromAxisAngle(this.up, yaw);
      this.matrix.compose(this.position.set(marker.x, marker.y + .08, marker.z), this.rotation, this.scale.setScalar(1));
      this.arrows.setMatrixAt(this.arrows.count++, this.matrix);
    }
    for (const mesh of [this.walls, this.signs, this.arrows, ...this.props.values()]) {
      mesh.visible = mesh.count > 0; mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true; if (mesh.count) mesh.computeBoundingSphere();
    }
    this.signIndexes.needsUpdate = true; this.stats.venues = venues.length; this.stats.boxes = this.walls.count;
  }
  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    this.population.dispose(); this.geometry.dispose(); this.material.dispose(); this.propMaterial.dispose();
    for (const mesh of this.props.values()) { mesh.geometry.dispose(); mesh.dispose(); }
    this.walls.dispose(); this.signs.dispose(); this.signGeometry.dispose(); this.signMaterial.dispose(); this.signTexture.dispose();
    this.arrows.dispose(); this.arrowGeometry.dispose(); this.arrowMaterial.dispose(); this.group.clear();
  }
}
