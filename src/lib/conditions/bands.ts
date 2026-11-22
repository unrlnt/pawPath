/** UV and air-quality bands (thresholds in config.ts). */

import { AQI_BANDS, DOG_HEAT_BANDS_C, POLLEN_BANDS, UV_BANDS } from '../../config';
import { POLLEN_KINDS, type PollenKind } from './types';

export type UvBand = 'low' | 'moderate' | 'high' | 'veryHigh' | 'extreme';

export function uvBand(index: number): UvBand {
  if (index >= UV_BANDS.extreme) return 'extreme';
  if (index >= UV_BANDS.veryHigh) return 'veryHigh';
  if (index >= UV_BANDS.high) return 'high';
  if (index >= UV_BANDS.moderate) return 'moderate';
  return 'low';
}

export type AqiBand = 'good' | 'fair' | 'moderate' | 'poor' | 'veryPoor' | 'extremelyPoor';

export function aqiBand(aqi: number): AqiBand {
  if (aqi >= AQI_BANDS.extremelyPoor) return 'extremelyPoor';
  if (aqi >= AQI_BANDS.veryPoor) return 'veryPoor';
  if (aqi >= AQI_BANDS.poor) return 'poor';
  if (aqi >= AQI_BANDS.moderate) return 'moderate';
  if (aqi >= AQI_BANDS.fair) return 'fair';
  return 'good';
}

export const UV_LABELS: Readonly<Record<UvBand, string>> = {
  low: 'low',
  moderate: 'moderate',
  high: 'high',
  veryHigh: 'very high',
  extreme: 'extreme',
};

export const AQI_LABELS: Readonly<Record<AqiBand, string>> = {
  good: 'good',
  fair: 'fair',
  moderate: 'moderate',
  poor: 'poor',
  veryPoor: 'very poor',
  extremelyPoor: 'extremely poor',
};

export type HeatBand = 'low' | 'moderate' | 'high' | 'veryHigh' | 'extreme';

/** Heat stress for dogs from the felt temperature (DOG_HEAT_BANDS_C). */
export function heatBand(apparentC: number): HeatBand {
  if (apparentC >= DOG_HEAT_BANDS_C.extreme) return 'extreme';
  if (apparentC >= DOG_HEAT_BANDS_C.veryHigh) return 'veryHigh';
  if (apparentC >= DOG_HEAT_BANDS_C.high) return 'high';
  if (apparentC >= DOG_HEAT_BANDS_C.moderate) return 'moderate';
  return 'low';
}

export const HEAT_ADVICE: Readonly<Record<HeatBand, string>> = {
  low: 'No heat stress.',
  moderate: 'Warm: fine for most dogs. Flat-faced, older or thick-coated dogs may tire — bring water.',
  high: 'Hot for dogs: keep walks shorter, plan a route with shade, and bring water.',
  veryHigh: 'Very hot for dogs: short, shady walks only, ideally early or late.',
  extreme: 'Dangerous heat for dogs: avoid walks except quick breaks in the shade.',
};

export type PollenLevel = 'moderate' | 'high';

export interface PollenReading {
  readonly kind: PollenKind;
  readonly grains: number;
  readonly level: PollenLevel;
}

/** Pollen types at moderate or above, highest first. Empty outside Europe. */
export function notablePollen(pollen: Readonly<Partial<Record<PollenKind, number>>>): PollenReading[] {
  const readings: PollenReading[] = [];
  for (const kind of POLLEN_KINDS) {
    const grains = pollen[kind];
    if (grains === undefined) continue;
    const bands = POLLEN_BANDS[kind];
    if (grains >= bands.high) readings.push({ kind, grains, level: 'high' });
    else if (grains >= bands.moderate) readings.push({ kind, grains, level: 'moderate' });
  }
  return readings.sort((a, b) => (a.level === b.level ? b.grains - a.grains : a.level === 'high' ? -1 : 1));
}
