/** Bound particle creation as well as the live particle buffer when several
 * network detonations arrive in one frame. Nuclear clouds use no solid meshes. */
export const NUCLEAR_PARTICLE_CAP = 18000;
export class NuclearBurstBudget {
  private emitted = 0;
  take(): boolean {
    if (this.emitted >= 3) return false;
    this.emitted++;
    return true;
  }
  nextFrame(): void { this.emitted = 0; }
}
