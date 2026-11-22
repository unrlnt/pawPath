/**
 * Short-range rain outlook from 15-minute precipitation (CLAUDE.md §7).
 * Model-based, not radar — worded as "expected", never as certainty.
 */

import { RAIN_WET_MM_PER_15MIN, RAIN_WINDOW_MINUTES } from '../../config';
import type { RainSlot } from './types';

export type RainOutlook =
  | { readonly kind: 'dry'; readonly forMinutes: number }
  | { readonly kind: 'rainSoon'; readonly inMinutes: number }
  | { readonly kind: 'rainingNow'; readonly dryInMinutes: number | undefined };

const SLOT_MS = 15 * 60_000;

/** Undefined when there is no 15-minute data for the window (outside the model). */
export function rainOutlook(
  slots: readonly RainSlot[],
  now: number,
  horizonMinutes: number = RAIN_WINDOW_MINUTES,
): RainOutlook | undefined {
  const limit = now + horizonMinutes * 60_000;
  const window = slots.filter((s) => s.time + SLOT_MS > now && s.time < limit);
  if (window.length === 0) return undefined;

  const wet = (slot: RainSlot): boolean => slot.mm >= RAIN_WET_MM_PER_15MIN;
  const minutesUntil = (time: number): number => Math.max(0, Math.round((time - now) / 60_000));
  const [current] = window;

  if (current !== undefined && wet(current)) {
    const dry = window.find((slot) => !wet(slot));
    return { kind: 'rainingNow', dryInMinutes: dry === undefined ? undefined : minutesUntil(dry.time) };
  }
  const firstWet = window.find(wet);
  if (firstWet !== undefined) return { kind: 'rainSoon', inMinutes: minutesUntil(firstWet.time) };
  return { kind: 'dry', forMinutes: horizonMinutes };
}
