import { describe, expect, it } from 'vitest';

import { TILE_SIZE_KM } from '../config';
import {
  TILE_LAT_STEP,
  bboxAreaKm2,
  bboxAround,
  boundsForTileId,
  normaliseLongitude,
  parseTileId,
  splitAtAntimeridian,
  tileIdFor,
  tilesCovering,
  tilesForViewport,
} from './tiles';

const ALMERE = { lat: 52.3508, lng: 5.2647 };

describe('tile grid', () => {
  it('is about TILE_SIZE_KM tall', () => {
    const bounds = boundsForTileId(tileIdFor(ALMERE.lat, ALMERE.lng));
    expect(bounds).toBeDefined();
    if (bounds === undefined) return;
    const heightKm = (bounds.north - bounds.south) / (TILE_LAT_STEP / TILE_SIZE_KM);
    expect(heightKm).toBeCloseTo(TILE_SIZE_KM, 6);
  });

  it('is about TILE_SIZE_KM wide at any latitude', () => {
    for (const lat of [0, 52.35, -37.81, 70]) {
      const bounds = boundsForTileId(tileIdFor(lat, 5));
      expect(bounds).toBeDefined();
      if (bounds === undefined) continue;
      const areaKm2 = bboxAreaKm2(bounds);
      // Within 5% of a square tile — the cos() correction uses the band centre.
      expect(areaKm2).toBeGreaterThan(TILE_SIZE_KM ** 2 * 0.95);
      expect(areaKm2).toBeLessThan(TILE_SIZE_KM ** 2 * 1.05);
    }
  });

  it('contains the point it was derived from', () => {
    const bounds = boundsForTileId(tileIdFor(ALMERE.lat, ALMERE.lng));
    expect(bounds).toBeDefined();
    if (bounds === undefined) return;
    expect(ALMERE.lat).toBeGreaterThanOrEqual(bounds.south);
    expect(ALMERE.lat).toBeLessThan(bounds.north);
    expect(ALMERE.lng).toBeGreaterThanOrEqual(bounds.west);
    expect(ALMERE.lng).toBeLessThan(bounds.east);
  });

  it('is stable: the same point always yields the same id', () => {
    expect(tileIdFor(ALMERE.lat, ALMERE.lng)).toBe(tileIdFor(ALMERE.lat, ALMERE.lng));
  });

  it('gives neighbouring points different ids once they cross a boundary', () => {
    const here = tileIdFor(ALMERE.lat, ALMERE.lng);
    const farNorth = tileIdFor(ALMERE.lat + TILE_LAT_STEP, ALMERE.lng);
    expect(farNorth).not.toBe(here);
  });

  it('round-trips ids', () => {
    const id = tileIdFor(-37.8136, 144.9631);
    expect(parseTileId(id)).toBeDefined();
    expect(boundsForTileId(id)).toBeDefined();
  });

  it('rejects ids from a different grid size', () => {
    expect(parseTileId('9km:100:200')).toBeUndefined();
    expect(parseTileId('nonsense')).toBeUndefined();
    expect(boundsForTileId(`${TILE_SIZE_KM}km:a:b`)).toBeUndefined();
  });

  it('covers a bbox with tiles', () => {
    const bbox = bboxAround(ALMERE.lat, ALMERE.lng, 3);
    const ids = tilesCovering(bbox);
    expect(ids.length).toBeGreaterThanOrEqual(9);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(tileIdFor(ALMERE.lat, ALMERE.lng));
  });

  it('normalises longitude into [-180, 180)', () => {
    expect(normaliseLongitude(190)).toBeCloseTo(-170, 9);
    expect(normaliseLongitude(-190)).toBeCloseTo(170, 9);
    expect(normaliseLongitude(5)).toBeCloseTo(5, 9);
  });
});

describe('antimeridian', () => {
  /**
   * A viewport panned across ±180° arrives with west > east. Read naively that
   * looks like a box spanning the whole planet.
   */
  /** A realistic viewport over Fiji, straddling the line. ~0.04° across. */
  const crossing = { south: -17.54, west: 179.98, north: -17.5, east: -179.98 };

  it('splits a crossing bbox into two ordinary ones', () => {
    const parts = splitAtAntimeridian(crossing);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ west: 179.98, east: 180 });
    expect(parts[1]).toMatchObject({ west: -180, east: -179.98 });
  });

  it('leaves an ordinary bbox alone', () => {
    const parts = splitAtAntimeridian({ south: 52, west: 5, north: 53, east: 6 });
    expect(parts).toHaveLength(1);
  });

  it('covers a small crossing viewport with a handful of tiles, not the planet', () => {
    const ids = tilesCovering(crossing);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.length).toBeLessThan(20);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('does not mistake a crossing box for a whole-planet one', () => {
    // The bug this guards: read naively, west=179.98/east=-179.98 looks like a
    // 359.96°-wide box rather than a 0.04°-wide one.
    const naiveEquivalent = tilesCovering({
      south: crossing.south,
      north: crossing.north,
      west: -179.98,
      east: 179.98,
    });
    expect(tilesCovering(crossing).length).toBeLessThan(naiveEquivalent.length / 1000);
  });

  it('includes tiles from both sides of the line', () => {
    const ids = tilesCovering(crossing);
    expect(ids).toContain(tileIdFor(-17.52, 179.99));
    expect(ids).toContain(tileIdFor(-17.52, -179.99));
  });
});

describe('high latitude', () => {
  it('produces a finite tile set near the pole', () => {
    const ids = tilesCovering({ south: 84, west: -20, north: 89, east: 20 });
    expect(ids.length).toBeGreaterThan(0);
    expect(Number.isFinite(ids.length)).toBe(true);
    for (const id of ids) expect(boundsForTileId(id)).toBeDefined();
  });

  it('keeps tiles roughly square rather than degenerate', () => {
    const bounds = boundsForTileId(tileIdFor(80, 20));
    expect(bounds).toBeDefined();
    if (bounds === undefined) return;
    const areaKm2 = bboxAreaKm2(bounds);
    expect(areaKm2).toBeGreaterThan(TILE_SIZE_KM ** 2 * 0.5);
    expect(areaKm2).toBeLessThan(TILE_SIZE_KM ** 2 * 2);
  });
});

describe('tilesForViewport', () => {
  const centre = { lat: 52.3508, lng: 5.2647 };
  const viewport = bboxAround(centre.lat, centre.lng, 6);

  it('orders tiles centre-outward', () => {
    const { tileIds } = tilesForViewport(viewport, centre, 100);
    expect(tileIds[0]).toBe(tileIdFor(centre.lat, centre.lng));
  });

  it('caps the list and says so', () => {
    const capped = tilesForViewport(viewport, centre, 4);
    expect(capped.tileIds).toHaveLength(4);
    expect(capped.capped).toBe(true);
    expect(capped.totalTiles).toBeGreaterThan(4);
    // The kept tiles are the centre-most ones.
    expect(capped.tileIds[0]).toBe(tileIdFor(centre.lat, centre.lng));
  });

  it('reports uncapped when everything fits', () => {
    const small = tilesForViewport(bboxAround(centre.lat, centre.lng, 0.5), centre, 50);
    expect(small.capped).toBe(false);
    expect(small.tileIds).toHaveLength(small.totalTiles);
  });

  it('is deterministic', () => {
    const a = tilesForViewport(viewport, centre, 9).tileIds;
    const b = tilesForViewport(viewport, centre, 9).tileIds;
    expect(a).toEqual(b);
  });
});

describe('bboxAround', () => {
  it('produces a box of roughly (2r)² km²', () => {
    const bbox = bboxAround(ALMERE.lat, ALMERE.lng, 2);
    expect(bboxAreaKm2(bbox)).toBeGreaterThan(15.5);
    expect(bboxAreaKm2(bbox)).toBeLessThan(16.5);
  });
});
