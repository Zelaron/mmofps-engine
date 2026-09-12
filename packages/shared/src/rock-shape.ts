/** Fractured boulder profile shared by terrain meshing and collision. */
export interface RockBounds {
  x: number; y: number; z: number;
  hx: number; hy: number; hz: number;
}

export type RockPlane = readonly [number, number, number, number];
function plane(x: number, y: number, z: number, d: number): RockPlane {
  const inverse = 1 / Math.hypot(x, y, z);
  return [x * inverse, y * inverse, z * inverse, d * inverse];
}

// Shared analytic fracture planes also construct the instanced render meshes.
// Keeping the definitions here prevents art refinements from leaving invisible
// collision corners or duplicated approximate silhouettes in the renderer.
export const ROCK_GRANITE_PLANES: readonly RockPlane[] = [
  plane(0.18, 1, -0.17, 0.99), plane(0.76, 0.33, 0.59, 0.91),
  plane(-0.64, 0.37, 0.72, 0.95), plane(-0.78, 0.31, -0.53, 0.94),
  plane(0.59, 0.29, -0.75, 0.94),
];
export const ROCK_TALUS_LEFT: readonly RockPlane[] = [
  plane(1, 0.70, 0, 0.31), plane(-1, 0.12, 0, 0.72), plane(0, 1, -0.33, 0.84),
  plane(0.32, 1, 0.45, 0.58), plane(-0.45, 1, 0.18, 0.94),
  plane(-0.72, 0.20, -0.60, 0.83), plane(-0.62, 0.28, 0.65, 0.81),
];
export const ROCK_TALUS_RIGHT: readonly RockPlane[] = [
  plane(-1, 0.80, 0, 0.36), plane(1, 0.16, 0, 0.75), plane(0, 1, 0.40, 0.72),
  plane(-0.26, 1, -0.34, 0.85), plane(0.53, 0.23, 0.61, 0.72),
  plane(0.71, 0.35, -0.40, 0.78),
];
export const ROCK_TALUS_SHARED: readonly RockPlane[] = [-1, 1].flatMap((sx) =>
  [-1, 1].flatMap((sz) => [plane(0.25 * sx, 0.20, sz, 0.92), plane(0.85 * sx, 0.10, 0.50 * sz, 0.98)]));

function fractures(x: number, y: number, z: number, planes: readonly RockPlane[]): number {
  let result = -Infinity;
  for (const p of planes) result = Math.max(result, x * p[0] + y * p[1] + z * p[2] - p[3]);
  return result;
}

/**
 * A rounded geological core intersected by oblique fracture planes. The
 * asymmetric shoulders and sloping cap produce granite/slate silhouettes,
 * while the flat underside rests at -1 and never exceeds the supplied box.
 * This conservative field has a gradient no greater than one: it is safe
 * for the same sphere traces used by weapons and player collision.
 */
export function rockProfile(x: number, y: number, z: number, variation = 0.5): number {
  const family = Math.min(3, Math.floor(variation * 4));
  const bounds = Math.max(Math.abs(x) - 1, Math.abs(y) - 1, Math.abs(z) - 1);
  if (family === 1) {
    // Broad tilted slate: a cleaved cap and angular laminated shoulders.
    return Math.max(bounds,
      (y + x * 0.46 - z * 0.12 - 0.36) / 1.11,
      (Math.abs(x) * 0.88 + Math.abs(z) * 0.47 + y * 0.09 - 0.91) / 1.01,
      (-x * 0.72 + z * 0.62 + y * 0.26 - 0.94) / 1.01);
  }
  if (family === 2) {
    // Jointed basalt: a tall hexagonal block with a broken angled crown.
    return Math.max(bounds,
      (Math.abs(x) * 0.92 + Math.abs(z) * 0.38 + y * 0.12 - 0.86) / 1.02,
      (Math.abs(z) * 0.92 + Math.abs(x) * 0.38 - y * 0.08 - 0.86) / 1.02,
      (y + x * 0.12 - z * 0.25 - 0.83) / 1.04);
  }
  if (family === 3) {
    // Two unequal shattered crowns rise from one broad base, separated by a
    // pronounced cleft; small chips break up the slab-like side faces.
    return Math.max(bounds, Math.min(fractures(x, y, z, ROCK_TALUS_LEFT),
      fractures(x, y, z, ROCK_TALUS_RIGHT)), fractures(x, y, z, ROCK_TALUS_SHARED));
  }
  const lean = (variation - 0.5) * 0.24;
  const u = x + y * lean + z * 0.11;
  const v = z - x * 0.13 + y * 0.04;
  const rounded = Math.sqrt(u * u * 1.15 + (y + 0.10) ** 2 * 0.90 + v * v * 1.32) - 1.04;
  return Math.max(
    rounded / 1.40, bounds, fractures(x, y, z, ROCK_GRANITE_PLANES),
  );
}

export function sdBoulder(x: number, y: number, z: number, rock: RockBounds): number {
  // Existing dimension randomness varies the fracture attitude without new
  // replicated fields, allocations, trigonometry, or a noise lookup per sample.
  const variation = (rock.hx * 13.57 + rock.hz * 7.11) % 1;
  return rockProfile(
    (x - rock.x) / rock.hx,
    (y - rock.y) / rock.hy,
    (z - rock.z) / rock.hz,
    variation,
  ) * Math.min(rock.hx, rock.hy, rock.hz);
}
