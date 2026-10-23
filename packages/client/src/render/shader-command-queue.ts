const MAX_QUEUE_WAIT_MS = 10_000;

/** Yield while previously submitted GL commands drain. This is a scheduling
 * aid, not a portable proof of shader readiness: ordinary first-use shader
 * validation must still run. Call poll from separate animation frames. */
export class ShaderCommandQueue {
  private programs = new Set<WebGLProgram>();
  private fence: WebGLSync | null = null;
  private submittedAt = 0;
  private fallbacks = 0;

  constructor(private readonly gl: WebGL2RenderingContext,
    private readonly now: () => number = () => performance.now()) {}

  /** Cumulative across world changes and resets; context loss is not failure. */
  get fallbackCount(): number { return this.fallbacks; }

  /** Release a live-context fence; lost-context handles are only discarded. */
  reset(): void {
    this.clearFence();
    this.programs.clear();
  }

  poll(programs: Iterable<WebGLProgram>): boolean {
    if (this.gl.isContextLost()) return this.lost();
    const current = new Set(programs);
    let added = false;
    for (const program of current) if (!this.programs.has(program)) { added = true; break; }
    // Do not retain programs that the renderer has already released.
    this.programs = current;
    if (!current.size) { this.clearFence(); return true; }
    if (added) {
      this.clearFence();
      this.submittedAt = this.now();
      this.fence = this.gl.fenceSync(this.gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      if (!this.fence) return this.fallback();
      this.gl.flush();
      return false;
    }
    if (!this.fence) return true;
    const status = this.gl.clientWaitSync(this.fence, 0, 0);
    if (this.gl.isContextLost()) return this.lost();
    if (status === this.gl.ALREADY_SIGNALED || status === this.gl.CONDITION_SATISFIED) {
      this.clearFence();
      return true;
    }
    if (status === this.gl.TIMEOUT_EXPIRED && this.now() - this.submittedAt < MAX_QUEUE_WAIT_MS)
      return false;
    return this.fallback();
  }

  private fallback(): false {
    // A failed GL call may itself reveal context loss. Never classify that as
    // completion or retry an invalid handle after restoration.
    if (this.gl.isContextLost()) return this.lost();
    this.clearFence();
    this.fallbacks++;
    // Keep this batch's handles covered. Yield once on failure, then let the
    // next unchanged poll proceed to ordinary first-use checks without a loop.
    return false;
  }

  private lost(): false {
    this.clearFence(false);
    this.programs.clear();
    return false;
  }

  private clearFence(deleteIfLive = true): void {
    const fence = this.fence;
    this.fence = null;
    this.submittedAt = 0;
    if (fence && deleteIfLive && !this.gl.isContextLost()) this.gl.deleteSync(fence);
  }
}
