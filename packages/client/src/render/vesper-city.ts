import * as THREE from 'three';
import type { World, Box } from '@shared/worldgen';
import type { CapitalSweep, CapitalPlan } from '@shared/capital-geometry';
import { buildVesperPlan } from '@shared/vesper-city';
import { disjointStructureBoxes } from '@shared/structures';

export const VESPER_DETAIL_DISTANCE = 1550;
export const VESPER_VISIBLE_DISTANCE = 6500;
const CHUNK_SIZE = 1024;
interface SkylineChunk { near: THREE.Mesh | null; far: THREE.Mesh; center: THREE.Vector3; sweeps: CapitalSweep[] }
export function vesperDeckBoxes(plan: CapitalPlan): (Box & { source: number })[] {
  return disjointStructureBoxes(plan.solids.map((box, source) => ({ ...box, source }))) as (Box & { source: number })[];
}

/** One continuous closed skin per canonical sweep. Fine rings add fluted
 * metal facets; distant skins keep the same curved centerline and tip. */
export function vesperSweepGeometry(sweeps: readonly CapitalSweep[], detailed: boolean): THREE.BufferGeometry {
  const positions: number[] = [], colors: number[] = [], glow: number[] = [], coordinates: number[] = [], accents: number[] = [], indices: number[] = [];
  const seamPairs: [number, number][] = [];
  const tangent = new THREE.Vector3(), normal = new THREE.Vector3(), binormal = new THREE.Vector3();
  const rgb = new THREE.Color(), accent = new THREE.Color();
  for (const sweep of sweeps) {
    // Fine collars and exterior lattice disappear into the solid body at
    // kilometre distances; hooked bodies and major bridge ribs remain.
    if (!detailed && sweep.kind === 'rib' && sweep.id >= 5000) continue;
    const sides = detailed ? sweep.kind === 'spire' ? 18 : 6 : sweep.kind === 'spire' ? 6 : 4;
    const stride = detailed ? 1 : sweep.kind === 'spire' ? 3 : 2;
    const ringSize = sides + 1;
    const points = sweep.points.filter((_, i) => i % stride === 0 || i === sweep.points.length - 1);
    const base = positions.length / 3;
    normal.set(1, 0, 0);
    rgb.set(sweep.color); accent.set(sweep.accent);
    for (let j = 0; j < points.length; j++) {
      const p = points[j], previous = points[Math.max(0, j - 1)], next = points[Math.min(points.length - 1, j + 1)];
      tangent.set(next.x - previous.x, next.y - previous.y, next.z - previous.z).normalize();
      normal.addScaledVector(tangent, -normal.dot(tangent));
      if (normal.lengthSq() < .01) normal.set(0, 0, 1).addScaledVector(tangent, -tangent.z);
      normal.normalize(); binormal.crossVectors(tangent, normal).normalize();
      for (let k = 0; k <= sides; k++) {
        const angle = k * Math.PI * 2 / sides;
        // Ridges stay inside the authoritative swept radius envelope.
        const flute = detailed && sweep.kind === 'spire' ? .94 + .06 * Math.cos(angle * 3) : 1;
        const radius = p.radius * flute, a = Math.cos(angle) * radius, b = Math.sin(angle) * radius;
        positions.push(p.x + normal.x * a + binormal.x * b,
          p.y + normal.y * a + binormal.y * b, p.z + normal.z * a + binormal.z * b);
        const shade = .72 + .28 * Math.cos(angle * 3 + .3);
        colors.push(rgb.r * shade, rgb.g * shade, rgb.b * shade);
        glow.push(sweep.kind === 'spire' ? 1 : 0);
        coordinates.push(k / sides, p.y, p.radius);
        accents.push(accent.r, accent.g, accent.b);
        if (j && k < sides) {
          const v = base + j * ringSize + k, prior = v - ringSize, n = v + 1;
          indices.push(prior, n, v, prior, n - ringSize, n);
        }
      }
      seamPairs.push([base + j * ringSize, base + j * ringSize + sides]);
    }
    // Both ends are capped; flying below a sweep cannot expose a hollow tube.
    for (const [j, reverse] of [[0, true], [points.length - 1, false]] as const) {
      const p = points[j], center = positions.length / 3;
      positions.push(p.x, p.y, p.z); colors.push(rgb.r, rgb.g, rgb.b); glow.push(0);
      coordinates.push(0, p.y, p.radius); accents.push(accent.r, accent.g, accent.b);
      for (let k = 0; k < sides; k++) {
        const a = base + j * ringSize + k, b = a + 1;
        indices.push(center, reverse ? b : a, reverse ? a : b);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute('sweepGlow', new THREE.Float32BufferAttribute(glow, 1));
  geometry.setAttribute('sweepCoord', new THREE.Float32BufferAttribute(coordinates, 3));
  geometry.setAttribute('sweepAccent', new THREE.Float32BufferAttribute(accents, 3));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  const normals = geometry.attributes.normal;
  for (const [a, b] of seamPairs) {
    normal.set(normals.getX(a) + normals.getX(b), normals.getY(a) + normals.getY(b), normals.getZ(a) + normals.getZ(b)).normalize();
    normals.setXYZ(a, normal.x, normal.y, normal.z); normals.setXYZ(b, normal.x, normal.y, normal.z);
  }
  geometry.computeBoundingSphere(); geometry.computeBoundingBox();
  return geometry;
}

function skylineMaterial(): THREE.MeshPhongMaterial {
  const material = new THREE.MeshPhongMaterial({ color: 0xffffff, vertexColors: true, shininess: 18, specular: 0x333e49 });
  material.customProgramCacheKey = () => 'vesper-inhabited-citadels-v2';
  material.onBeforeCompile = shader => {
    shader.vertexShader = 'attribute float sweepGlow; attribute vec3 sweepCoord; attribute vec3 sweepAccent; varying float vSweepGlow; varying vec3 vSweepCoord; varying vec3 vSweepAccent;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvSweepGlow = sweepGlow; vSweepCoord = sweepCoord; vSweepAccent = sweepAccent;');
    shader.fragmentShader = 'varying float vSweepGlow; varying vec3 vSweepCoord; varying vec3 vSweepAccent;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `
      #include <color_fragment>
      float ribs = pow(.5 + .5 * cos(vSweepCoord.x * 150.796), 10.0);
      float strata = 1.0 - smoothstep(.035, .095, abs(fract(vSweepCoord.y / 21.0) - .5));
      diffuseColor.rgb *= mix(1.0, .60 + .32 * ribs + .25 * strata, vSweepGlow);
    `);
    shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
      float columns = 72.0;
      float column = floor(vSweepCoord.x * columns);
      float rowCoord = vSweepCoord.y / 9.0 + fract(sin(column * 17.23) * 132.13);
      float row = floor(rowCoord);
      float gate = step(.70, fract(sin(column * 13.31 + row * 71.7) * 14931.17));
      float edge = max(.016, fwidth(vSweepCoord.x * columns));
      float slit = 1.0 - smoothstep(.05, .05 + edge, abs(fract(vSweepCoord.x * columns) - .5));
      float end = max(.035, fwidth(rowCoord));
      float section = smoothstep(.14, .14 + end, fract(rowCoord)) * (1.0 - smoothstep(.72 - end, .72, fract(rowCoord)));
      float resolution = 1.0 - smoothstep(.45, 1.2, fwidth(vSweepCoord.x * columns));
      totalEmissiveRadiance += vSweepAccent * slit * section * gate * resolution * vSweepGlow * .55;
      `);
  };
  return material;
}

function deckMaterial(): THREE.MeshPhongMaterial {
  const material = new THREE.MeshPhongMaterial({ color: 0xffffff, shininess: 12, specular: 0x323b45 });
  material.customProgramCacheKey = () => 'vesper-inlaid-route-decks-v1';
  material.onBeforeCompile = shader => {
    shader.vertexShader = 'attribute vec4 instanceDeckBounds; varying vec3 vDeckLocal; varying vec3 vDeckExtent; varying float vDeckTop;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `
      #include <begin_vertex>
      vDeckExtent = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
      vec3 originalPosition = (instanceMatrix * vec4(position, 1.0)).xyz;
      vDeckExtent.xz = instanceDeckBounds.zw;
      vDeckLocal = vec3(originalPosition.x - instanceDeckBounds.x, position.y * vDeckExtent.y,
        originalPosition.z - instanceDeckBounds.y); vDeckTop = max(0.0, normal.y);
    `);
    shader.fragmentShader = 'varying vec3 vDeckLocal; varying vec3 vDeckExtent; varying float vDeckTop;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `
      #include <color_fragment>
      vec2 panel = abs(fract(vDeckLocal.xz / 8.0) - .5);
      vec2 aa = max(vec2(.015), fwidth(vDeckLocal.xz / 8.0));
      float joint = max(smoothstep(.47 - aa.x, .49, panel.x), smoothstep(.47 - aa.y, .49, panel.y));
      diffuseColor.rgb *= 1.0 - joint * .33 * vDeckTop;
    `);
    shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', `
      #include <emissivemap_fragment>
      float zLong = step(vDeckExtent.x, vDeckExtent.z);
      float along = mix(vDeckLocal.x, vDeckLocal.z, zLong);
      float across = abs(mix(vDeckLocal.z, vDeckLocal.x, zLong));
      float halfWidth = mix(vDeckExtent.z, vDeckExtent.x, zLong);
      float edgeAA = max(.06, fwidth(across));
      float inlay = 1.0 - smoothstep(.10, .10 + edgeAA, abs(across - halfWidth + 1.4));
      float dash = step(.18, fract(along / 12.0));
      totalEmissiveRadiance += vec3(.06,.32,.38) * inlay * dash * vDeckTop;
    `);
  };
  return material;
}

/** A complete distant skyline stays visible independently of terrain leaves.
 * Only nearby1024m districts use detailed skins; all decks share one draw. */
export class VesperCity {
  readonly group = new THREE.Group();
  readonly stats = { triangles: 0, draws: 0, detailedChunks: 0, silhouetteChunks: 0, boxes: 0 };
  private readonly chunks: SkylineChunk[] = [];
  private readonly material = skylineMaterial();
  private readonly deckMaterial = deckMaterial();
  private readonly deckGeometry = new THREE.BoxGeometry(2, 2, 2);
  private decks: THREE.InstancedMesh | null = null;
  private cityCenter: THREE.Vector3 | null = null;
  private currentKey = '';
  private disposed = false;

  constructor(private readonly world: Pick<World, 'collectCities'>) { this.group.name = 'vesper-abyss-city'; }

  private build(): void {
    const city = this.world.collectCities().find(city => city.theme === 'vesper');
    if (!city) return;
    const key = `${city.seed}:${city.x}:${city.y}:${city.z}:${city.radius}`;
    if (this.currentKey === key) return;
    this.clearGeometry(); this.currentKey = key; this.cityCenter = new THREE.Vector3(city.x, city.y, city.z);
    const plan = buildVesperPlan(city), groups = new Map<string, CapitalSweep[]>();
    for (const sweep of plan.sweeps) {
      const p = sweep.points[Math.floor(sweep.points.length / 2)];
      const key = `${Math.floor((p.x - city.x) / CHUNK_SIZE)},${Math.floor((p.z - city.z) / CHUNK_SIZE)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(sweep);
    }
    for (const sweeps of groups.values()) {
      const far = new THREE.Mesh(vesperSweepGeometry(sweeps, false), this.material);
      far.name = 'vesper-distant-silhouette';
      const center = far.geometry.boundingSphere!.center.clone();
      this.chunks.push({ near: null, far, center, sweeps }); this.group.add(far);
    }
    const visualBoxes = vesperDeckBoxes(plan);
    const sourceBounds = new THREE.InstancedBufferAttribute(new Float32Array(visualBoxes.length * 4), 4);
    this.deckGeometry.setAttribute('instanceDeckBounds', sourceBounds);
    this.decks = new THREE.InstancedMesh(this.deckGeometry, this.deckMaterial, visualBoxes.length);
    this.decks.name = 'vesper-canonical-decks';
    const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), scale = new THREE.Vector3(), identity = new THREE.Quaternion();
    const color = new THREE.Color();
    for (const [i, box] of visualBoxes.entries()) {
      matrix.compose(position.set(box.x, box.y, box.z), identity, scale.set(box.hx, box.hy, box.hz));
      this.decks.setMatrixAt(i, matrix); this.decks.setColorAt(i, color.set(box.facade === 20 ? 0x343a4a : 0x536072));
      const source = plan.solids[box.source]; sourceBounds.setXYZW(i, source.x, source.z, source.hx, source.hz);
    }
    this.decks.computeBoundingSphere(); this.group.add(this.decks);
  }

  update(x: number, y: number, z: number): void {
    if (this.disposed || ![x, y, z].every(Number.isFinite)) return;
    const city = this.world.collectCities().find(city => city.theme === 'vesper');
    if (!city) return;
    const inRange = Math.hypot(x - city.x, z - city.z) < VESPER_VISIBLE_DISTANCE;
    this.group.visible = inRange;
    this.stats.triangles = this.stats.draws = this.stats.detailedChunks = this.stats.silhouetteChunks = this.stats.boxes = 0;
    if (!inRange) return;
    this.build();
    if (this.decks) { this.stats.boxes = this.decks.count; this.stats.triangles += this.decks.count * 12; this.stats.draws++; }
    let prepared = false;
    for (const chunk of this.chunks) {
      const distance = Math.hypot(x - chunk.center.x, (y - chunk.center.y) * .5, z - chunk.center.z);
      if (distance < VESPER_DETAIL_DISTANCE && !chunk.near && !prepared) {
        chunk.near = new THREE.Mesh(vesperSweepGeometry(chunk.sweeps, true), this.material);
        chunk.near.name = 'vesper-detailed-skins'; this.group.add(chunk.near); prepared = true;
      }
      const detailed = distance < VESPER_DETAIL_DISTANCE && !!chunk.near;
      if (chunk.near) chunk.near.visible = detailed;
      chunk.far.visible = !detailed;
      this.stats.triangles += (detailed ? chunk.near! : chunk.far).geometry.index!.count / 3;
      this.stats.draws++;
      if (detailed) this.stats.detailedChunks++; else this.stats.silhouetteChunks++;
    }
  }

  private clearGeometry(): void {
    for (const chunk of this.chunks) { chunk.near?.geometry.dispose(); chunk.far.geometry.dispose(); }
    this.chunks.length = 0; this.decks?.dispose(); this.decks = null; this.group.clear();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.clearGeometry(); this.deckGeometry.dispose(); this.deckMaterial.dispose(); this.material.dispose();
  }
}
