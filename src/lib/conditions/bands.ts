/** UV and air-quality bands (thresholds in config.ts). */

import { AQI_BANDS, UV_BANDS } from '../../config';

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
