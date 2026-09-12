import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RenderQuality, basePixelRatio } from '../src/render/render-quality.js';

function run(q: RenderQuality, seconds: number, fps: number): void {
  for (let i = 0; i < seconds * fps; i++) q.update(1 / fps);
}

test('resolution handles sustained load and recovers with hysteresis', () => {
  const quality = new RenderQuality();
  run(quality, 3, 60);
  run(quality, 1, 30);
  assert.equal(quality.scale, 1, 'brief streaming work keeps full resolution');
  run(quality, 8, 30);
  assert.ok(quality.scale < 1);
  const low = quality.scale;
  run(quality, 4, 60);
  assert.equal(quality.scale, low, 'recovery waits for sustained headroom');
  run(quality, 90, 60);
  assert.equal(quality.scale, 1);
  run(quality, 90, 20);
  assert.equal(quality.scale, 0.65);
});

test('hidden tabs and large pauses do not lower resolution', () => {
  const quality = new RenderQuality();
  for (let i = 0; i < 100; i++) {
    quality.update(1);
    quality.update(0.05, false);
    quality.update(NaN);
  }
  assert.equal(quality.scale, 1);
});

test('pixel budget limits large and high density browser windows', () => {
  assert.equal(basePixelRatio(1280, 720, 1), 1);
  assert.equal(basePixelRatio(1280, 720, 3), 1.5);
  const ratio = basePixelRatio(3840, 2160, 2);
  assert.ok(3840 * 2160 * ratio * ratio <= 2_500_001);
  const wideRatio = basePixelRatio(7680, 4320, 2);
  assert.ok(7680 * 4320 * wideRatio * wideRatio <= 2_500_001);
});

test('sustained very slow visible frames can still lower resolution', () => {
  const quality = new RenderQuality();
  run(quality, 90, 3);
  assert.equal(quality.scale, 0.65);
});

test('touch devices bound fill rate independently of high density phone screens', () => {
  for (const [width, height] of [[844,390], [390,844], [1366,1024]]) {
    const ratio = basePixelRatio(width,height,3,true);
    assert.ok(ratio <= 1.25);
    assert.ok(width * height * ratio * ratio <= 1_000_001);
  }
});
