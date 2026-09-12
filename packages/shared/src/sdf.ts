// Signed-distance primitives. Convention: d > 0 is air, d < 0 is solid.

/** Axis-aligned box centered at (cx,cy,cz) with half-extents (hx,hy,hz). */
export function sdBox(
  px: number, py: number, pz: number,
  cx: number, cy: number, cz: number,
  hx: number, hy: number, hz: number,
): number {
  const dx = Math.abs(px - cx) - hx;
  const dy = Math.abs(py - cy) - hy;
  const dz = Math.abs(pz - cz) - hz;
  const ox = dx > 0 ? dx : 0;
  const oy = dy > 0 ? dy : 0;
  const oz = dz > 0 ? dz : 0;
  const outside = Math.sqrt(ox * ox + oy * oy + oz * oz);
  const inside = Math.min(Math.max(dx, Math.max(dy, dz)), 0);
  return outside + inside;
}

export function sdRoundedBox(
  px: number, py: number, pz: number,
  cx: number, cy: number, cz: number,
  hx: number, hy: number, hz: number,
  r: number,
): number {
  return sdBox(px, py, pz, cx, cy, cz, hx - r, hy - r, hz - r) - r;
}

/** Finite vertical cylinder centered at (cx,cy,cz). */
export function sdCylinderY(
  px: number, py: number, pz: number,
  cx: number, cy: number, cz: number,
  radius: number, halfHeight: number,
): number {
  const radial = Math.hypot(px - cx, pz - cz) - radius;
  const vertical = Math.abs(py - cy) - halfHeight;
  const outsideRadial = Math.max(radial, 0);
  const outsideVertical = Math.max(vertical, 0);
  return Math.hypot(outsideRadial, outsideVertical) +
    Math.min(Math.max(radial, vertical), 0);
}

/** Polynomial smooth union - used to blend bunker pads into the terrain. */
export function smin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}
