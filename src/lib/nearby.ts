/**
 * "Find nearby": the closest bins, dispensers, benches, taps or off-leash
 * places to a point, with distance and a compass direction. Pure.
 *
 * Off-leash means only what the tiles mark off-leash or a dog park — never
 * `dog=yes`, whose leash rule is unknown (CLAUDE.md §6).
 */

import { NEARBY_RESULTS } from '../config';
import { haversineM } from './routing/graph';
import type { LngLat } from './routing/route';
import type { Poi, PoiKind } from './routing/stops';

export const NEARBY_KINDS = {
  bin: { label: 'Bin', icon: '🗑️', accepts: ['bin', 'dogBin'], noun: 'bin' },
  dogBin: { label: 'Dog-waste bin', icon: '🐕', accepts: ['dogBin'], noun: 'dog-waste bin' },
  bags: { label: 'Bag dispenser', icon: '🛍️', accepts: ['bagDispenser'], noun: 'poop-bag dispenser' },
  bench: { label: 'Bench', icon: '🪑', accepts: ['bench'], noun: 'bench' },
  water: { label: 'Drinking water', icon: '💧', accepts: ['water'], noun: 'drinking-water tap' },
  offLeash: { label: 'Off-leash area', icon: '🐾', accepts: ['offLeash'], noun: 'off-leash area' },
} as const satisfies Record<string, { label: string; icon: string; accepts: readonly PoiKind[]; noun: string }>;

export type NearbyKind = keyof typeof NEARBY_KINDS;
export const NEARBY_KIND_KEYS = Object.keys(NEARBY_KINDS) as NearbyKind[];

export interface NearbyResult {
  readonly poi: Poi;
  readonly distanceM: number;
  /** "north-east" etc., from the starting point. */
  readonly direction: string;
}

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'] as const;

/** Initial bearing from a to b as one of eight compass words. */
export function compassWord(from: LngLat, to: LngLat): string {
  const rad = Math.PI / 180;
  const [lng1, lat1] = [from[0] * rad, from[1] * rad];
  const [lng2, lat2] = [to[0] * rad, to[1] * rad];
  const y = Math.sin(lng2 - lng1) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lng2 - lng1);
  const deg = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  return COMPASS[Math.round(deg / 45) % 8] as string;
}

/** The closest places of a kind, nearest first (straight-line distance). */
export function nearest(pois: readonly Poi[], from: LngLat, kind: NearbyKind, n = NEARBY_RESULTS): NearbyResult[] {
  const accepts: readonly PoiKind[] = NEARBY_KINDS[kind].accepts;
  return pois
    .filter((p) => accepts.includes(p.kind))
    .map((poi) => ({ poi, distanceM: haversineM(from, poi.at) }))
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, n)
    .map((r) => ({ ...r, direction: compassWord(from, r.poi.at) }));
}
