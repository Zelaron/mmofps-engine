import * as THREE from 'three';

/** Screen-space surface gradients preserve world-space relief without UV
 * seams, per-vertex tangents, displaced collision or another rendering pass. */
export const SURFACE_GRADIENT_GLSL = `
  vec3 detailNormal(vec3 viewPosition, vec3 surfaceNormal, float height) {
    vec3 dx = dFdx(viewPosition), dy = dFdy(viewPosition);
    vec3 rx = cross(dy, surfaceNormal), ry = cross(surfaceNormal, dx);
    float determinant = dot(dx, rx);
    vec3 gradient = sign(determinant) * (dFdx(height) * rx + dFdy(height) * ry);
    return normalize(max(abs(determinant), 0.00000001) * surfaceNormal - gradient);
  }
`;

function hash(x: number, y: number, seed: number): number {
  let n = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ seed;
  n = Math.imul(n ^ n >>> 13, 1274126177);
  return ((n ^ n >>> 16) >>> 0) / 4294967295;
}
function noise(x: number, y: number, period: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  // Every octave has a power-of-two period. Masking preserves the exact
  // periodic samples without allocating a closure at each of 450k samples.
  const mask = period - 1, x0 = ix & mask, x1 = (ix + 1) & mask, y0 = iy & mask, y1 = (iy + 1) & mask;
  return (hash(x0, y0, seed) * (1 - u) + hash(x1, y0, seed) * u) * (1 - v) +
    (hash(x0, y1, seed) * (1 - u) + hash(x1, y1, seed) * u) * v;
}

let cloudPixels: Uint8Array<ArrayBuffer> | undefined;

/** A few hundred KiB generated at startup, rather than a downloaded skybox.
 * Separate coverage, thickness and erosion channels need only two GPU reads. */
export function createCloudNoise(): THREE.DataTexture {
  const size = 256, bytes = cloudPixels ?? new Uint8Array(size * size * 4);
  if (!cloudPixels) for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size, i = (y * size + x) * 4;
    let density = 0, weight = .55, total = 0;
    for (let octave = 0; octave < 5; octave++) {
      const frequency = 4 * 2 ** octave;
      density += noise(u * frequency, v * frequency, frequency, 381 + octave * 17) * weight;
      total += weight; weight *= .52;
    }
    bytes[i] = Math.round(density / total * 255);
    bytes[i + 1] = Math.round(noise(u * 8, v * 8, 8, 719) * 255);
    bytes[i + 2] = Math.round(noise(u * 64, v * 64, 64, 191) * 255);
    bytes[i + 3] = 255;
  }
  // The visible dome and the reflection bake own separate GPU textures but
  // share immutable CPU pixels; disposal of the bake cannot invalidate the sky.
  cloudPixels = bytes;
  const texture = new THREE.DataTexture(bytes, size, size);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true; texture.needsUpdate = true;
  return texture;
}
