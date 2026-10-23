import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solidBoxDistance } from '@shared/box-field';
import { sdBox } from '@shared/sdf';
import type { Box } from '@shared/worldgen';
import { mulberry32 } from '@shared/rng';

function compare(boxes: readonly Box[], x: number, y: number, z: number, best: number): void {
  const original = boxes.reduce((value, b) => Math.min(value, sdBox(x, y, z, b.x, b.y, b.z, b.hx, b.hy, b.hz)), best);
  assert.equal(solidBoxDistance(boxes, x, y, z, best), original);
}

test('small box unions preserve exact distances, signed limits and incoming ties', () => {
  const random = mulberry32(229);
  for (const count of [0, 1, 7, 8, 9, 16, 31, 32]) {
    const boxes = Array.from({ length: count }, () => ({ x: random() * 80, y: random() * 40,
      z: random() * 80, hx: .125 + random() * 12, hy: .125 + random() * 6, hz: .125 + random() * 12 }));
    for (let i = 0; i < 600; i++) {
      const x = random() * 100 - 10, y = random() * 60 - 10, z = random() * 100 - 10;
      for (const best of [-Infinity, -3, -.01, -0, 0, .01, 3, Infinity, NaN]) compare(boxes, x, y, z, best);
    }
    for (const b of boxes) {
      for (const [x, y, z] of [[b.x, b.y, b.z], [b.x + b.hx, b.y, b.z],
        [b.x + b.hx, b.y + b.hy, b.z + b.hz], [b.x - b.hx, b.y - b.hy, b.z]]) {
        const exact = boxes.reduce((value, p) => Math.min(value, sdBox(x, y, z, p.x, p.y, p.z, p.hx, p.hy, p.hz)), Infinity);
        for (const best of [-0, 0, exact]) compare(boxes, x, y, z, best);
      }
    }
  }
});

test('small thin-wall unions preserve boundary distances at large positive and negative coordinates', () => {
  for (const origin of [-1e8, -8192, 8192, 1e8]) {
    const boxes: Box[] = Array.from({ length: 20 }, (_, i) => ({ x: origin + i * 8.125,
      y: 117.031 + (i % 3) * 4.625, z: -origin + (i % 4) * 8.75, hx: .1273, hy: 5.018, hz: 8.00341 }));
    for (const b of boxes) for (const epsilon of [-1e-7, 0, 1e-7, .0135, .42]) {
      for (const best of [-Infinity, -4, -.01, -0, 0, .01, 4, Infinity]) {
        compare(boxes, b.x + b.hx + epsilon, b.y, b.z, best);
        compare(boxes, b.x + b.hx + epsilon, b.y + b.hy + epsilon, b.z + b.hz + epsilon, best);
      }
    }
  }
});

test('invalid query coordinates retain the original NaN propagation even when another axis can prune', () => {
  for (const count of [1, 8, 9, 31]) {
    const boxes = Array.from({ length: count }, (_, i) => ({ x: i * 3, y: 0, z: 0, hx: 1, hy: 1, hz: 1 }));
    for (const [x, y, z] of [[NaN, 100, 100], [100, NaN, 100], [100, 100, NaN]]) {
      for (const best of [-Infinity, -0, 0, 1, Infinity, NaN]) {
        compare(boxes, x, y, z, best);
        compare([], x, y, z, best);
      }
    }
  }
});

test('small compound indexes rebuild when the provider replaces or resizes its geometry array', () => {
  const boxes: Box[] = Array.from({ length: 8 }, (_, i) => ({ x: i * 5, y: 0, z: 0, hx: 1, hy: 1, hz: 1 }));
  compare(boxes, 50, 0, 0, Infinity);
  boxes.push({ x: 50, y: 0, z: 0, hx: 2, hy: 2, hz: 2 });
  compare(boxes, 50, 0, 0, Infinity);
  boxes.pop();
  compare(boxes, 50, 0, 0, Infinity);
  const replacement = boxes.map(b => ({ ...b, x: b.x + 100 }));
  for (const x of [0, 35, 50, 100, 135]) {
    compare(boxes, x, 0, 0, Infinity);
    compare(replacement, x, 0, 0, Infinity);
  }
});
