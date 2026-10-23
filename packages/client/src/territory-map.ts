import { FACTIONS, type Territory } from '@shared/frontier';

/** Ownership stays visible at the center; this describes the separate live
 * capture ring. A paused contest must never look like a secure point. */
export function controlActivity(site: Territory) {
  const rate = site.progressRate ?? site.captureRate ?? 0;
  const progress = Math.max(0, Math.min(1, site.captureProgress ?? Math.abs(site.influence)));
  const claimant=site.captureFaction??site.owner;
  const reducing=site.pressureFaction ? !!claimant&&claimant!==site.pressureFaction
    : site.progressRate!==undefined ? site.progressRate<0 : site.influence*(site.captureRate??0)<0;
  const faction = site.pressureFaction || site.captureFaction || site.owner;
  const kind = site.contested ? 'contested' : rate ? reducing ? 'attacked' : 'capturing' : 'quiet';
  const restoring = kind === 'capturing' && site.owner !== 0 && faction === site.owner;
  const amount = reducing ? 1 - progress : progress;
  const label = kind === 'contested' ? 'CONTESTED' : kind === 'attacked' ? `UNDER ATTACK ${Math.round(amount * 100)}%`
    : restoring ? `RESTORING CONTROL ${Math.round(amount * 100)}%`
    : kind === 'capturing' ? `CAPTURING ${Math.round(amount * 100)}%` : site.owner ? 'HELD' : 'UNCLAIMED';
  return { kind, active: kind !== 'quiet', progress: amount, faction, label, restoring,
    color: kind === 'contested' ? '#ffd78c' : FACTIONS[faction].color };
}

interface MapVertex { x: number; y: number }
export interface TerritoryRegion { id: string; polygon: MapVertex[] }
export interface TerritoryBorder { a: MapVertex; b: MapVertex; owners: readonly [number, number] }

/** Shared Voronoi edges between hostile owners, once each. Outer map edges and
 * boundaries inside one faction are not battle fronts. Quantization only
 * matches independently clipped endpoints; rendering keeps exact geometry. */
export function territoryBorders(regions: readonly TerritoryRegion[], owners: ReadonlyMap<string, number>): TerritoryBorder[] {
  const edges = new Map<string, { a: MapVertex; b: MapVertex; owner: number }>(), borders: TerritoryBorder[] = [];
  const key = (p: MapVertex) => `${Math.round(p.x * 1e5)},${Math.round(p.y * 1e5)}`;
  for (const region of regions) {
    const owner = owners.get(region.id) ?? 0;
    for (let i = 0; i < region.polygon.length; i++) {
      const a = region.polygon[i], b = region.polygon[(i + 1) % region.polygon.length];
      const ka = key(a), kb = key(b); if (ka === kb) continue;
      const edgeKey = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`, prior = edges.get(edgeKey);
      if (!prior) edges.set(edgeKey, { a, b, owner });
      else if (owner && prior.owner && owner !== prior.owner) borders.push({ a, b, owners: [prior.owner, owner] });
    }
  }
  return borders;
}

/** Half-plane clipping keeps every control region inside this world's map.
 * Only live control positions matter; terrain and creature types do not. */
export function territoryRegions(points: readonly (MapVertex & { id: string })[], size = 600): TerritoryRegion[] {
  return points.map((point, index) => {
    let polygon = [{ x: 0, y: 0 }, { x: size, y: 0 }, { x: size, y: size }, { x: 0, y: size }];
    for (const [otherIndex, other] of points.entries()) {
      if (otherIndex === index || !polygon.length) continue;
      const dx = other.x - point.x, dy = other.y - point.y;
      if (Math.abs(dx) + Math.abs(dy) < 1e-8) { if (otherIndex < index) polygon = []; continue; }
      const limit = (other.x * other.x + other.y * other.y - point.x * point.x - point.y * point.y) / 2;
      const clipped: MapVertex[] = [];
      for (let i = 0; i < polygon.length; i++) {
        const a = polygon[i], b = polygon[(i + 1) % polygon.length];
        const da = a.x * dx + a.y * dy - limit, db = b.x * dx + b.y * dy - limit;
        if (da <= 1e-8) clipped.push(a);
        if ((da <= 1e-8) !== (db <= 1e-8)) {
          const t = da / (da - db); clipped.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
        }
      }
      polygon = clipped;
    }
    return { id: point.id, polygon };
  });
}

export function ownershipShares(territories: readonly Pick<Territory, 'owner'>[]): number[] {
  const counts = FACTIONS.map(() => 0);
  for (const site of territories) counts[site.owner]++;
  return normalizeOwnership(counts);
}

export function normalizeOwnership(shares: readonly number[]): number[] {
  const safe = FACTIONS.map((_, index) => Number.isFinite(shares[index]) ? Math.max(0, shares[index]) : 0);
  const total = safe.reduce((sum, value) => sum + value, 0);
  return total ? safe.map(value => value / total) : FACTIONS.map((_, index) => index ? 0 : 1);
}

export function renderOwnership(container: HTMLElement, shares: readonly number[], legend = true): void {
  const normalized = normalizeOwnership(shares), bar = document.createElement('div');
  bar.className = 'ownership-meter'; bar.setAttribute('role', 'img');
  const labels = FACTIONS.map((faction, index) => index ? faction.name : 'Unclaimed');
  bar.setAttribute('aria-label', `Control points: ${normalized.map((share, index) => `${labels[index]} ${Math.round(share * 100)}%`).join(', ')}`);
  container.replaceChildren(bar);
  normalized.forEach((share, index) => {
    const segment = document.createElement('i'); segment.dataset.owner = String(index);
    segment.style.width = `${share * 100}%`; segment.style.background = FACTIONS[index].color;
    segment.title = `${labels[index]} · ${(share * 100).toFixed(1)}% of control points`; bar.append(segment);
  });
  if (legend) {
    const key = document.createElement('div'); key.className = 'ownership-legend';
    normalized.forEach((share, index) => {
      const label = document.createElement('span'); label.style.setProperty('--share-color', FACTIONS[index].color);
      label.textContent = `${labels[index]} ${Math.round(share * 100)}%`; key.append(label);
    });
    container.append(key);
  }
}
