import { hash2i, hash3i, unit } from './rng.js';

// Value noise + fBm. Deliberately built from floor/lerp/integer hashing only:
// no Math.sin/cos/pow, so results are bit-identical on server and client and
// the terrain the client renders is exactly the terrain the server collides.

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

// Fixed rotation applied between octaves to hide lattice artifacts.
const ROT_C = 0.87758256; // cos(0.5)
const ROT_S = 0.47942554; // sin(0.5)

export class Noise {
  constructor(private readonly seed: number) {}

  /** Value noise in [0, 1]. */
  value2(x: number, y: number, oseed = 0): number {
    const s = this.seed + oseed;
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = fade(x - xi);
    const fy = fade(y - yi);
    const a = unit(hash2i(s, xi, yi));
    const b = unit(hash2i(s, xi + 1, yi));
    const c = unit(hash2i(s, xi, yi + 1));
    const d = unit(hash2i(s, xi + 1, yi + 1));
    const ab = a + (b - a) * fx;
    const cd = c + (d - c) * fx;
    return ab + (cd - ab) * fy;
  }

  /** Value noise in [0, 1]. */
  value3(x: number, y: number, z: number, oseed = 0): number {
    const s = this.seed + oseed;
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const zi = Math.floor(z);
    const fx = fade(x - xi);
    const fy = fade(y - yi);
    const fz = fade(z - zi);
    const c000 = unit(hash3i(s, xi, yi, zi));
    const c100 = unit(hash3i(s, xi + 1, yi, zi));
    const c010 = unit(hash3i(s, xi, yi + 1, zi));
    const c110 = unit(hash3i(s, xi + 1, yi + 1, zi));
    const c001 = unit(hash3i(s, xi, yi, zi + 1));
    const c101 = unit(hash3i(s, xi + 1, yi, zi + 1));
    const c011 = unit(hash3i(s, xi, yi + 1, zi + 1));
    const c111 = unit(hash3i(s, xi + 1, yi + 1, zi + 1));
    const x00 = c000 + (c100 - c000) * fx;
    const x10 = c010 + (c110 - c010) * fx;
    const x01 = c001 + (c101 - c001) * fx;
    const x11 = c011 + (c111 - c011) * fx;
    const y0 = x00 + (x10 - x00) * fy;
    const y1 = x01 + (x11 - x01) * fy;
    return y0 + (y1 - y0) * fz;
  }

  /** Fractal noise in [-1, 1]. */
  fbm2(x: number, y: number, octaves: number, lacunarity = 2, gain = 0.5): number {
    let sum = 0;
    let amp = 1;
    let ampSum = 0;
    for (let o = 0; o < octaves; o++) {
      sum += ((this.value2(x, y, o * 101) - 0.5) * 2) * amp;
      ampSum += amp;
      amp *= gain;
      const nx = x * ROT_C - y * ROT_S;
      const ny = x * ROT_S + y * ROT_C;
      x = nx * lacunarity + 31.7;
      y = ny * lacunarity - 17.3;
    }
    return sum / ampSum;
  }

  /** Fractal noise in [-1, 1]. */
  fbm3(x: number, y: number, z: number, octaves: number, lacunarity = 2, gain = 0.5): number {
    let sum = 0;
    let amp = 1;
    let ampSum = 0;
    for (let o = 0; o < octaves; o++) {
      sum += ((this.value3(x, y, z, o * 101) - 0.5) * 2) * amp;
      ampSum += amp;
      amp *= gain;
      const nx = x * ROT_C - z * ROT_S;
      const nz = x * ROT_S + z * ROT_C;
      x = nx * lacunarity + 31.7;
      y = y * lacunarity + 11.9;
      z = nz * lacunarity - 17.3;
    }
    return sum / ampSum;
  }

  /** Ridged fractal noise in [0, 1] - sharp mountain crests. */
  ridge2(x: number, y: number, octaves: number, lacunarity = 2, gain = 0.5): number {
    let sum = 0;
    let amp = 0.5;
    let ampSum = 0;
    for (let o = 0; o < octaves; o++) {
      const n = (this.value2(x, y, 7000 + o * 131) - 0.5) * 2;
      const r = 1 - Math.abs(n);
      sum += r * r * amp;
      ampSum += amp;
      amp *= gain;
      const nx = x * ROT_C - y * ROT_S;
      const ny = x * ROT_S + y * ROT_C;
      x = nx * lacunarity + 13.1;
      y = ny * lacunarity + 41.7;
    }
    return sum / ampSum;
  }
}
