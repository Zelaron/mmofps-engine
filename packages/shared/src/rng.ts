// Deterministic hashing / RNG built only on 32-bit integer ops (Math.imul,
// xor, shifts). These are bit-exact across every JS engine, which is what
// makes the world generation identical on server and every client.

export function hash2i(seed: number, x: number, y: number): number {
  let h = (seed | 0) ^ Math.imul(x | 0, 0x8da6b343) ^ Math.imul(y | 0, 0xd8163841);
  h = Math.imul(h ^ (h >>> 13), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 16), 0xc2b2ae35);
  return (h ^ (h >>> 15)) >>> 0;
}

export function hash3i(seed: number, x: number, y: number, z: number): number {
  let h =
    (seed | 0) ^
    Math.imul(x | 0, 0x8da6b343) ^
    Math.imul(y | 0, 0xd8163841) ^
    Math.imul(z | 0, 0xcb1ab31f);
  h = Math.imul(h ^ (h >>> 13), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 16), 0xc2b2ae35);
  return (h ^ (h >>> 15)) >>> 0;
}

/** Map a 32-bit hash to [0, 1). */
export function unit(h: number): number {
  return (h >>> 0) / 4294967296;
}

/** Small fast seeded PRNG (mulberry32) for non-worldgen randomness. */
export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
