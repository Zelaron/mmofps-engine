/** Touch capability is also opt-in for desktop/mobile browser testing. */
export function isTouchDevice(): boolean {
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('touch') === '1') return true;
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}

export function renderProfile(touch = isTouchDevice()) {
  return touch
    ? { touch: true, nearChunks: 5, farRadius: 2800, fogFar: 2500, workers: 2, pixelBudget: 1_000_000, maxPixelRatio: 1.25 }
    : { touch: false, nearChunks: 7, farRadius: 4800, fogFar: 4600, workers: 4, pixelBudget: 2_500_000, maxPixelRatio: 1.5 };
}
