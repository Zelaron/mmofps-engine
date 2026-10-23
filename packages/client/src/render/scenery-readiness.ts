/** Installed terrain only: this interface must never generate world samples. */
export interface SceneryTerrain {
  readonly sceneryCoverageRevision: number;
  /** Optional scheduling hint only, based on fresh supplied ground motion. */
  scenerySupportFutureCells?(): readonly { cellX: number; cellZ: number }[];
  readonly scenerySupportRevision?: number;
  sceneryGroundReady(x: number, z: number, hx: number, hz: number): boolean;
}

/** Nearby collision silhouettes stay visible even while their terrain loads. */
export const SCENERY_PROTECTED_DISTANCE = 128;

export function sceneryPlacementReady(terrain: SceneryTerrain | undefined,
  x: number, z: number, hx: number, hz: number, cellX: number, cellZ: number, cellSize: number): boolean {
  if (!terrain) return true;
  // Protect the whole camera cell, not only its last sampled point. Renderers
  // rebuild on cell transitions; motion inside that cell must never approach
  // an invisible collider within 128 m of its full horizontal footprint.
  const dx = Math.max(cellX * cellSize - x - hx, x - hx - (cellX + 1) * cellSize, 0);
  const dz = Math.max(cellZ * cellSize - z - hz, z - hz - (cellZ + 1) * cellSize, 0);
  return dx * dx + dz * dz <= SCENERY_PROTECTED_DISTANCE ** 2 ||
    terrain.sceneryGroundReady(x, z, hx, hz);
}
