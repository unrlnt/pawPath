/**
 * Paw surface temperature model (CLAUDE.md §7).
 *
 *   T_surface ≈ T_air + k_surface × (shortwave / 1000) × wind_factor × shade_factor
 *   wind_factor  = 1 / (1 + 0.06 × wind_kmh)
 *   shade_factor = 1 − 0.7 × canopy_fraction
 *
 * An ESTIMATE. Always presented as a range, never as one precise number.
 */

import {
  PAW_ESTIMATE_SPREAD_C,
  PAW_K_VALUES,
  PAW_REFERENCE_IRRADIANCE_W_M2,
  PAW_SHADE_FACTOR_COEFFICIENT,
  PAW_THRESHOLDS_C,
  PAW_WIND_FACTOR_COEFFICIENT,
  type PawSurfaceKind,
} from '../../config';

export interface PawInput {
  readonly airC: number;
  readonly shortwaveWm2: number;
  readonly windKmh: number;
  /** 0 = full sun, 1 = full canopy. */
  readonly canopyFraction: number;
  readonly surface: PawSurfaceKind;
}

export type PawBand = 'fine' | 'caution' | 'danger';

export interface PawEstimate {
  readonly lowC: number;
  readonly highC: number;
  /** Judged on the HIGH end of the range: a paw does not average. */
  readonly band: PawBand;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** Point estimate in °C. Exported for tests; the UI uses `pawEstimate`. */
export function pawSurfaceTempC(input: PawInput): number {
  const windFactor = 1 / (1 + PAW_WIND_FACTOR_COEFFICIENT * Math.max(0, input.windKmh));
  const shadeFactor = 1 - PAW_SHADE_FACTOR_COEFFICIENT * clamp01(input.canopyFraction);
  const solar = Math.max(0, input.shortwaveWm2) / PAW_REFERENCE_IRRADIANCE_W_M2;
  return input.airC + PAW_K_VALUES[input.surface] * solar * windFactor * shadeFactor;
}

/** < 45 fine · 45–52 caution · > 52 danger (contact burns within about a minute). */
export function pawBand(surfaceC: number): PawBand {
  if (surfaceC > PAW_THRESHOLDS_C.danger) return 'danger';
  if (surfaceC >= PAW_THRESHOLDS_C.caution) return 'caution';
  return 'fine';
}

export function pawEstimate(input: PawInput): PawEstimate {
  const point = pawSurfaceTempC(input);
  const lowC = Math.round(point - PAW_ESTIMATE_SPREAD_C);
  const highC = Math.round(point + PAW_ESTIMATE_SPREAD_C);
  return { lowC, highC, band: pawBand(highC) };
}
