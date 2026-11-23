import { describe, expect, it } from 'vitest';

import { compassWord, nearest } from './nearby';
import type { Poi } from './routing/stops';

const here: [number, number] = [5.22, 52.37];

describe('find nearby', () => {
  const pois: Poi[] = [
    { kind: 'bin', at: [5.23, 52.37] }, // ~680 m east
    { kind: 'dogBin', at: [5.22, 52.372] }, // ~220 m north
    { kind: 'bench', at: [5.2201, 52.3701] },
    { kind: 'bin', at: [5.22, 52.36] }, // ~1.1 km south
    { kind: 'offLeash', at: [5.21, 52.365], fenced: true },
  ];

  it('lists the closest first, and counts dog bins as bins', () => {
    const bins = nearest(pois, here, 'bin');
    expect(bins.map((r) => r.poi.kind)).toEqual(['dogBin', 'bin', 'bin']);
    expect(bins[0]?.direction).toBe('north');
    expect(bins[1]?.direction).toBe('east');
    expect(Math.round((bins[0]?.distanceM ?? 0) / 10) * 10).toBe(220);
  });

  it('only lists what was asked for, and nothing when there is none', () => {
    expect(nearest(pois, here, 'dogBin')).toHaveLength(1);
    expect(nearest(pois, here, 'water')).toEqual([]);
    expect(nearest(pois, here, 'offLeash')[0]?.poi.fenced).toBe(true);
  });

  it('names eight compass directions', () => {
    expect(compassWord(here, [5.23, 52.38])).toBe('north-east');
    expect(compassWord(here, [5.21, 52.36])).toBe('south-west');
    expect(compassWord(here, [5.22, 52.36])).toBe('south');
  });
});
