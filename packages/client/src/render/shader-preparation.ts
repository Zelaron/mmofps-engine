/** Submit shader work together and poll its completion between frames.
 * Scene updates can introduce variants while the GPU is compiling. Verify
 * the current scene again before allowing its first draw. */
export class ShaderPreparation {
  private revision = 0;
  private submitted = -1;
  private prepared = -1;

  constructor(private readonly compile: () => void, private readonly complete: () => boolean) {}

  invalidate(): void { this.revision++; }
  get pending(): boolean { return this.prepared !== this.revision; }

  poll(): boolean {
    if (!this.pending) return true;
    const revision = this.revision, submittedNow = this.submitted !== revision;
    if (submittedNow) { this.compile(); this.submitted = revision; }
    if (!this.complete()) return false;
    // A previous frame submitted the batch. Catch geometry/material variants
    // that appeared since then before declaring the whole scene drawable.
    if (!submittedNow) { this.compile(); if (!this.complete()) return false; }
    if (revision !== this.revision) return false;
    this.prepared = revision;
    return true;
  }
}
