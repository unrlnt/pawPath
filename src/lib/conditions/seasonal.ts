/**
 * Seasonal advisories (CLAUDE.md §7): date-and-temperature rules, no extra
 * data source. All ADVISORY — worded as "may" and "likely", never as fact.
 */

import { COUNTRY_BOXES, SEASONAL_RULES } from '../../config';
import type { DailyMean } from './types';

export type Severity = 'low' | 'moderate' | 'high';

export type AdvisoryId = 'grassSeeds' | 'ticks' | 'oakProcessionary' | 'breedingSeasonLeash' | 'winterPaws';

export interface Advisory {
  readonly id: AdvisoryId;
  readonly severity: Severity;
  readonly title: string;
  readonly detail: string;
}

export interface SeasonalInput {
  /** Local calendar date at the location. */
  readonly month: number;
  readonly day: number;
  readonly lat: number;
  readonly lng: number;
  /** Oldest first; must include the most recent days. */
  readonly dailyMeans: readonly DailyMean[];
  /** Lowest air temperature in the coming hours. */
  readonly minAirCNext12h: number | undefined;
  /** Total snowfall in the coming hours, cm. */
  readonly snowfallCmNext12h: number;
}

export function countriesAt(lat: number, lng: number): string[] {
  return Object.entries(COUNTRY_BOXES)
    .filter(([, b]) => lat >= b.south && lat <= b.north && lng >= b.west && lng <= b.east)
    .map(([code]) => code);
}

const inMonths = (month: number, start: number, end: number): boolean => month >= start && month <= end;

const onOrAfter = (m: number, d: number, at: { month: number; day: number }): boolean =>
  m > at.month || (m === at.month && d >= at.day);

export function seasonalAdvisories(input: SeasonalInput): Advisory[] {
  const { month, day } = input;
  const countries = countriesAt(input.lat, input.lng);
  const advisories: Advisory[] = [];

  const { ticks } = SEASONAL_RULES;
  const recent = input.dailyMeans.slice(-ticks.consecutiveDays);
  if (recent.length === ticks.consecutiveDays && recent.every((d) => d.meanC > ticks.activationTempC)) {
    const peak = (ticks.peakMonths as readonly number[]).includes(month);
    advisories.push({
      id: 'ticks',
      severity: peak ? 'high' : 'moderate',
      title: 'Ticks are likely active',
      detail: `It has been above ${ticks.activationTempC} °C for ${ticks.consecutiveDays} days. Check your dog's coat after walks through grass and undergrowth.`,
    });
  }

  const { grassSeeds } = SEASONAL_RULES;
  if (inMonths(month, grassSeeds.startMonth, grassSeeds.endMonth)) {
    advisories.push({
      id: 'grassSeeds',
      severity: 'moderate',
      title: 'Grass seed season',
      detail: 'Awns can work into paws, ears and noses. Long dry grass is best avoided; check between the toes after a walk.',
    });
  }

  const { oakProcessionary } = SEASONAL_RULES;
  if (
    inMonths(month, oakProcessionary.startMonth, oakProcessionary.endMonth) &&
    countries.some((c) => (oakProcessionary.countries as readonly string[]).includes(c))
  ) {
    const peak = (oakProcessionary.peakMonths as readonly number[]).includes(month);
    advisories.push({
      id: 'oakProcessionary',
      severity: peak ? 'high' : 'moderate',
      title: 'Oak processionary caterpillars may be around',
      detail: 'Their hairs can badly hurt a dog’s mouth and tongue. Keep away from oak trunks with silky nests and from any cordoned-off trees.',
    });
  }

  const { breedingSeasonLeash: breeding } = SEASONAL_RULES;
  if (
    onOrAfter(month, day, breeding.start) &&
    !onOrAfter(month, day, { month: breeding.end.month, day: breeding.end.day + 1 }) &&
    countries.some((c) => (breeding.countries as readonly string[]).includes(c))
  ) {
    advisories.push({
      id: 'breedingSeasonLeash',
      severity: 'moderate',
      title: 'Breeding season: leash in nature areas',
      detail: 'Until 15 July, many Dutch nature areas require dogs on a leash to protect ground-nesting birds — even in usual off-leash spots. Check local signs.',
    });
  }

  const { winterPaws } = SEASONAL_RULES;
  const frost = input.minAirCNext12h !== undefined && input.minAirCNext12h <= winterPaws.frostAtOrBelowC;
  const snow = input.snowfallCmNext12h >= winterPaws.snowfallCm;
  if (frost || snow) {
    advisories.push({
      id: 'winterPaws',
      severity: snow ? 'moderate' : 'low',
      title: snow ? 'Snow and road salt likely' : 'Frost: ice and road salt likely',
      detail: 'Salt and grit sting and dry out pads, and ice can cut. Rinse paws after the walk; paw balm helps.',
    });
  }

  const order: Record<Severity, number> = { high: 0, moderate: 1, low: 2 };
  return advisories.sort((a, b) => order[a.severity] - order[b.severity]);
}
