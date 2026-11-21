/**
 * The one-line verdict on the collapsed card: "Good to walk" etc.
 * Combines the current hour's score with air quality.
 */

import { AQI_BANDS } from '../../config';
import type { ScoredHour } from './walkWindow';

export type Verdict = 'good' | 'care' | 'wait';

export const VERDICT_LABELS: Readonly<Record<Verdict, string>> = {
  good: 'Good to walk',
  care: 'Walk with care',
  wait: 'Better wait if you can',
};

export function verdictFor(current: ScoredHour, aqi: number | undefined): Verdict {
  if (current.score === 'poor' || (aqi !== undefined && aqi >= AQI_BANDS.veryPoor)) return 'wait';
  if (current.score === 'ok' || (aqi !== undefined && aqi >= AQI_BANDS.poor)) return 'care';
  return 'good';
}
