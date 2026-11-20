import { describe, expect, it } from 'vitest';

import { pawRiskForSurfaceKind, surfaceKindFor } from './surface';

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
