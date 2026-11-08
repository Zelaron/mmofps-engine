// Central tunables for the whole game. The server is the authority for all of
// them; the client mirrors them through the shared simulation code.

export const PROTOCOL_VERSION = 34;

export const TICK_RATE = 60;
export const TICK_DT = 1 / TICK_RATE;
/** A snapshot is broadcast every N ticks (2 -> 30 snapshots/sec). */
export const SNAPSHOT_EVERY = 2;

export const DEFAULT_SEED = 1337;

export const PLAYER = {
  RADIUS: 0.42,
  HEIGHT: 1.8,
  EYE_HEIGHT: 1.62,

  RUN_SPEED: 9.5,
  ACCEL: 90,
  FRICTION: 10,
  AIR_ACCEL: 26,
  JUMP_SPEED: 8.6,
  GRAVITY: 24,
  MAX_SPEED: 70,

  DODGE_SPEED: 14,
  DODGE_UP: 4.2,
  DODGE_COOLDOWN: 1.1,

  /** Downhill ground snap distance, keeps running on slopes smooth. */
  GROUND_SNAP: 0.45,
  /** Impacts faster than this (m/s, vertical) start dealing fall damage. */
  FALL_DMG_MIN: 15,
  FALL_DMG_SCALE: 3.2,

  MAX_HEALTH: 100,
  /** Damage must be avoided this long before the very slow recovery begins. */
  REGEN_DELAY: 15,
  /** Passive recovery is deliberately only a fallback to health pickups. */
  REGEN_RATE: 1.2,
  RESPAWN_SECONDS: 10,
} as const;

export const WORLD = {
  /** Last-resort boundary lies offshore beyond the island's visible coast. */
  BORDER: 11264,
  /** Absolute last resort: anything below this is killed/respawned. */
  KILL_Y: -80,
  /** Terrain never exceeds this height; sky above is guaranteed empty. */
  MAX_HEIGHT: 280, // Terrain ceiling; analytic capital architecture extends above it.
  /** Caves never go below this. */
  MIN_CAVE_Y: -46,
  /** Players spawn within this radius of the origin so they can find a fight. */
  SPAWN_RADIUS: 320,
} as const;

export const NET = {
  /**
   * Covers the grenade's maximum practical endpoint displacement (~709m)
   * across the declared world-height span (MAX_HEIGHT 280 down to the cave
   * floor), with room for interpolation.
   */
  INTEREST_RADIUS: 780,
  MAX_SNAPSHOT_ENTITIES: 64,
  /** Covers the maximum practical horizontal artillery envelope (~628m). */
  FIRE_EVENT_RADIUS: 700,
  /** Max lag-compensation rewind (ticks) the server will honor. */
  MAX_REWIND_TICKS: 60,
  LAG_HISTORY_TICKS: 64,
  MAX_NAME_LEN: 20,
  /** Remote entities are rendered this many ticks in the past. */
  INTERP_TICKS: 6,
} as const;

/** Voxel/meshing chunk edge in meters (1 voxel = 1 m). */
export const CHUNK_SIZE = 32;
/** Radius, in chunks, of full-detail terrain kept meshed around the camera. */
export const VIEW_CHUNK_RADIUS = 7;
/** Above ground, nearby columns include full galleries and sealed cave layers. */
export const CAVE_DETAIL_RADIUS = 4;
/** Underground fog is fully opaque before the bounded coarse cave mesh ends. */
export const CAVE_FOG_NEAR = 160;
export const CAVE_FOG_FAR = 480;
/** Dark distant cave horizon; stencil openings preserve real sky through mouths. */
export const CAVE_HORIZON_RADIUS = 520;
/** Step-4 canonical cave geometry extends beyond the opaque horizon. */
export const CAVE_MESH_RADIUS = 600;

// Far-terrain LOD rings: coarser voxels with distance so the whole world
// reads on the horizon with no holes. Coarse meshes remain resident and are
// clipped/masked per finer footprint as finer rings stream in.
/** LOD1 voxel size in meters (one LOD1 tile covers CHUNK_SIZE * this). */
export const LOD1_STEP = 4;
/**
 * LOD1 terrain extends to roughly this many meters from the camera. Its
 * exact 32m subparts replace LOD2 leaves progressively without whole-tile
 * overlap or retirement races.
 */
export const LOD1_RADIUS = 768;
/** LOD2 voxel size in meters. LOD2 tiles cover the entire world out to the
 * border, so distant terrain always renders (no holes on the horizon). */
export const LOD2_STEP = 16;
