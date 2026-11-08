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
export const VEHICLE_VARIANT = { COMMON: 0, NOCTURNE: 1, BASTION: 2, RAIL: 3, DESTROYER: 4, CONDOR: 5 } as const;
export function validVehicleVariant(type: number, variant = 0): number {
  return type === VEHICLE.JET && (variant === VEHICLE_VARIANT.NOCTURNE || variant === VEHICLE_VARIANT.CONDOR) ? variant
    : type === VEHICLE.TANK && (variant === VEHICLE_VARIANT.BASTION || variant === VEHICLE_VARIANT.RAIL) ? variant
    : type === VEHICLE.GUNBOAT && variant === VEHICLE_VARIANT.DESTROYER ? variant : 0;
}

export const NOCTURNE_SCALE = 2.2;
/** The Condor heavy bomber's attachments scale from the fighter's. */
export const CONDOR_SCALE = 2.3;
/** How much larger than a fighter an aircraft's crew and weapon attachments sit. */
export function jetScale(variant = 0): number {
  return variant === VEHICLE_VARIANT.NOCTURNE ? NOCTURNE_SCALE : variant === VEHICLE_VARIANT.CONDOR ? CONDOR_SCALE : 1;
}
