/**
 * Everything the conditions card shows, computed from `Conditions` at `now`.
 * Pure: the card only formats what this returns.
 */

import {
  aqiBand,
  heatBand,
  notablePollen,
  uvBand,
  type AqiBand,
  type HeatBand,
  type PollenReading,
  type UvBand,
} from './bands';
import { pawEstimate, type PawEstimate } from './paw';
import { rainOutlook, type RainOutlook } from './rainWindow';
import { seasonalAdvisories, type Advisory } from './seasonal';
import { airQualityAt, hourAt, type Conditions } from './types';
import { verdictFor, type Verdict } from './verdict';
import { nextWalkWindow, scoreHour, type ScoredHour, type WalkWindow } from './walkWindow';

export interface ConditionsSummary {
  readonly verdict: Verdict;
  readonly current: ScoredHour;
  readonly airC: number;
  readonly paw: {
    readonly asphaltSun: PawEstimate;
    readonly asphaltShade: PawEstimate;
    readonly grassSun: PawEstimate;
  };
  readonly uv: { readonly index: number; readonly band: UvBand };
  readonly heat: { readonly apparentC: number; readonly band: HeatBand };
  /** Moderate-or-higher pollen right now; empty outside Europe. */
  readonly pollen: readonly PollenReading[];
  readonly air: { readonly aqi: number; readonly band: AqiBand; readonly pm25: number | undefined } | undefined;
  readonly walkWindow: WalkWindow | undefined;
  readonly rain: RainOutlook | undefined;
  readonly advisories: readonly Advisory[];
  readonly isDay: boolean;
  /** No meaningful sun: every surface is at air temperature. */
  readonly noSun: boolean;
}

/** Below this irradiance the surface terms vanish (night, heavy overcast). */
const NO_SUN_WM2 = 5;

/** Calendar month/day at the location, not in the browser's zone. */
export function localDate(time: number, timeZone: string): { month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, month: 'numeric', day: 'numeric' }).formatToParts(
    new Date(time),
  );
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? NaN);
  return { month: get('month'), day: get('day') };
}

const HOUR = 3_600_000;

export function summarise(conditions: Conditions, now: number): ConditionsSummary | undefined {
  const hour = hourAt(conditions.hours, now);
  if (hour === undefined) return undefined;
  const rain = rainOutlook(conditions.rain15, now);
  const current = scoreHour(hour, { shortRangeDry: rain?.kind === 'dry' });
  const base = { airC: hour.airC, shortwaveWm2: hour.shortwaveWm2, windKmh: hour.windKmh };
  const aq = airQualityAt(conditions.airQuality, now);

  const next12 = conditions.hours.filter((h) => h.time >= now - HOUR && h.time < now + 12 * HOUR);
  const { month, day } = localDate(now, conditions.timeZone);
  const advisories = seasonalAdvisories({
    month,
    day,
    lat: conditions.lat,
    lng: conditions.lng,
    dailyMeans: conditions.dailyMeans.filter((d) => d.time <= now),
    minAirCNext12h: next12.length > 0 ? Math.min(...next12.map((h) => h.airC)) : undefined,
    snowfallCmNext12h: next12.reduce((sum, h) => sum + h.snowfallCm, 0),
  });

  const grassSun = pawEstimate({ ...base, canopyFraction: 0, surface: 'grass' });

  return {
    verdict: verdictFor(current, aq?.aqi),
    current,
    airC: hour.airC,
    paw: {
      asphaltSun: current.paw,
      asphaltShade: pawEstimate({ ...base, canopyFraction: 1, surface: 'asphalt' }),
      grassSun,
    },
    uv: { index: hour.uvIndex, band: uvBand(hour.uvIndex) },
    heat: { apparentC: hour.apparentC, band: heatBand(hour.apparentC) },
    pollen: aq === undefined ? [] : notablePollen(aq.pollen),
    air: aq === undefined ? undefined : { aqi: aq.aqi, band: aqiBand(aq.aqi), pm25: aq.pm25 },
    // Same rule as the current hour, so the card never says "good to walk"
    // and "next good stretch: later" at once.
    walkWindow: nextWalkWindow(
      conditions.hours,
      now,
      undefined,
      rain?.kind === 'dry' ? now + rain.forMinutes * 60_000 : undefined,
    ),
    rain,
    advisories,
    isDay: hour.isDay,
    noSun:
      hour.shortwaveWm2 < NO_SUN_WM2 ||
      (current.paw.lowC === grassSun.lowC && current.paw.highC === grassSun.highC),
  };
}
