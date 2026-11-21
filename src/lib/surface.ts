/**
 * OSM `surface=*` values → the paw-heat model's surface kinds.
 *
 * Pure and browser-free so it can be unit tested directly.
 */

import { PAW_K_VALUES, type PawSurfaceKind } from '../config';

/**
 * OSM surface values grouped onto the five kinds the paw model calibrates.
 * Unlisted values return undefined rather than guessing — an unknown surface
 * draws nothing (CLAUDE.md §2.6).
 */
const SURFACE_ALIASES: Readonly<Record<string, PawSurfaceKind>> = {
  asphalt: 'asphalt',
  chipseal: 'asphalt',
  tarmac: 'asphalt',
  bitumen: 'asphalt',
  concrete: 'concrete',
  'concrete:plates': 'concrete',
  'concrete:lanes': 'concrete',
  paved: 'concrete',
  paving_stones: 'concrete',
  sett: 'concrete',
  cobblestone: 'concrete',
  'unhewn_cobblestone': 'concrete',
  bricks: 'concrete',
  paving_stones_lanes: 'concrete',
  metal: 'asphalt',
  rubber: 'asphalt',
  sand: 'sand',
  shells: 'sand',
  gravel: 'gravel',
  fine_gravel: 'gravel',
  pebblestone: 'gravel',
  compacted: 'gravel',
  unpaved: 'gravel',
  ground: 'grass',
  dirt: 'grass',
  earth: 'grass',
  mud: 'grass',
  grass: 'grass',
  grass_paver: 'grass',
  woodchips: 'grass',
  wood: 'grass',
};

/** Maps an OSM `surface` tag value to a paw-model surface kind. */
export function surfaceKindFor(value: string | undefined): PawSurfaceKind | undefined {
  if (value === undefined) return undefined;
  return SURFACE_ALIASES[value.trim().toLowerCase()];
}

/**
 * Paw-heat risk band for a surface kind, derived from its k value rather than
 * hard-coded per surface, so retuning k in config.ts retunes the colour ramp.
 */
export function pawRiskForSurfaceKind(kind: PawSurfaceKind): 'high' | 'mid' | 'low' {
  const k = PAW_K_VALUES[kind];
  if (k >= PAW_K_VALUES.concrete) return 'high';
  if (k >= PAW_K_VALUES.gravel) return 'mid';
  return 'low';
}

/**
 * Every scored OSM surface value, grouped by paw-heat risk. Derived from the
 * alias table and the k values above, so retuning k regroups the tile build.
 */
export const SURFACE_VALUES_BY_RISK: Readonly<Record<'high' | 'mid' | 'low', readonly string[]>> =
  (() => {
    const groups: Record<'high' | 'mid' | 'low', string[]> = { high: [], mid: [], low: [] };
    for (const [value, kind] of Object.entries(SURFACE_ALIASES)) {
      groups[pawRiskForSurfaceKind(kind)].push(value);
    }
    return groups;
  })();
