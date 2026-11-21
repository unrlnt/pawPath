import { describe, expect, it } from 'vitest';

import { parseAirQuality, parseForecast, snapToGrid } from './openMeteoSource';

// Shape copied from a real response (Almere, 2026-11-21), trimmed.
const FORECAST = {
  latitude: 52.402,
  longitude: 5.307,
  timezone: 'Europe/Amsterdam',
  hourly: {
    time: [1795244400, 1795248000, 1795251600],
    temperature_2m: [4.9, 5.4, null],
    precipitation_probability: [20, 35, 40],
    precipitation: [0, 0.1, 0.2],
    uv_index: [0.5, 0.8, 0.6],
    shortwave_radiation: [60, 120, 90],
    wind_speed_10m: [18.4, 20.1, 19],
    is_day: [1, 1, 1],
    snowfall: [0, 0, 0],
  },
  minutely_15: { time: [1795248000, 1795248900], precipitation: [0, 0.3] },
  daily: {
    time: [1795129200, 1795215600],
    temperature_2m_mean: [4.9, 5.2],
    sunrise: [1795158517, 1795244980],
    sunset: [1795189176, 1795275500],
  },
};

describe('parseForecast', () => {
  const now = 1795249000 * 1000;
  const parsed = parseForecast(FORECAST, 52.4, 5.3, now);

  it('converts unix seconds to ms and keeps the location time zone', () => {
    expect(parsed?.timeZone).toBe('Europe/Amsterdam');
    expect(parsed?.hours[0]?.time).toBe(1795244400 * 1000);
  });

  it('drops an hour with no temperature instead of inventing one', () => {
    expect(parsed?.hours).toHaveLength(2);
  });

  it('reads 15-minute rain, daily means and today’s sun times', () => {
    expect(parsed?.rain15).toEqual([
      { time: 1795248000000, mm: 0 },
      { time: 1795248900000, mm: 0.3 },
    ]);
    expect(parsed?.dailyMeans.map((d) => d.meanC)).toEqual([4.9, 5.2]);
    expect(parsed?.sunrise).toBe(1795244980 * 1000);
  });

  it('returns undefined for garbage', () => {
    expect(parseForecast(null, 0, 0, now)).toBeUndefined();
    expect(parseForecast({ hourly: { time: 'x' } }, 0, 0, now)).toBeUndefined();
  });
});

describe('parseAirQuality', () => {
  it('reads European AQI and pollutants, tolerating nulls', () => {
    const points = parseAirQuality({
      hourly: { time: [1, 2], european_aqi: [22, null], pm2_5: [5.1, 4], pm10: [9, 8], ozone: [40, 41] },
    });
    expect(points).toEqual([{ time: 1000, aqi: 22, pm25: 5.1, pm10: 9, ozone: 40 }]);
  });

  it('is undefined when nothing usable came back', () => {
    expect(parseAirQuality({})).toBeUndefined();
  });
});

describe('snapToGrid', () => {
  it('snaps to 0.1° so neighbours share a cache entry', () => {
    expect(snapToGrid(52.3508)).toBeCloseTo(52.4, 10);
    expect(snapToGrid(5.2647)).toBeCloseTo(5.3, 10);
    expect(snapToGrid(-37.8136)).toBeCloseTo(-37.8, 10);
  });
});
