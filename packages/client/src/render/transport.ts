import * as THREE from 'three';
import type { World, Box } from '@shared/worldgen';
import { transportPose, transportBoxes, harborDockSide, type TransportPlan, type TransportRoute, type TransportStation, RAIL_HEIGHT } from '@shared/transport';
import { disjointStructureBoxes } from '@shared/structures';
import { VehicleGeometry } from './vehicle-geometry.js';
import { renderProfile } from './device-profile.js';
import { createIndustrialMaterial } from './industrial-material.js';

export const TRANSPORT_DRAW_BUDGET = 17;
const BLUE = 0x315d70, WHITE = 0xc3cac8, DARK = 0x25353e, GOLD = 0xd2a657, STEEL = 0x667f86;
const PALETTE: Record<number, number> = { 120: STEEL, 121: 0x34474e, 122: 0x61767b, 123: 0x667273, 124: BLUE, 125: 0x8a8170, 126: GOLD };

function transportModel(route: TransportRoute, car: number, material: THREE.Material): THREE.BufferGeometry {
  const m = new VehicleGeometry(), ferry = route.kind === 'ferry';
  for (const b of disjointStructureBoxes(transportBoxes(route, car))) m.box(b.hx * 2, b.hy * 2, b.hz * 2, b.x, b.y, b.z,
    ferry ? b.y < 2 ? BLUE : b.hy < .5 ? STEEL : WHITE : b.y < 1.3 ? DARK : car === 0 ? 0x49776c : car === 1 ? WHITE : STEEL);
  if (ferry) {
    // A shaped waterline, raised bow plates and separate cargo/passenger
    // decks make the ship read as a working vessel at every viewing angle.
    for (const end of [-1, 1]) {
      m.prism([[-12.9, .4, end * 29], [12.9, .4, end * 29], [10, .4, end * 32], [-10, .4, end * 32]], [0, -2.4, 0], BLUE);
      for (const side of [-1, 1]) m.box(.15, .18, 10, side * 12.8, 2.6, end * 22, GOLD);
    }
    for (const side of [-1, 1]) {
      for (let z = -12; z <= 11; z += 3.3) {
        if (side > 0 && z > 7.5) continue;
        m.box(.06, 1.8, 2.5, side * 10.33, 9.9, z, 0x214750);
        m.box(.08, .10, 2.7, side * 10.36, 8.95, z, GOLD);
      }
      for (const z of [-22, 22]) {
        m.add(new THREE.TorusGeometry(.8, .2, 7, 18), 0xdb7e40, [side * 13.04, 4.2, z], [0, Math.PI / 2, 0]);
        m.box(.15, 1.8, .13, side * 13.1, 4.2, z, WHITE);
      }
      for (let z = -10; z <= 10; z += 4.5) {
        m.box(1.4, .6, 1.8, side * 7.2, 8.32, z, 0x537d76);
        m.box(.25, 1.25, 1.8, side * 7.8, 8.68, z, 0x40625e);
      }
      for (let z = -12; z <= 12; z += 4) m.tube(.065, [side * 9.9, 12, z], [side * 9.9, 13, z], WHITE, 6);
      m.tube(.07, [side * 9.9, 13, -13], [side * 9.9, 13, 13], WHITE, 6);
      for (const z of [-20, 20]) m.add(new THREE.CylinderGeometry(.32, .4, .7, 10), DARK, [side * 10, 2.35, z]);
    }
    m.box(4, 1.7, 3, 0, 12.9, -8, BLUE); m.box(3.7, .7, .05, 0, 13.3, -9.53, 0x82adb2);
    m.tube(.12, [0, 13.8, -8], [0, 18, -8], WHITE, 8); m.tube(.07, [-2.5, 16.8, -8], [2.5, 16.8, -8], WHITE, 6);
    m.box(4, .10, 1.1, 0, 17.5, -8, DARK);
    for (let i = 0; i < 7; i++) m.box(.16, .015, 3.5, -3 + i, 2.018, 0, GOLD);
    for (const end of [-1, 1]) m.box(.12, .02, 15, 0, 2.024, end * 16, GOLD);
  } else {
    for (const z of [-8, 8]) {
      m.box(8.8, .7, 4.8, 0, -.35, z, DARK);
      for (const x of [-4.6, 4.6]) for (const dz of [-1.4, 1.4]) m.add(new THREE.CylinderGeometry(.82, .82, .48, 14).rotateZ(Math.PI / 2), 0x20272a, [x, -.55, z + dz]);
    }
    if (car === 0) {
      m.box(6.4, 1.2, .08, 0, 3.9, -11.56, 0x77a8af);
      for (const side of [-1, 1]) {
        m.box(.07, 1.5, 3.4, side * 3.55, 3.8, -7, 0x77a8af);
        m.box(.08, .5, 5, side * 3.55, 2, -6.5, GOLD);
        m.add(new THREE.CylinderGeometry(.4, .4, .2, 10).rotateX(Math.PI / 2), 0xf0dca3, [side * 2.3, 2.8, -11.7]);
      }
      for (let i = 0; i < 8; i++) m.box(.16, .035, 3, -2 + i * .55, 5.63, -7, DARK);
      m.box(3.8, 2, 4, 0, 2.2, 2, 0x46685c);
    } else if (car === 1) {
      for (const side of [-1, 1]) for (let z = -10; z <= 10; z += 3.4) {
        m.box(.045, 1.55, 2.6, side * 4.93, 3.5, z, 0x2f5961);
        m.box(.05, .1, 2.7, side * 4.96, 2.65, z, GOLD);
      }
      m.box(.8, .02, 23, 0, 1.224, 0, 0x9c6c49);
    } else {
      for (let z = -11; z <= 11; z += 1.5) m.box(9, .025, .055, 0, 1.22, z, 0x82908b);
      for (const side of [-1, 1]) m.box(.22, .025, 24, side * 3.8, 1.24, 0, GOLD);
      if (car === 3) for (const side of [-1, 1]) for (const z of [-9, 9]) {
        m.box(1.5, 1.6, 2.5, side * 3.3, 2, z, 0x4b6259);
        m.box(1.52, .16, 2.52, side * 3.3, 2.7, z, GOLD);
      }
    }
    for (const side of [-1, 1]) m.box(1.1, .7, .3, 0, .6, side * 14.25, DARK);
  }
  return m.mesh(material, ferry ? 'passenger-vehicle-ferry' : `rail-car-${car}`).geometry;
}

function stationDetails(material: THREE.Material): THREE.BufferGeometry {
  const m = new VehicleGeometry();
  // Open launch cradle. The gantry sits ten metres ahead of the launch
  // axis, framing the landscape without covering the passenger's ascent.
  const cyan = 0x85e2d6;
  m.add(new THREE.CylinderGeometry(6.1, 6.15, .07, 64), DARK, [104, .042, 82]);
  m.add(new THREE.RingGeometry(5.72, 5.82, 64), cyan, [104, .085, 82], [-Math.PI / 2, 0, 0]);
  m.add(new THREE.RingGeometry(1.05, 1.14, 48), GOLD, [104, .086, 82], [-Math.PI / 2, 0, 0]);
  for (let i = 0; i < 16; i++) {
    const angle = i * Math.PI / 8;
    m.box(.10, .012, .48, 104 + Math.sin(angle) * 5.42, .091, 82 + Math.cos(angle) * 5.42, i % 4 ? WHITE : GOLD, 0, angle);
    const a = angle + .018, b = angle + Math.PI / 8 - .018;
    m.prism([[104 + Math.sin(a) * 1.45, .088, 82 + Math.cos(a) * 1.45],
      [104 + Math.sin(a) * 5.18, .088, 82 + Math.cos(a) * 5.18],
      [104 + Math.sin(b) * 5.18, .088, 82 + Math.cos(b) * 5.18],
      [104 + Math.sin(b) * 1.45, .088, 82 + Math.cos(b) * 1.45]], [0, -.02, 0], i % 2 ? 0x3e565c : 0x4b6165);
  }
  for (const side of [-1, 1]) {
    const x = 104 + side * 6.2;
    // These base volumes also appear in the authoritative transport plan.
    m.box(1.32, .22, 2.02, x, 1.45, 73, GOLD);
    m.prism([[x - .65, 1.8, 72.4], [x + .65, 1.8, 72.4],
      [104 + side * 4.8 + .48, 8.1, 72], [104 + side * 4.8 - .48, 8.1, 72]], [0, 0, 1.2], WHITE);
    m.tube(.25, [x + side * .24, 1.9, 73.72], [104 + side * 4.9, 7.8, 73.15], STEEL, 16);
    m.tube(.12, [x - side * .38, 2.2, 73.68], [104 + side * 4.6, 7.6, 73.06], cyan, 12);
    for (const height of [2.6, 4.2, 5.8]) {
      const px = x - side * (height - 1.8) * .222;
      m.box(1.25, .16, 1.34, px, height, 72.91 - (height - 1.8) * .065, DARK);
    }
    m.add(new THREE.CylinderGeometry(.36, .36, .16, 20), GOLD, [x, 1.12, 74.05], [Math.PI / 2, 0, 0]);
    m.box(.32, 2.5, .32, x + side * 1.1, 2.8, 73, DARK);
    m.box(.12, 1.9, .12, x + side * 1.1, 3.02, 73.19, cyan);
  }
  m.loft([{ z: 71.8, y: 8.3, w: 5.2, h: .45 }, { z: 72.3, y: 8.3, w: 5.7, h: .65 },
    { z: 73.3, y: 8.3, w: 5.2, h: .45 }], WHITE, 104);
  m.box(8.9, .91, .045, 104, 8.3, 73.34, DARK);
  m.box(8.6, .07, .06, 104, 7.72, 73.33, cyan);
  for (const side of [-1, 1]) {
    m.box(.12, .65, .05, 104 + side * 4.78, 8.3, 73.36, GOLD);
    for (let i = 0; i < 4; i++) m.box(.11, .34, .055, 104 + side * (5 + i * .14), 8.26, 73.22, DARK);
  }
  m.box(1.06, .28, 1.06, 112, 1.4, 84, STEEL);
  m.box(.86, .62, .08, 112, 1.86, 83.5, DARK, -.22);
  m.box(.71, .43, .025, 112, 1.86, 83.435, cyan, -.22);
  for (const side of [-1, 1]) for (let i = 0; i < 4; i++) m.box(.06, .01, 2.1, 104 + side * .8, .022, 68 - i * 2.6, GOLD);
  // Loading-lift guide pylons visually join lower hall and elevated station.
  for (const x of [62, 82]) for (const z of [53, 83]) m.box(.35, 12, .35, x, 6, z, BLUE);
  for (const x of [49, 111]) {
    m.box(.35, 7, .35, x, 3.5, 98, WHITE);
    m.box(.5, .5, .5, x, 7.2, 98, GOLD);
  }
  for (let i = 0; i < 6; i++) m.box(1.2, .015, .18, 90 + i * 2, .018, 82, GOLD);
  return m.mesh(material, 'airlift-station-details').geometry;
}

function platformDetails(material: THREE.Material): THREE.BufferGeometry {
  const m = new VehicleGeometry();
  for (const side of [-1, 1]) for (const z of [-62, 44]) {
    const x = side * 65;
    m.box(24, .08, .22, x, 5.66, z + 6, 0xd9eadb);
    for (const dx of [-13, 13]) m.box(.6, .12, 12, x + dx, 5.66, z, GOLD);
    for (const dx of [-8, 8]) for (let n = 0; n < 6; n++) m.box(.045, .025, 1.75, x + dx - 2.7 + n * 1.1, .915, z - 3, DARK);
    for (let n = 0; n < 5; n++) m.add(new THREE.IcosahedronGeometry(1.1, 0), n % 2 ? 0x5c8063 : 0x365d4a, [x + side * 19 + (n % 2 - .5) * 1.8, 1.45, z - 2 + n]);
    m.box(.9, 1.8, .7, x - 20, .9, z + 8, BLUE); m.box(.65, .9, .04, x - 20, 1.18, z + 8.37, 0x8be6cf);
  }
  // Painted safety edges and arrows point out of the track wells.
  for (const side of [-1, 1]) {
    for (let z = -120; z <= 120; z += 8) m.box(.5, .025, 3.2, side * 18.2, .025, z, GOLD);
    for (const z of [-100, 100]) {
      m.box(3.2, .025, .45, side * 31, .025, z, 0x7ddfbd);
      m.box(.45, .025, 2.5, side * 32.3, .025, z, 0x7ddfbd);
    }
  }
  m.box(2.2, 2.2, .04, 47.5, 2.8, -43.56, 0x76d6b4);
  m.box(.45, 1.7, .05, 47.5, 2.8, -43.52, WHITE); m.box(1.7, .45, .05, 47.5, 2.8, -43.5, WHITE);
  m.box(4, 1.7, .04, 55.5, 2.8, -43.56, DARK);
  return m.mesh(material, 'station-waiting-room-details').geometry;
}

interface TrackPiece { x: number; z: number; length: number; yaw: number }
export class TransportRenderer {
  readonly group = new THREE.Group();
  readonly stats = { bodies: 0, staticBoxes: 0, draws: 0, triangles: 0 };
  private readonly plan: TransportPlan;
  private readonly material = createIndustrialMaterial();
  private readonly solidMaterial = createIndustrialMaterial(false);
  private readonly boxGeometry = new THREE.BoxGeometry(2, 2, 2);
  private readonly solids: THREE.InstancedMesh;
  private readonly bodies = new Map<string, THREE.InstancedMesh>();
  private readonly stations: THREE.InstancedMesh;
  private readonly platforms: THREE.InstancedMesh;
  private readonly bridges: THREE.Mesh;
  private readonly bridgePositions: Float32Array;
  private readonly bridgeNormals: Float32Array;
  private readonly bridgeColors: Float32Array;
  private readonly rails = new THREE.InstancedMesh(this.boxGeometry, this.solidMaterial, 5000);
  private readonly tracks: TrackPiece[] = [];
  private readonly matrix = new THREE.Matrix4();
  private readonly transform = new THREE.Object3D();
  private readonly color = new THREE.Color();
  private readonly boardCanvas: HTMLCanvasElement | null;
  private readonly boardTexture: THREE.Texture;
  private readonly boardMaterial: THREE.MeshBasicMaterial;
  private readonly boardGeometry = new THREE.PlaneGeometry(1, 1);
  private readonly boards: THREE.InstancedMesh;
  private readonly boardRows = new THREE.InstancedBufferAttribute(new Float32Array(32), 1);
  private signature = '';
  private boardSecond = -1;
  private visibleBoards: { x: number; y: number; z: number; name: string; stopId: number; hint?: string; yaw?: number; width?: number; height?: number }[] = [];
  private disposed = false;

  constructor(world: Pick<World, 'collectTransportPlan'>) {
    this.plan = world.collectTransportPlan(); this.group.name = 'public-transport';
    // These are already simple boxes/prisms. Keep the complete, inexpensive
    // structural silhouette resident; camera clipping and fog hide its far end.
    this.solids = new THREE.InstancedMesh(this.boxGeometry, this.solidMaterial, Math.max(1, this.plan.solids.length));
    this.bridgePositions = new Float32Array(this.plan.bridges.length * 36 * 3);
    this.bridgeNormals = new Float32Array(this.bridgePositions.length);
    this.bridgeColors = new Float32Array(this.bridgePositions.length);
    this.solids.name = 'harbor-and-rail-structure'; this.solids.count = 0; this.rails.name = 'running-rails-and-sleepers'; this.rails.count = 0;
    this.stations = new THREE.InstancedMesh(stationDetails(this.material), this.material, 8); this.stations.count = 0;
    this.platforms = new THREE.InstancedMesh(platformDetails(this.material), this.material, 8); this.platforms.count = 0; this.group.add(this.platforms);
    const bridgeGeometry = new THREE.BufferGeometry();
    bridgeGeometry.setAttribute('position', new THREE.BufferAttribute(this.bridgePositions, 3).setUsage(THREE.DynamicDrawUsage));
    bridgeGeometry.setAttribute('normal', new THREE.BufferAttribute(this.bridgeNormals, 3).setUsage(THREE.DynamicDrawUsage));
    bridgeGeometry.setAttribute('color', new THREE.BufferAttribute(this.bridgeColors, 3).setUsage(THREE.DynamicDrawUsage));
    bridgeGeometry.setDrawRange(0, 0);
    this.bridges = new THREE.Mesh(bridgeGeometry, this.material); this.bridges.name = 'continuous-viaduct-ribbons'; this.bridges.visible = false;
    this.group.add(this.bridges);
    for (const route of this.plan.routes) for (let car = 0; car < route.carOffsets.length; car++) {
      const key = route.kind === 'ferry' ? 'ferry' : `train-${car}`;
      if (this.bodies.has(key)) continue;
      const mesh = new THREE.InstancedMesh(transportModel(route, car, this.material), this.material, 16);
      mesh.name = key; mesh.count = 0; this.bodies.set(key, mesh); this.group.add(mesh);
    }
    for (const route of this.plan.routes.filter(r => r.kind === 'train')) {
      const path = route.legs[0];
      for (let i = 1; i < path.points.length; i++) {
        const a = path.points[i - 1], b = path.points[i], length = Math.hypot(b.x - a.x, b.z - a.z), count = Math.ceil(length / 24);
        for (let n = 0; n < count; n++) this.tracks.push({ x: a.x + (b.x - a.x) * (n + .5) / count,
          z: a.z + (b.z - a.z) * (n + .5) / count, length: length / count, yaw: Math.atan2(b.x - a.x, b.z - a.z) });
      }
    }
    this.boardCanvas = typeof document === 'undefined' ? null : document.createElement('canvas');
    if (this.boardCanvas) { this.boardCanvas.width = 768; this.boardCanvas.height = 2048; this.boardTexture = new THREE.CanvasTexture(this.boardCanvas); }
    else this.boardTexture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    this.boardMaterial = new THREE.MeshBasicMaterial({ map: this.boardTexture, side: THREE.DoubleSide });
    this.boardGeometry.setAttribute('instanceBoard', this.boardRows);
    this.boardMaterial.customProgramCacheKey = () => 'transit-countdown-atlas-v1';
    this.boardMaterial.onBeforeCompile = shader => {
      shader.vertexShader = 'attribute float instanceBoard;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\nvMapUv.y = (vMapUv.y + 15.0 - instanceBoard) / 16.0;');
    };
    this.boards = new THREE.InstancedMesh(this.boardGeometry, this.boardMaterial, 32); this.boards.count = 0;
    this.group.add(this.solids, this.rails, this.stations, this.boards);
    for (const mesh of [this.solids, this.stations, this.platforms, this.bridges, ...this.bodies.values()]) {
      mesh.castShadow = true; mesh.receiveShadow = true;
    }
    this.rebuildBridges();
    for (const b of this.plan.solids) {
      this.put(this.solids, b.x, b.y, b.z, b.hx, b.hy, b.hz);
      this.solids.setColorAt(this.solids.count - 1, this.color.setHex(PALETTE[b.facade ?? 120] ?? STEEL));
    }
    this.finish(this.solids);
  }

  update(seconds: number, x: number, y: number, z: number): void {
    if (this.disposed) return;
    const key = `${Math.floor(x / 128)}:${Math.floor(z / 128)}:${Math.floor(y / 128)}`;
    if (key !== this.signature) { this.signature = key; this.rebuild(x, y, z); }
    for (const mesh of this.bodies.values()) mesh.count = 0;
    this.stats.bodies = 0;
    const bodyRange = renderProfile().fogFar + 300;
    for (const route of this.plan.routes) for (let car = 0; car < route.carOffsets.length; car++) {
      const pose = transportPose(route, seconds, route.carOffsets[car]);
      if (Math.hypot(pose.x - x, pose.y - y, pose.z - z) > bodyRange) continue;
      const mesh = this.bodies.get(route.kind === 'ferry' ? 'ferry' : `train-${car}`)!;
      this.transform.position.set(pose.x, pose.y, pose.z); this.transform.rotation.set(0, pose.yaw, 0); this.transform.scale.setScalar(1); this.transform.updateMatrix();
      mesh.setMatrixAt(mesh.count++, this.transform.matrix); this.stats.bodies++;
    }
    for (const mesh of this.bodies.values()) this.finish(mesh);
    if (Math.floor(seconds) !== this.boardSecond) { this.boardSecond = Math.floor(seconds); this.paintBoards(seconds); }
    this.stats.draws = this.stats.triangles = 0;
    for (const mesh of [this.solids, this.rails, this.stations, this.platforms, this.boards, ...this.bodies.values()]) if (mesh.count) {
      this.stats.draws++; this.stats.triangles += mesh.count * (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) / 3;
    }
    if (this.bridges.visible) { this.stats.draws++; this.stats.triangles += this.bridges.geometry.drawRange.count / 3; }
  }

  private rebuild(x: number, y: number, z: number): void {
    this.rails.count = this.stations.count = this.platforms.count = this.boards.count = 0;
    for (const t of this.tracks) if (Math.hypot(t.x - x, t.z - z) < 1550) {
      for (const side of [-1, 1]) {
        if (this.rails.count >= 4990) break;
        this.put(this.rails, t.x + Math.cos(t.yaw) * side * 4.3, RAIL_HEIGHT - 1.1, t.z - Math.sin(t.yaw) * side * 4.3, .13, .22, t.length / 2, t.yaw);
        this.rails.setColorAt(this.rails.count - 1, this.color.setHex(0xa5afaa));
      }
      for (let d = -t.length / 2 + 2; d < t.length / 2; d += 4) {
        if (this.rails.count >= 4990) break;
        this.put(this.rails, t.x + Math.sin(t.yaw) * d, RAIL_HEIGHT - 1.24, t.z + Math.cos(t.yaw) * d, 5.1, .07, .19, t.yaw);
        this.rails.setColorAt(this.rails.count - 1, this.color.setHex(0x46545b));
      }
    }
    this.visibleBoards = [];
    for (const s of this.plan.stations) if (Math.hypot(s.x - x, s.z - z) < 1500) {
      this.put(this.stations, s.x, s.y, s.z, 1, 1, 1);
      this.put(this.platforms, s.x, RAIL_HEIGHT + 1.2, s.z, 1, 1, 1);
      this.visibleBoards.push({ x: s.x + 80, y: s.y + 6, z: s.z + 104, name: `${s.name} | AIRLIFT + RAIL`, stopId: s.id,
        hint: 'E AT CYAN ARCH | LIGHT DECK TO TRAINS' });
      this.visibleBoards.push({ x: s.x + 104, y: s.y + 8.3, z: s.z + 73.385, name: 'ORBITAL TRANSIT', stopId: 0, hint: 'E TO BOARD | O STAR SYSTEM', width: 8.5, height: .82 });
      this.visibleBoards.push({ x: s.x + 47, y: RAIL_HEIGHT + 7, z: s.z + 112, name: `${s.name} | PLATFORM`, stopId: s.id, yaw: Math.atan2(-47, -112) });
      this.visibleBoards.push({ x: s.x + 52.5, y: RAIL_HEIGHT + 5.5, z: s.z - 36.7, name: 'AID + GUIDED ROCKETS', stopId: 0, hint: 'FREE RESUPPLY | FIRST AID' });
    }
    for (const h of this.plan.harbors) if (Math.hypot(h.x - x, h.z - z) < 1500) {
      const bx = h.x + Math.cos(h.heading) * 36 * harborDockSide(h), bz = h.z - Math.sin(h.heading) * 36 * harborDockSide(h);
      this.visibleBoards.push({ x: bx, y: h.y + 7, z: bz, name: h.name, stopId: h.id, yaw: Math.atan2(h.landX - bx, h.landZ - bz) });
    }
    this.visibleBoards = this.visibleBoards.slice(0, 16);
    for (const [i, b] of this.visibleBoards.entries()) { this.put(this.boards, b.x, b.y, b.z, b.width ?? 18, b.height ?? 3, 1, b.yaw ?? 0); this.boardRows.setX(this.boards.count - 1, i); }
    this.boardRows.needsUpdate = true; this.boardSecond = -1;
    for (const mesh of [this.rails, this.stations, this.platforms, this.boards]) this.finish(mesh);
    this.stats.staticBoxes = this.solids.count;
  }
  private rebuildBridges(): void {
    let offset = 0;
    const box = new THREE.Box3(), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), normal = new THREE.Vector3();
    for (const piece of this.plan.bridges) {
      const vertices = [piece.bottom, piece.top].flatMap(h => piece.corners.map(p => new THREE.Vector3(p.x, h, p.z)));
      const faces = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
      const center = vertices.reduce((sum, p) => sum.add(p), new THREE.Vector3()).multiplyScalar(1 / 8);
      this.color.setHex(piece.rail ? 0x818d8c : 0x48565a);
      for (const face of faces) {
        a.copy(vertices[face[0]]); b.copy(vertices[face[1]]).sub(a); c.copy(vertices[face[2]]).sub(a); normal.crossVectors(b, c).normalize();
        if (normal.dot(a.clone().sub(center)) < 0) face.reverse();
        a.copy(vertices[face[0]]); b.copy(vertices[face[1]]).sub(a); c.copy(vertices[face[2]]).sub(a); normal.crossVectors(b, c).normalize();
        for (const i of [face[0], face[1], face[2], face[0], face[2], face[3]]) {
          const p = vertices[i]; this.bridgePositions.set([p.x, p.y, p.z], offset); this.bridgeNormals.set([normal.x, normal.y, normal.z], offset);
          this.bridgeColors.set([this.color.r, this.color.g, this.color.b], offset); offset += 3; box.expandByPoint(p);
        }
      }
    }
    const geometry = this.bridges.geometry; geometry.setDrawRange(0, offset / 3); this.bridges.visible = offset > 0;
    for (const name of ['position', 'normal', 'color']) geometry.attributes[name].needsUpdate = true;
    geometry.boundingBox = box; geometry.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
  }
  private put(mesh: THREE.InstancedMesh, x: number, y: number, z: number, hx: number, hy: number, hz: number, yaw = 0): void {
    this.transform.position.set(x, y, z); this.transform.rotation.set(0, yaw, 0); this.transform.scale.set(hx, hy, hz); this.transform.updateMatrix(); mesh.setMatrixAt(mesh.count++, this.transform.matrix);
  }
  private finish(mesh: THREE.InstancedMesh): void {
    mesh.visible = mesh.count > 0; mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    if (mesh.count) mesh.computeBoundingSphere();
  }
  private paintBoards(seconds: number): void {
    if (!this.boardCanvas) return;
    const ctx = this.boardCanvas.getContext('2d')!; ctx.clearRect(0, 0, 768, 2048);
    const time = (s: number) => `${Math.floor(Math.ceil(s) / 60)}:${String(Math.ceil(s) % 60).padStart(2, '0')}`;
    for (const [i, board] of this.visibleBoards.entries()) {
      const routes = this.plan.routes.filter(r => r.stops.some(s => s.id === board.stopId));
      const lines = routes.map(r => {
        const pose = transportPose(r, seconds), at = r.stops.find(s => s.id === board.stopId)!;
        const here = pose.docked && Math.hypot(pose.x - at.x, pose.z - at.z) < 2;
        const until = here ? pose.departureIn : pose.nextStop === board.stopId ? pose.arrivalIn : pose.arrivalIn + r.dwell + r.legs[0].length / r.speed + 3;
        return `${r.kind === 'ferry' ? 'FERRY' : 'TRAIN'} ${r.id} ${here ? 'DEPARTS' : 'ARRIVES'} ${time(until)}`;
      });
      ctx.fillStyle = '#14242c'; ctx.fillRect(0, i * 128, 768, 128); ctx.strokeStyle = '#70b6ba'; ctx.lineWidth = 4; ctx.strokeRect(3, i * 128 + 3, 762, 122);
      ctx.fillStyle = '#e2d5a4'; ctx.font = 'bold 28px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(board.name.toUpperCase(), 384, i * 128 + 35, 738);
      ctx.fillStyle = '#8be6cf'; ctx.font = 'bold 25px monospace';
      const rows = board.hint ? [board.hint, ...lines].slice(0, 2) : lines.slice(0, 2);
      for (const [n, line] of rows.entries()) ctx.fillText(line, 384, i * 128 + 76 + n * 31, 730);
    }
    this.boardTexture.needsUpdate = true;
  }
  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    this.bridges.geometry.dispose();
    this.platforms.geometry.dispose(); this.platforms.dispose();
    for (const mesh of this.bodies.values()) { mesh.geometry.dispose(); mesh.dispose(); }
    this.stations.geometry.dispose(); this.stations.dispose(); this.solids.dispose(); this.rails.dispose(); this.boards.dispose();
    this.boxGeometry.dispose(); this.material.dispose(); this.solidMaterial.dispose(); this.boardGeometry.dispose(); this.boardTexture.dispose(); this.boardMaterial.dispose(); this.group.clear();
  }
}
