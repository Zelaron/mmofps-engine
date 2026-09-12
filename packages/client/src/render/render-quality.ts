import { renderProfile } from './device-profile.js';

/** Resolution changes only after sustained pressure; brief streaming stalls
 * and hidden-tab pauses must not leave the game permanently blurry. */
export class RenderQuality {
  scale = 1;
  private slowSeconds = 0;
  private fastSeconds = 0;
  private warmup = 3;
  private longFrames = 0;

  update(frameSeconds: number, active = true): boolean {
    if (!active || !Number.isFinite(frameSeconds) || frameSeconds <= 0) {
      this.slowSeconds = this.fastSeconds = 0;
      this.longFrames = 0;
      return false;
    }
    if (frameSeconds > 0.25) {
      // Ignore individual pauses, but still help a device consistently
      // running below 4fps. Bound its contribution to avoid sudden jumps.
      if (++this.longFrames < 3) {
        this.slowSeconds = this.fastSeconds = 0;
        return false;
      }
      frameSeconds = 0.25;
    } else this.longFrames = 0;
    if (this.warmup > 0) {
      this.warmup -= frameSeconds;
      return false;
    }
    // A comfortable 60fps leaves room to recover quality. A slow display
    // (e.g. 30Hz) reaches the lower bound once, without oscillating.
    this.slowSeconds = frameSeconds > 1 / 43
      ? this.slowSeconds + frameSeconds : Math.max(0, this.slowSeconds - frameSeconds * 2);
    this.fastSeconds = frameSeconds < 1 / 57
      ? this.fastSeconds + frameSeconds : 0;
    const previous = this.scale;
    if (this.slowSeconds > 2.5) {
      this.scale = Math.max(0.65, Math.round((this.scale - 0.1) * 100) / 100);
      this.slowSeconds = this.fastSeconds = 0;
      this.warmup = 2;
    } else if (this.fastSeconds > 8) {
      this.scale = Math.min(1, Math.round((this.scale + 0.05) * 100) / 100);
      this.slowSeconds = this.fastSeconds = 0;
      this.warmup = 2;
    }
    return previous !== this.scale;
  }
}

/** Bound fill rate on Retina/4K displays as well as low-resolution screens. */
export function basePixelRatio(width: number, height: number, deviceRatio: number, touch?: boolean): number {
  const pixels = Math.max(1, width) * Math.max(1, height);
  const profile = renderProfile(touch);
  return Math.min(Math.max(0.5, Number.isFinite(deviceRatio) ? deviceRatio : 1), profile.maxPixelRatio,
    Math.sqrt(profile.pixelBudget / pixels));
}
