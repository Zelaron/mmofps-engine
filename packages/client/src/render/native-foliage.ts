import * as THREE from 'three';

/** Native fanwood membranes and cold-climate whorl fronds. The old placement
 * and solid stem remain authoritative; these open crowns are cosmetic. */
function canopy(segments: number, rings: number): THREE.BufferGeometry {
  const p = [0, .44, 0], uv = [.5, 0], colors = [.39, .48, .43], indices: number[] = [];
  for (let ring = 1; ring <= rings; ring++) {
    const t = ring / rings;
    for (let k = 0; k <= segments; k++) {
      const angle = k / segments * Math.PI * 2;
      const radius = t * (1 + Math.sin(angle * 8 + .4) * .055 * t);
      const rib = Math.cos(angle * 8) * .035 * t;
      p.push(Math.cos(angle) * radius, .44 + .23 * t - .64 * t * t + rib, Math.sin(angle) * radius);
      uv.push(k / segments, t);
      // Pale growing edges and shaded attachment tissue establish volume
      // even on phones without a directional shadow map.
      const light = .44 + t * .48;
      colors.push(light * (1 + t * .05), light, light * (1 - t * .16));
      if (k === segments) continue;
      const outer = 1 + (ring - 1) * (segments + 1) + k;
      if (ring === 1) indices.push(0, outer + 1, outer);
      else {
        const inner = outer - segments - 1;
        indices.push(inner, outer + 1, outer, inner, inner + 1, outer + 1);
      }
    }
  }
  const g = geometry(p, uv, colors, indices), normals = g.getAttribute('normal');
  // UVs repeat at the radial seam; the surface normal must remain smooth.
  for (let ring = 0; ring < rings; ring++) {
    const a = 1 + ring * (segments + 1), b = a + segments;
    const n = new THREE.Vector3(normals.getX(a) + normals.getX(b), normals.getY(a) + normals.getY(b),
      normals.getZ(a) + normals.getZ(b)).normalize();
    normals.setXYZ(a, n.x, n.y, n.z); normals.setXYZ(b, n.x, n.y, n.z);
  }
  return g;
}

function fronds(distant: boolean): THREE.BufferGeometry {
  const p: number[] = [], uv: number[] = [], colors: number[] = [], indices: number[] = [];
  const steps = distant ? [0, .58, 1] : Array.from({ length: 7 }, (_, i) => i / 6);
  const radii = steps.map(t => .1 + .9 * t);
  const heights = steps.map(t => .38 - .82 * Math.sin(t * Math.PI / 2) + .3 * t ** 4);
  const widths = steps.map(t => .30 * Math.sin(t * Math.PI) ** .75 + .005);
  const columns = distant ? 2 : 3, leaves = distant ? 5 : 6;
  for (let leaf = 0; leaf < leaves; leaf++) {
    const a = leaf * Math.PI * 2 / leaves, c = Math.cos(a), s = Math.sin(a);
    const start = p.length / 3;
    for (let row = 0; row < radii.length; row++) for (let col = 0; col < columns; col++) {
      const side = col / (columns - 1) * 2 - 1, t = row / (radii.length - 1);
      p.push(c * radii[row] - s * widths[row] * side,
        heights[row] + (1 - Math.abs(side)) * .065 * Math.sin(t * Math.PI),
        s * radii[row] + c * widths[row] * side);
      uv.push(col / (columns - 1), t);
      const light = .49 + t * .40 + (1 - Math.abs(side)) * .06;
      colors.push(light * (.80 + t * .17), light, light * (1.06 - t * .17));
      if (row === radii.length - 1 || col === columns - 1) continue;
      const i = start + row * columns + col;
      indices.push(i, i + 1, i + columns, i + 1, i + columns + 1, i + columns);
    }
  }
  return geometry(p, uv, colors, indices);
}

function geometry(p: number[], uv: number[], colors: number[], indices: number[]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  g.setIndex(indices); g.computeVertexNormals(); g.computeBoundingSphere();
  return g;
}

/** Distant crowns retain several membranes/whorls and their open spaces,
 * instead of turning into an opaque ball or cone at the LOD boundary. */
export function nativeFoliageGeometry(whorls: boolean, distant = false): THREE.BufferGeometry {
  if (!distant) return whorls ? fronds(false) : canopy(32, 4);
  const source = whorls ? fronds(true) : canopy(8, 2);
  const p: number[] = [], uv: number[] = [], colors: number[] = [], indices: number[] = [];
  const forms = whorls
    ? [[0, -.25, 0, 1, .53, 0], [0, .03, 0, .71, .47, 1.1], [0, .30, 0, .40, .37, 2.2]]
    : [[0, .02, 0, .67, .68, 0], [.49, -.23, .15, .49, .57, .6], [-.48, -.15, -.10, .51, .56, 2]];
  const pos = source.getAttribute('position'), tint = source.getAttribute('color'), tex = source.getAttribute('uv');
  for (const [x, y, z, spread, rise, angle] of forms) {
    const start = p.length / 3, c = Math.cos(angle), s = Math.sin(angle);
    for (let i = 0; i < pos.count; i++) {
      p.push(x + (pos.getX(i) * c - pos.getZ(i) * s) * spread, y + pos.getY(i) * rise,
        z + (pos.getX(i) * s + pos.getZ(i) * c) * spread);
      uv.push(tex.getX(i), tex.getY(i)); colors.push(tint.getX(i), tint.getY(i), tint.getZ(i));
    }
    for (const index of source.index!.array) indices.push(start + index);
  }
  source.dispose();
  return geometry(p, uv, colors, indices);
}

/** Radial veins and mineral speckling, generated once in a 128px membrane.
 * All pixels are opaque: the actual mesh supplies the scalloped silhouette. */
export function nativeFoliageTexture(whorls: boolean): THREE.DataTexture {
  const size = 128, data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / (size - 1), v = y / (size - 1), i = (y * size + x) * 4;
    let hash = Math.imul(x + 19, 374761393) ^ Math.imul(y + 61, 668265263);
    hash = Math.imul(hash ^ (hash >>> 13), 1274126177);
    const grain = ((hash ^ (hash >>> 16)) >>> 0) / 4294967295;
    const phase = whorls ? (u - .5) * (12 + v * 9) + v * .7 : u * 24 + Math.sin(v * 9) * .09;
    const vein = Math.pow(Math.max(0, Math.cos(phase * Math.PI * 2)), 16);
    const crossVein = Math.pow(Math.max(0, Math.cos(v * 31 + Math.sin(u * 22) * .3)), 20);
    const shade = .76 + grain * .15 - vein * .23 - crossVein * .055;
    data[i] = Math.round(255 * shade);
    data[i + 1] = Math.round(255 * Math.min(1, shade * 1.06));
    data[i + 2] = Math.round(255 * shade * (.92 + v * .05));
    data[i + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, size, size);
  texture.wrapS = THREE.RepeatWrapping; texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true; texture.needsUpdate = true;
  return texture;
}

export const FOLIAGE_WIND_GLSL = `
  vec3 plantOrigin = instanceMatrix[3].xyz;
  float phase = plantOrigin.x * .17 + plantOrigin.z * .11;
  float flex = smoothstep(-.55, .65, position.y);
  float breeze = sin(uFoliageTime * 1.12 + phase) * .015 + sin(uFoliageTime * 2.05 + phase * 1.7) * .004;
  transformed.x += breeze * flex;
  transformed.z += breeze * flex * .55;
`;

export function foliageDepthMaterial(clock: { value: number }): THREE.MeshDepthMaterial {
  const material = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
  material.onBeforeCompile = shader => {
    shader.uniforms.uFoliageTime = clock;
    shader.vertexShader = 'uniform float uFoliageTime;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>\n${FOLIAGE_WIND_GLSL}`);
  };
  material.customProgramCacheKey = () => 'native-foliage-depth-v1';
  return material;
}
