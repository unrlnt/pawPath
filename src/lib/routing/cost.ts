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
import { surfaceKindFor } from '../surface';
import {
  ROUTE_HEAT_FACTOR,
  ROUTE_HIGHWAY_FACTOR,
  ROUTE_OFF_LEASH_FACTOR,
  ROUTE_UNKNOWN_SURFACE_HEAT_SHARE,
  type PawSurfaceKind,
} from '../../config';
import { WALK_HIGHWAYS } from '../../data/walkGraph';
import type { Tags } from './graph';

export interface CostContext {
  /** Live paw band per surface kind; absent = weather unknown, ignore heat. */
  readonly pawBands?: Readonly<Record<PawSurfaceKind, PawBand>>;
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
export function edgeFactor(tags: Tags, context: CostContext = {}): number {
  if (tags['foot'] === 'no' || tags['access'] === 'private' || tags['access'] === 'no') {
    // An explicit foot=yes/designated overrides a general access=no.
    if (!(tags['foot'] === 'yes' || tags['foot'] === 'designated')) return FORBIDDEN;
  }
  if (tags['dog'] === 'no') return FORBIDDEN;

  let factor = HIGHWAY_FACTOR[tags['highway'] ?? ''] ?? F.unknown;
  if (tags['dog'] === 'unleashed' || tags['dog'] === 'designated') factor *= ROUTE_OFF_LEASH_FACTOR;

  const kind = surfaceKindFor(tags['surface']);
  if (context.pawBands !== undefined) {
    if (kind !== undefined) factor *= HEAT_FACTOR[context.pawBands[kind]];
    // Unmapped surface: often paved in towns. Half the asphalt penalty, so a
    // known-cool path wins but an unmapped one still beats known-hot asphalt.
    else factor *= 1 + (HEAT_FACTOR[context.pawBands.asphalt] - 1) * ROUTE_UNKNOWN_SURFACE_HEAT_SHARE;
  }
  return factor;
}
