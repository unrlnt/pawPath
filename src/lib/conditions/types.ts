/**
 * Normalised weather data, independent of the provider. The Open-Meteo source
 * maps its response into these shapes; every function in this folder is pure
 * and works on them alone, so it is testable without a network.
 *
 * All times are epoch milliseconds (UTC instants). Display formatting uses the
 * location's IANA time zone, carried in `Conditions.timeZone`.
 */

export interface HourPoint {
  readonly time: number;
  readonly airC: number;
  /** 0–100. */
  readonly precipProbability: number;
  readonly precipMm: number;
  readonly uvIndex: number;
  /** Global horizontal irradiance, W/m². */
  readonly shortwaveWm2: number;
  readonly windKmh: number;
  readonly isDay: boolean;
  readonly snowfallCm: number;
}

export interface RainSlot {
  /** Start of the 15-minute slot. */
  readonly time: number;
  readonly mm: number;
}

export interface DailyMean {
  /** Start of the local day. */
  readonly time: number;
  readonly meanC: number;
}

export interface AirQualityPoint {
  readonly time: number;
  /** European AQI. */
  readonly aqi: number;
  readonly pm25: number | undefined;
  readonly pm10: number | undefined;
  readonly ozone: number | undefined;
}

export interface Conditions {
  readonly lat: number;
  readonly lng: number;
  readonly timeZone: string;
  readonly fetchedAt: number;
  readonly hours: readonly HourPoint[];
  /** Empty where the provider has no 15-minute data. */
  readonly rain15: readonly RainSlot[];
  /** Includes past days, oldest first — the tick rule needs them. */
  readonly dailyMeans: readonly DailyMean[];
  readonly sunrise: number | undefined;
  readonly sunset: number | undefined;
  /** Undefined when the air-quality request failed: the card still works. */
  readonly airQuality: readonly AirQualityPoint[] | undefined;
}

/** The hour containing `now`, or the nearest one. */
export function hourAt(hours: readonly HourPoint[], now: number): HourPoint | undefined {
  let best: HourPoint | undefined;
  for (const hour of hours) {
    if (hour.time <= now) best = hour;
    else break;
  }
  return best ?? hours[0];
}

export function airQualityAt(
  points: readonly AirQualityPoint[] | undefined,
  now: number,
): AirQualityPoint | undefined {
  if (points === undefined) return undefined;
  let best: AirQualityPoint | undefined;
  for (const point of points) {
    if (point.time <= now) best = point;
    else break;
  }
  return best ?? points[0];
}
