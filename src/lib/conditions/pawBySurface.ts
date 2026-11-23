/**
 * The paw estimate for EVERY surface kind under the current weather — what
 * lets each path be coloured by its own surface (CLAUDE.md §11, Phase 5): an
 * asphalt road reads hot while the grass path beside it stays green.
 */

import { PAW_K_VALUES, SHADE_CANOPY_FRACTION, type PawSurfaceKind } from '../../config';
import type { Exposure } from '../routing/shade';
import { pawEstimate, type PawBand, type PawEstimate } from './paw';
import type { HourPoint } from './types';

export type PawBySurface = Readonly<Record<PawSurfaceKind, PawEstimate>>;

export const SURFACE_KINDS = Object.keys(PAW_K_VALUES) as PawSurfaceKind[];

type Weather = Pick<HourPoint, 'airC' | 'shortwaveWm2' | 'windKmh'>;

/** Default full sun (canopy 0): the conservative reading for an open path. */
export function pawBySurface(hour: Weather, canopyFraction = 0): PawBySurface {
  const out = {} as Record<PawSurfaceKind, PawEstimate>;
  for (const surface of SURFACE_KINDS) {
    out[surface] = pawEstimate({ ...hour, canopyFraction, surface });
  }
  return out;
}

/** The full estimate per surface kind, for full sun and each shade level. */
export type PawsByExposure = Readonly<Record<Exposure, PawBySurface>>;

export function pawsByExposure(hour: Weather): PawsByExposure {
  const out = {} as Record<Exposure, PawBySurface>;
  for (const exposure of Object.keys(SHADE_CANOPY_FRACTION) as Exposure[]) {
    out[exposure] = pawBySurface(hour, SHADE_CANOPY_FRACTION[exposure]);
  }
  return out;
}

export type PawBands = Readonly<Record<PawSurfaceKind, PawBand>>;
/** Paw band per surface kind, for full sun and for each shade level. */
export type PawBandsByExposure = Readonly<Record<Exposure, PawBands>>;

export function pawBandsByExposure(hour: Weather): PawBandsByExposure {
  const out = {} as Record<Exposure, PawBands>;
  for (const exposure of Object.keys(SHADE_CANOPY_FRACTION) as Exposure[]) {
    const estimates = pawBySurface(hour, SHADE_CANOPY_FRACTION[exposure]);
    out[exposure] = Object.fromEntries(SURFACE_KINDS.map((k) => [k, estimates[k].band])) as Record<PawSurfaceKind, PawBand>;
  }
  return out;
}
