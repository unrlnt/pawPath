/**
 * Conditions from Open-Meteo (CLAUDE.md §5, §7) — forecast + air quality.
 *
 * Called from the visitor's own browser, so Open-Meteo's per-IP limits apply
 * per visitor. Requests are snapped to a 0.1° grid and cached for an hour in
 * localStorage: panning around a town costs one or two calls, not hundreds.
 *
 * The free tier is NON-COMMERCIAL (§9). Attribution (CC BY 4.0) is shown on
 * the conditions card.
 */

import {
  CONDITIONS_GRID_DEG,
  CONDITIONS_PAST_DAYS,
  CONDITIONS_TIMEOUT_MS,
  CONDITIONS_TTL_MS,
  OPEN_METEO_AIR_URL,
  OPEN_METEO_FORECAST_URL,
  STORAGE_KEYS,
} from '../../config';
import type {
  AirQualityPoint,
  Conditions,
  DailyMean,
  HourPoint,
  RainSlot,
} from '../../lib/conditions/types';
import { readStored, writeStored } from '../../lib/storage';

export type ConditionsOutcome =
  | { readonly ok: true; readonly conditions: Conditions; readonly fromCache: boolean }
  | { readonly ok: false; readonly message: string };

/** Snap to the cache grid. Exported for tests. */
export function snapToGrid(value: number): number {
  return Math.round(value / CONDITIONS_GRID_DEG) * CONDITIONS_GRID_DEG;
}

/* ------------------------------------------------------------------ *
 * Parsing — defensive: a missing array or a null value never throws
 * ------------------------------------------------------------------ */

type Json = Record<string, unknown>;

const asRecord = (value: unknown): Json =>
  typeof value === 'object' && value !== null ? (value as Json) : {};

function numbers(block: Json, key: string): (number | undefined)[] {
  const raw = block[key];
  if (!Array.isArray(raw)) return [];
  return raw.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined));
}

const seconds = (s: number | undefined): number | undefined => (s === undefined ? undefined : s * 1000);

export function parseForecast(raw: unknown, lat: number, lng: number, now: number): Omit<Conditions, 'airQuality'> | undefined {
  const root = asRecord(raw);
  const hourly = asRecord(root['hourly']);
  const times = numbers(hourly, 'time');
  if (times.length === 0) return undefined;

  const air = numbers(hourly, 'temperature_2m');
  const prob = numbers(hourly, 'precipitation_probability');
  const precip = numbers(hourly, 'precipitation');
  const uv = numbers(hourly, 'uv_index');
  const sw = numbers(hourly, 'shortwave_radiation');
  const wind = numbers(hourly, 'wind_speed_10m');
  const day = numbers(hourly, 'is_day');
  const snow = numbers(hourly, 'snowfall');

  const hours: HourPoint[] = [];
  times.forEach((t, i) => {
    const airC = air[i];
    if (t === undefined || airC === undefined) return; // an hour without temperature is useless
    hours.push({
      time: t * 1000,
      airC,
      precipProbability: prob[i] ?? 0,
      precipMm: precip[i] ?? 0,
      uvIndex: uv[i] ?? 0,
      shortwaveWm2: sw[i] ?? 0,
      windKmh: wind[i] ?? 0,
      isDay: (day[i] ?? 1) === 1,
      snowfallCm: snow[i] ?? 0,
    });
  });
  if (hours.length === 0) return undefined;

  const m15 = asRecord(root['minutely_15']);
  const m15Times = numbers(m15, 'time');
  const m15Precip = numbers(m15, 'precipitation');
  const rain15: RainSlot[] = [];
  m15Times.forEach((t, i) => {
    const mm = m15Precip[i];
    if (t !== undefined && mm !== undefined) rain15.push({ time: t * 1000, mm });
  });

  const daily = asRecord(root['daily']);
  const dTimes = numbers(daily, 'time');
  const dMeans = numbers(daily, 'temperature_2m_mean');
  const dailyMeans: DailyMean[] = [];
  dTimes.forEach((t, i) => {
    const meanC = dMeans[i];
    if (t !== undefined && meanC !== undefined) dailyMeans.push({ time: t * 1000, meanC });
  });

  // Today's sunrise/sunset: the last daily entry that has started.
  const sunrises = numbers(daily, 'sunrise');
  const sunsets = numbers(daily, 'sunset');
  let todayIndex = -1;
  dTimes.forEach((t, i) => {
    if (t !== undefined && t * 1000 <= now) todayIndex = i;
  });

  return {
    lat,
    lng,
    timeZone: typeof root['timezone'] === 'string' ? root['timezone'] : 'UTC',
    fetchedAt: now,
    hours,
    rain15,
    dailyMeans,
    sunrise: todayIndex >= 0 ? seconds(sunrises[todayIndex]) : undefined,
    sunset: todayIndex >= 0 ? seconds(sunsets[todayIndex]) : undefined,
  };
}

export function parseAirQuality(raw: unknown): AirQualityPoint[] | undefined {
  const hourly = asRecord(asRecord(raw)['hourly']);
  const times = numbers(hourly, 'time');
  const aqi = numbers(hourly, 'european_aqi');
  const pm25 = numbers(hourly, 'pm2_5');
  const pm10 = numbers(hourly, 'pm10');
  const ozone = numbers(hourly, 'ozone');
  const points: AirQualityPoint[] = [];
  times.forEach((t, i) => {
    const value = aqi[i];
    if (t === undefined || value === undefined) return;
    points.push({ time: t * 1000, aqi: value, pm25: pm25[i], pm10: pm10[i], ozone: ozone[i] });
  });
  return points.length > 0 ? points : undefined;
}

/* ------------------------------------------------------------------ *
 * Cache
 * ------------------------------------------------------------------ */

interface CacheEntry {
  readonly storedAt: number;
  readonly conditions: Conditions;
}

const isCacheEntry = (value: unknown): value is CacheEntry => {
  const v = asRecord(value);
  const c = asRecord(v['conditions']);
  return typeof v['storedAt'] === 'number' && Array.isArray(c['hours']) && typeof c['timeZone'] === 'string';
};

const cacheKey = (lat: number, lng: number): string =>
  `${STORAGE_KEYS.conditionsCachePrefix}${lat.toFixed(1)},${lng.toFixed(1)}`;

/** Drops cached cells older than a day, so localStorage never accumulates them. */
function pruneCache(now: number): void {
  try {
    const prefix = STORAGE_KEYS.conditionsCachePrefix;
    for (let i = window.localStorage.length - 1; i >= 0; i -= 1) {
      const key = window.localStorage.key(i);
      if (key === null || !key.startsWith(prefix)) continue;
      const entry = readStored(key, isCacheEntry);
      if (entry === undefined || now - entry.storedAt > 24 * CONDITIONS_TTL_MS) {
        window.localStorage.removeItem(key);
      }
    }
  } catch {
    // Storage unavailable: nothing to prune.
  }
}

/* ------------------------------------------------------------------ *
 * Fetch
 * ------------------------------------------------------------------ */

async function getJson(url: URL, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { credentials: 'omit', signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export async function loadConditions(
  latitude: number,
  longitude: number,
  signal?: AbortSignal,
): Promise<ConditionsOutcome> {
  const lat = snapToGrid(latitude);
  const lng = snapToGrid(longitude);
  const now = Date.now();
  const key = cacheKey(lat, lng);

  const cached = readStored(key, isCacheEntry);
  if (cached !== undefined && now - cached.storedAt < CONDITIONS_TTL_MS) {
    return { ok: true, conditions: cached.conditions, fromCache: true };
  }

  const timeout = AbortSignal.timeout(CONDITIONS_TIMEOUT_MS);
  const composed = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);

  const forecastUrl = new URL(OPEN_METEO_FORECAST_URL);
  forecastUrl.search = new URLSearchParams({
    latitude: lat.toFixed(2),
    longitude: lng.toFixed(2),
    timezone: 'auto',
    timeformat: 'unixtime',
    past_days: String(CONDITIONS_PAST_DAYS),
    forecast_days: '2',
    hourly:
      'temperature_2m,precipitation_probability,precipitation,uv_index,shortwave_radiation,wind_speed_10m,is_day,snowfall',
    minutely_15: 'precipitation',
    forecast_minutely_15: '12',
    daily: 'temperature_2m_mean,sunrise,sunset',
  }).toString();

  const airUrl = new URL(OPEN_METEO_AIR_URL);
  airUrl.search = new URLSearchParams({
    latitude: lat.toFixed(2),
    longitude: lng.toFixed(2),
    timeformat: 'unixtime',
    forecast_days: '2',
    hourly: 'european_aqi,pm2_5,pm10,ozone',
  }).toString();

  // Air quality is a nice-to-have: its failure must not sink the card.
  const [forecast, air] = await Promise.allSettled([
    getJson(forecastUrl, composed),
    getJson(airUrl, composed),
  ]);

  if (forecast.status === 'rejected') {
    if (signal?.aborted === true) return { ok: false, message: 'Cancelled.' };
    console.warn('[conditions] forecast failed', forecast.reason);
    if (cached !== undefined) {
      // Stale beats nothing; the card shows when it was fetched.
      return { ok: true, conditions: cached.conditions, fromCache: true };
    }
    return { ok: false, message: 'Weather is unavailable right now.' };
  }

  const parsed = parseForecast(forecast.value, lat, lng, now);
  if (parsed === undefined) return { ok: false, message: 'Weather data was incomplete.' };

  const conditions: Conditions = {
    ...parsed,
    airQuality: air.status === 'fulfilled' ? parseAirQuality(air.value) : undefined,
  };
  pruneCache(now);
  writeStored(key, { storedAt: now, conditions } satisfies CacheEntry);
  return { ok: true, conditions, fromCache: false };
}
