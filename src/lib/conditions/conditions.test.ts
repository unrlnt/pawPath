import { describe, expect, it } from 'vitest';

import { aqiBand, heatBand, notablePollen, uvBand } from './bands';
import { pawBand, pawEstimate, pawSurfaceTempC } from './paw';
import { rainOutlook } from './rainWindow';
import { countriesAt, seasonalAdvisories, type SeasonalInput } from './seasonal';
import { localDate, summarise } from './summary';
import { hourAt, type Conditions, type HourPoint } from './types';
import { verdictFor } from './verdict';
import { nextWalkWindow, scoreHour } from './walkWindow';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 6, 15, 10); // 15 July 2026, 10:00 UTC

function hour(offset: number, patch: Partial<HourPoint> = {}): HourPoint {
  return {
    time: T0 + offset * HOUR,
    airC: 18,
    apparentC: 18,
    precipProbability: 0,
    precipMm: 0,
    uvIndex: 2,
    shortwaveWm2: 0,
    windKmh: 10,
    isDay: true,
    snowfallCm: 0,
    ...patch,
  };
}

describe('paw model', () => {
  it('follows the spec formula', () => {
    // 30 + 28 × (800/1000) × 1/(1+0.06×5) × 1  ≈ 30 + 17.23
    const t = pawSurfaceTempC({ airC: 30, shortwaveWm2: 800, windKmh: 5, canopyFraction: 0, surface: 'asphalt' });
    expect(t).toBeCloseTo(30 + (28 * 0.8) / 1.3, 5);
  });

  it('equals air temperature at night', () => {
    expect(pawSurfaceTempC({ airC: 12, shortwaveWm2: 0, windKmh: 0, canopyFraction: 0, surface: 'asphalt' })).toBe(12);
  });

  it('is cooler in shade and on grass', () => {
    const base = { airC: 28, shortwaveWm2: 900, windKmh: 5 };
    const sunAsphalt = pawSurfaceTempC({ ...base, canopyFraction: 0, surface: 'asphalt' });
    expect(pawSurfaceTempC({ ...base, canopyFraction: 1, surface: 'asphalt' })).toBeLessThan(sunAsphalt);
    expect(pawSurfaceTempC({ ...base, canopyFraction: 0, surface: 'grass' })).toBeLessThan(sunAsphalt);
  });

  it('bands at the spec thresholds', () => {
    expect(pawBand(44.9)).toBe('fine');
    expect(pawBand(45)).toBe('caution');
    expect(pawBand(52)).toBe('caution');
    expect(pawBand(52.1)).toBe('danger');
  });

  it('is a range, judged on its high end', () => {
    // point 43 → 40–46: the high end crosses 45, so caution — a paw does not average.
    const estimate = pawEstimate({ airC: 43, shortwaveWm2: 0, windKmh: 0, canopyFraction: 0, surface: 'asphalt' });
    expect(estimate).toEqual({ lowC: 40, highC: 46, band: 'caution' });
  });
});

describe('UV and AQI bands', () => {
  it('uses the WHO UV bands', () => {
    expect([0, 3, 6, 8, 11].map(uvBand)).toEqual(['low', 'moderate', 'high', 'veryHigh', 'extreme']);
  });
  it('uses the European AQI bands', () => {
    expect([10, 20, 40, 60, 80, 100].map(aqiBand)).toEqual([
      'good', 'fair', 'moderate', 'poor', 'veryPoor', 'extremelyPoor',
    ]);
  });
});

describe('walk scoring and window', () => {
  it('scores a mild dry hour as good', () => {
    expect(scoreHour(hour(0)).score).toBe('good');
  });

  it('marks a hot sunny afternoon poor because of the pavement', () => {
    const scored = scoreHour(hour(0, { airC: 32, shortwaveWm2: 850, windKmh: 3 }));
    expect(scored.score).toBe('poor');
    expect(scored.reasons).toContain('pawDanger');
  });

  it('distinguishes possible from likely rain', () => {
    expect(scoreHour(hour(0, { precipProbability: 40 })).score).toBe('ok');
    expect(scoreHour(hour(0, { precipProbability: 70 })).score).toBe('poor');
  });

  it('finds the next good block after a hot midday', () => {
    const hours = [
      hour(0, { airC: 32, shortwaveWm2: 850, windKmh: 3 }),
      hour(1, { airC: 33, shortwaveWm2: 800, windKmh: 3 }),
      hour(2),
      hour(3),
      hour(4, { precipProbability: 80 }),
    ];
    const window = nextWalkWindow(hours, T0 + 10 * 60_000);
    expect(window).toEqual({ start: T0 + 2 * HOUR, end: T0 + 4 * HOUR, startsNow: false, hours: 2 });
  });

  it('says "now" when the current hour is good', () => {
    const window = nextWalkWindow([hour(0), hour(1)], T0 + 30 * 60_000);
    expect(window?.startsNow).toBe(true);
  });

  it('returns nothing when no good hour is coming', () => {
    expect(nextWalkWindow([hour(0, { precipProbability: 90 })], T0)).toBeUndefined();
  });

  it('picks the current hour, not the next one', () => {
    expect(hourAt([hour(0), hour(1)], T0 + 59 * 60_000)?.time).toBe(T0);
  });
});

describe('rain outlook', () => {
  const slots = (mms: number[]) => mms.map((mm, i) => ({ time: T0 + i * 15 * 60_000, mm }));

  it('reports a dry window', () => {
    expect(rainOutlook(slots([0, 0, 0, 0, 0, 0, 0, 0]), T0)).toEqual({ kind: 'dry', forMinutes: 120 });
  });

  it('reports rain arriving', () => {
    expect(rainOutlook(slots([0, 0, 0.4, 0.8]), T0)).toEqual({ kind: 'rainSoon', inMinutes: 30 });
  });

  it('reports rain now and when it eases', () => {
    expect(rainOutlook(slots([0.5, 0.3, 0, 0]), T0)).toEqual({ kind: 'rainingNow', dryInMinutes: 30 });
  });

  it('ignores drizzle below the threshold', () => {
    expect(rainOutlook(slots([0.05, 0.05]), T0)?.kind).toBe('dry');
  });

  it('has nothing to say without 15-minute data', () => {
    expect(rainOutlook([], T0)).toBeUndefined();
  });
});

describe('seasonal advisories', () => {
  const base: SeasonalInput = {
    month: 11,
    day: 21,
    lat: 52.35, // Almere
    lng: 5.26,
    dailyMeans: [],
    minAirCNext12h: 5,
    snowfallCmNext12h: 0,
  };
  const ids = (input: Partial<SeasonalInput>) => seasonalAdvisories({ ...base, ...input }).map((a) => a.id);
  const warm = [8.5, 9, 10].map((meanC, i) => ({ time: i, meanC }));

  it('knows rough country boxes', () => {
    expect(countriesAt(52.35, 5.26)).toContain('NL');
    expect(countriesAt(51.34, 12.37)).toContain('DE');
    expect(countriesAt(-37.81, 144.96)).toEqual([]);
  });

  it('activates ticks only after the required warm days', () => {
    expect(ids({ dailyMeans: warm })).toContain('ticks');
    expect(ids({ dailyMeans: [{ time: 0, meanC: 6 }, ...warm.slice(1)] })).not.toContain('ticks');
    expect(ids({ dailyMeans: warm.slice(1) })).not.toContain('ticks');
  });

  it('flags grass seeds in summer, everywhere', () => {
    expect(ids({ month: 7, lat: -37.81, lng: 144.96 })).toContain('grassSeeds');
    expect(ids({ month: 9 })).not.toContain('grassSeeds');
  });

  it('limits the oak caterpillar note to NL/DE/BE', () => {
    expect(ids({ month: 5 })).toContain('oakProcessionary');
    expect(ids({ month: 5, lat: 4.71, lng: -74.07 })).not.toContain('oakProcessionary');
  });

  it('runs the NL breeding-season leash rule from 1 March to 15 July inclusive', () => {
    expect(ids({ month: 2, day: 28 })).not.toContain('breedingSeasonLeash');
    expect(ids({ month: 3, day: 1 })).toContain('breedingSeasonLeash');
    expect(ids({ month: 7, day: 15 })).toContain('breedingSeasonLeash');
    expect(ids({ month: 7, day: 16 })).not.toContain('breedingSeasonLeash');
    expect(ids({ month: 4, lat: 51.34, lng: 12.37 })).not.toContain('breedingSeasonLeash');
  });

  it('warns about salt and ice at frost or snow', () => {
    expect(ids({ minAirCNext12h: -1 })).toContain('winterPaws');
    expect(ids({ snowfallCmNext12h: 2 })).toContain('winterPaws');
    expect(ids({})).not.toContain('winterPaws');
  });

  it('words everything as advice, never as certainty', () => {
    const all = seasonalAdvisories({ ...base, month: 5, dailyMeans: warm, minAirCNext12h: -2 });
    for (const advisory of all) {
      expect(advisory.title).toMatch(/likely|may|season|Frost|Snow/i);
    }
  });
});

describe('verdict', () => {
  it('combines the hour score with air quality', () => {
    expect(verdictFor(scoreHour(hour(0)), 15)).toBe('good');
    expect(verdictFor(scoreHour(hour(0)), 65)).toBe('care');
    expect(verdictFor(scoreHour(hour(0)), 85)).toBe('wait');
    expect(verdictFor(scoreHour(hour(0, { precipProbability: 90 })), undefined)).toBe('wait');
  });
});


describe('summarise', () => {
  const conditions: Conditions = {
    lat: 52.4,
    lng: 5.3,
    timeZone: 'Europe/Amsterdam',
    fetchedAt: T0,
    hours: [hour(0, { airC: 30, shortwaveWm2: 850, windKmh: 3, uvIndex: 7 }), hour(1), hour(2)],
    rain15: [],
    dailyMeans: [],
    sunrise: undefined,
    sunset: undefined,
    airQuality: [{ time: T0, aqi: 25, pm25: 6, pm10: 10, ozone: 60, pollen: { grass: 60, birch: 5 } }],
  };

  it('builds the card model for a hot moment', () => {
    const summary = summarise(conditions, T0 + 5 * 60_000);
    expect(summary?.verdict).toBe('wait');
    expect(summary?.paw.asphaltSun.band).toBe('danger');
    expect(summary?.paw.grassSun.highC).toBeLessThan(summary?.paw.asphaltSun.lowC ?? 0);
    expect(summary?.uv.band).toBe('high');
    expect(summary?.air?.band).toBe('fair');
    expect(summary?.walkWindow?.start).toBe(T0 + HOUR);
  });

  it('uses the calendar date at the location, not the browser', () => {
    // 23:30 UTC on 15 July is already 16 July in Amsterdam (UTC+2) — after the
    // breeding-season end, which matters for the leash advisory.
    expect(localDate(Date.UTC(2026, 6, 15, 23, 30), 'Europe/Amsterdam')).toEqual({ month: 7, day: 16 });
  });
});

describe('short-range rain overrides the hourly probability', () => {
  it('drops "rain possible" when the next two hours are forecast dry', () => {
    const wet = hour(0, { precipProbability: 40 });
    expect(scoreHour(wet).score).toBe('ok');
    expect(scoreHour(wet, { shortRangeDry: true }).score).toBe('good');
  });
});

describe('card consistency', () => {
  it('never says "good now" and "next good stretch later" at once', () => {
    const conditions: Conditions = {
      lat: 52.4, lng: 5.3, timeZone: 'Europe/Amsterdam', fetchedAt: T0,
      hours: [hour(0, { precipProbability: 40 }), hour(1, { precipProbability: 40 }), hour(2)],
      rain15: Array.from({ length: 8 }, (_, i) => ({ time: T0 + i * 15 * 60_000, mm: 0 })),
      dailyMeans: [], sunrise: undefined, sunset: undefined, airQuality: undefined,
    };
    const summary = summarise(conditions, T0 + 60_000);
    expect(summary?.verdict).toBe('good');
    expect(summary?.walkWindow?.startsNow).toBe(true);
  });
});


describe('heat stress (general, not per path)', () => {
  it('bands the felt temperature', () => {
    expect([15, 20, 24, 28, 32].map(heatBand)).toEqual(['low', 'moderate', 'high', 'veryHigh', 'extreme']);
  });

  it('counts at night too: darkness does not make heat safe', () => {
    const night = hour(0, { airC: 30, apparentC: 33, shortwaveWm2: 0, isDay: false, uvIndex: 0 });
    const scored = scoreHour(night);
    expect(scored.reasons).toContain('heatExtreme');
    expect(scored.score).toBe('poor');
  });

  it('a very hot hour is "ok" at best, extreme heat is "poor"', () => {
    expect(scoreHour(hour(0, { apparentC: 29 })).score).toBe('ok');
    expect(scoreHour(hour(0, { apparentC: 33 })).score).toBe('poor');
  });
});

describe('pollen', () => {
  it('lists only moderate-or-higher types, high first', () => {
    expect(notablePollen({ grass: 60, birch: 70, alder: 5 })).toEqual([
      { kind: 'grass', grains: 60, level: 'high' },
      { kind: 'birch', grains: 70, level: 'moderate' },
    ]);
  });
  it('is empty where CAMS has no pollen (outside Europe)', () => {
    expect(notablePollen({})).toEqual([]);
  });
});
