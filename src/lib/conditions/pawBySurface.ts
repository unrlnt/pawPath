/**
 * The paw estimate for EVERY surface kind under the current weather — what
 * lets each path be coloured by its own surface (CLAUDE.md §11, Phase 5): an
 * asphalt road reads hot while the grass path beside it stays green.
 */

import { PAW_K_VALUES, type PawSurfaceKind } from '../../config';
import { pawEstimate, type PawEstimate } from './paw';
import type { HourPoint } from './types';

export type PawBySurface = Readonly<Record<PawSurfaceKind, PawEstimate>>;

export const SURFACE_KINDS = Object.keys(PAW_K_VALUES) as PawSurfaceKind[];

/** Full sun (canopy 0): the conservative reading for an open path. */
export function pawBySurface(hour: Pick<HourPoint, 'airC' | 'shortwaveWm2' | 'windKmh'>): PawBySurface {
  const out = {} as Record<PawSurfaceKind, PawEstimate>;
  for (const surface of SURFACE_KINDS) {
    out[surface] = pawEstimate({ ...hour, canopyFraction: 0, surface });
  }
  return out;
}
