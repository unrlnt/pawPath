/**
 * Hour-by-hour walk scoring and the next good window (CLAUDE.md §7).
 *
 * Each hour is judged on paw temperature (asphalt in full sun — the common
 * worst case on a walk), UV and the chance of rain. The first matching
 * "poor" or "ok" reason wins; an hour with none is "good".
 */

import { RAIN_PROBABILITY, UV_BANDS, WALK_WINDOW_HOURS } from '../../config';
import { pawEstimate, type PawEstimate } from './paw';
import type { HourPoint } from './types';

export type HourScore = 'good' | 'ok' | 'poor';

export type ScoreReason = 'pawDanger' | 'pawCaution' | 'rainLikely' | 'rainPossible' | 'uvVeryHigh' | 'uvHigh';

export interface ScoredHour {
  readonly hour: HourPoint;
  readonly score: HourScore;
  readonly reasons: readonly ScoreReason[];
  /** Asphalt, full sun — the reference the score uses. */
  readonly paw: PawEstimate;
}

export interface ScoreOptions {
  /**
   * The 15-minute forecast says the next couple of hours stay dry. It is more
   * specific than the hourly probability, so rain reasons are dropped for this
   * hour — otherwise the card says "rain possible" and "dry for 2 h" at once.
   */
  readonly shortRangeDry?: boolean;
}

export function scoreHour(hour: HourPoint, options: ScoreOptions = {}): ScoredHour {
  const paw = pawEstimate({
    airC: hour.airC,
    shortwaveWm2: hour.shortwaveWm2,
    windKmh: hour.windKmh,
    canopyFraction: 0,
    surface: 'asphalt',
  });
  const reasons: ScoreReason[] = [];
  if (paw.band === 'danger') reasons.push('pawDanger');
  else if (paw.band === 'caution') reasons.push('pawCaution');
  if (options.shortRangeDry !== true) {
    if (hour.precipProbability >= RAIN_PROBABILITY.poor) reasons.push('rainLikely');
    else if (hour.precipProbability >= RAIN_PROBABILITY.ok) reasons.push('rainPossible');
  }
  if (hour.uvIndex >= UV_BANDS.veryHigh) reasons.push('uvVeryHigh');
  else if (hour.uvIndex >= UV_BANDS.high) reasons.push('uvHigh');

  const poor = reasons.some((r) => r === 'pawDanger' || r === 'rainLikely' || r === 'uvVeryHigh');
  const score: HourScore = poor ? 'poor' : reasons.length > 0 ? 'ok' : 'good';
  return { hour, score, reasons, paw };
}

export interface WalkWindow {
  readonly start: number;
  /** End of the last good hour (exclusive). */
  readonly end: number;
  /** True when the current hour is already good. */
  readonly startsNow: boolean;
  /** How many hours the block lasts. */
  readonly hours: number;
}

const HOUR_MS = 3_600_000;

/**
 * The next contiguous block of "good" hours within the horizon, starting with
 * the current hour. Undefined when no good hour is coming.
 */
export function nextWalkWindow(
  hours: readonly HourPoint[],
  now: number,
  horizonHours: number = WALK_WINDOW_HOURS,
  /** Hours starting before this instant are known dry from the 15-minute forecast. */
  dryUntil?: number,
): WalkWindow | undefined {
  const currentHourStart = now - (now % HOUR_MS);
  const limit = now + horizonHours * HOUR_MS;
  const upcoming = hours.filter((h) => h.time >= currentHourStart && h.time < limit);

  let start: number | undefined;
  let end = 0;
  for (const hour of upcoming) {
    const shortRangeDry = dryUntil !== undefined && hour.time < dryUntil;
    const good = scoreHour(hour, { shortRangeDry }).score === 'good';
    if (good && start === undefined) start = hour.time;
    if (good) end = hour.time + HOUR_MS;
    if (!good && start !== undefined) break;
  }
  if (start === undefined) return undefined;
  return {
    start,
    end,
    startsNow: start <= now,
    hours: Math.round((end - start) / HOUR_MS),
  };
}
