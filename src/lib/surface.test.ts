import { describe, expect, it } from 'vitest';

import { SURFACE_VALUES_BY_KIND, pawRiskForSurfaceKind, surfaceKindFor } from './surface';

describe('surfaceKindFor', () => {
  it('maps common OSM surface values onto model kinds', () => {
    expect(surfaceKindFor('asphalt')).toBe('asphalt');
    expect(surfaceKindFor('paving_stones')).toBe('concrete');
    expect(surfaceKindFor('fine_gravel')).toBe('gravel');
    expect(surfaceKindFor('dirt')).toBe('grass');
    expect(surfaceKindFor('sand')).toBe('sand');
  });

  it('is case- and whitespace-insensitive', () => {
    expect(surfaceKindFor(' Asphalt ')).toBe('asphalt');
  });

  it('returns undefined rather than guessing', () => {
    expect(surfaceKindFor(undefined)).toBeUndefined();
    expect(surfaceKindFor('moon_dust')).toBeUndefined();
  });
});

describe('pawRiskForSurfaceKind', () => {
  it('ranks hot surfaces above cool ones', () => {
    expect(pawRiskForSurfaceKind('asphalt')).toBe('high');
    expect(pawRiskForSurfaceKind('concrete')).toBe('high');
    expect(pawRiskForSurfaceKind('gravel')).toBe('mid');
    expect(pawRiskForSurfaceKind('grass')).toBe('low');
  });
});

describe('SURFACE_VALUES_BY_KIND', () => {
  it('groups every scored value under exactly one kind', () => {
    const all = Object.values(SURFACE_VALUES_BY_KIND).flat();
    expect(new Set(all).size).toBe(all.length);
    expect(SURFACE_VALUES_BY_KIND.asphalt).toContain('asphalt');
    expect(SURFACE_VALUES_BY_KIND.grass).toContain('dirt');
  });
});
