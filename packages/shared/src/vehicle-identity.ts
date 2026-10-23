// Collision geometry needs these values during module initialization. Keep
// them independent of movement, physics and World so every ESM entry order
// initializes hull dimensions before canonical provider registration.
export const VEHICLE = {
  NONE: 0,
  JEEP: 1,
  TANK: 2,
  JET: 3,
  GUNBOAT: 4,
} as const;

/** Rare city hulls retain their base controls and collision/prediction dispatch. */
export const VEHICLE_VARIANT = { COMMON: 0, NOCTURNE: 1, BASTION: 2, RAIL: 3 } as const;
export function validVehicleVariant(type: number, variant = 0): number {
  return type === VEHICLE.JET && variant === VEHICLE_VARIANT.NOCTURNE ? variant
    : type === VEHICLE.TANK && (variant === VEHICLE_VARIANT.BASTION || variant === VEHICLE_VARIANT.RAIL) ? variant : 0;
}

export const NOCTURNE_SCALE = 2.2;
