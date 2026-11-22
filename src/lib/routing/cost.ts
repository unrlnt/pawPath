/**
 * Dog-aware edge cost (CLAUDE.md §11, Phase 9): metres × preference factor.
 *
 * - Never through `foot=no`, private access or `dog=no`.
 * - Footpaths and tracks beat streets; busy roads are a last resort.
 * - With live weather, surfaces too hot for paws cost more — the route bends
 *   onto grass and gravel on a hot afternoon, and does not care at night.
 * - Explicitly off-leash paths are a small bonus.
 */

import type { PawBand } from '../conditions/paw';
import type { PawBandsByExposure } from '../conditions/pawBySurface';
import type { ShadeLevel } from './shade';
import { surfaceKindFor } from '../surface';
import {
  ROUTE_HEAT_FACTOR,
  ROUTE_HIGHWAY_FACTOR,
  ROUTE_OFF_LEASH_FACTOR,
  ROUTE_SUN_FACTOR_BY_FELT_C,
  ROUTE_UNKNOWN_SURFACE_HEAT_SHARE,
} from '../../config';
import { WALK_HIGHWAYS } from '../../data/walkGraph';
import type { Tags } from './graph';

export interface CostContext {
  /** Live paw band per exposure and surface kind; absent = weather unknown, ignore heat. */
  readonly pawBands?: PawBandsByExposure;
  /** Felt temperature now, °C: drives the preference for shade. */
  readonly feltC?: number;
}

/** Extra cost of full sun at this felt temperature (1 = none). */
export function sunFactor(feltC: number | undefined): number {
  if (feltC === undefined) return 1;
  return ROUTE_SUN_FACTOR_BY_FELT_C.find((band) => feltC >= band.fromC)?.factor ?? 1;
}

export const FORBIDDEN = Number.POSITIVE_INFINITY;

const F = ROUTE_HIGHWAY_FACTOR;
const HIGHWAY_FACTOR: Readonly<Record<string, number>> = Object.fromEntries([
  ...WALK_HIGHWAYS.preferred.map((h) => [h, F.preferred] as const),
  ...WALK_HIGHWAYS.normal.map((h) => [h, F.normal] as const),
  ...WALK_HIGHWAYS.avoid.map((h) => [h, h.startsWith('tertiary') ? F.tertiary : F.major] as const),
]);

const HEAT_FACTOR: Readonly<Record<PawBand, number>> = ROUTE_HEAT_FACTOR;

/** The cheapest factor any edge can have — keeps the A* heuristic admissible. */
export const MIN_EDGE_FACTOR = Math.min(F.preferred, F.normal) * ROUTE_OFF_LEASH_FACTOR;

/** Cost multiplier for walking one metre of an edge with these tags. */
export function edgeFactor(tags: Tags, context: CostContext = {}, shade?: ShadeLevel): number {
  if (tags['foot'] === 'no' || tags['access'] === 'private' || tags['access'] === 'no') {
    // An explicit foot=yes/designated overrides a general access=no.
    if (!(tags['foot'] === 'yes' || tags['foot'] === 'designated')) return FORBIDDEN;
  }
  if (tags['dog'] === 'no') return FORBIDDEN;

  let factor = HIGHWAY_FACTOR[tags['highway'] ?? ''] ?? F.unknown;
  if (tags['dog'] === 'unleashed' || tags['dog'] === 'designated') factor *= ROUTE_OFF_LEASH_FACTOR;

  const kind = surfaceKindFor(tags['surface']);
  if (context.pawBands !== undefined) {
    const bands = context.pawBands[shade ?? 'sun'];
    if (kind !== undefined) factor *= HEAT_FACTOR[bands[kind]];
    // Unmapped surface: often paved in towns. Half the asphalt penalty, so a
    // known-cool path wins but an unmapped one still beats known-hot asphalt.
    else factor *= 1 + (HEAT_FACTOR[bands.asphalt] - 1) * ROUTE_UNKNOWN_SURFACE_HEAT_SHARE;
  }
  // Shade for the dog itself, whatever the surface: full sun pays the extra,
  // a tree row half of it, forest and scrub none.
  const sun = sunFactor(context.feltC);
  if (shade === undefined) factor *= sun;
  else if (shade === 'light') factor *= 1 + (sun - 1) / 2;
  return factor;
}
