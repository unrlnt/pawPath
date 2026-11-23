/**
 * "Add a stop" (Phase 9 follow-up, owner 2026-11-22): route via the nearest
 * drinking water, bag dispenser, bin or bench along the current route. Pure.
 */

import { ROUTE_STOP_MAX_OFF_ROUTE_M, ROUTE_STOP_SAME_PLACE_M } from '../../config';
import { progressAlong } from './edit';
import { haversineM } from './graph';
import type { LngLat } from './route';

/** Amenities the tiles carry, as the planner sees them. */
export type PoiKind = 'bench' | 'bin' | 'dogBin' | 'bagDispenser' | 'water' | 'offLeash';

export interface Poi {
  readonly kind: PoiKind;
  readonly at: LngLat;
  /** Tile feature id — the same area clipped into several tiles is one place. */
  readonly id?: number | string;
  readonly name?: string;
  /** For off-leash places: fenced dog park or open off-leash area. */
  readonly fenced?: boolean;
}

/** What the walker asks for, and which amenities satisfy it. */
export const STOP_KINDS = {
  water: { label: 'Water', icon: '💧', accepts: ['water'], noun: 'drinking-water tap' },
  bags: { label: 'Bags', icon: '🛍️', accepts: ['bagDispenser'], noun: 'poop-bag dispenser' },
  bin: { label: 'Bin', icon: '🗑️', accepts: ['dogBin', 'bin'], noun: 'bin' },
  bench: { label: 'Bench', icon: '🪑', accepts: ['bench'], noun: 'bench' },
} as const satisfies Record<string, { label: string; icon: string; accepts: readonly PoiKind[]; noun: string }>;

export type StopKind = keyof typeof STOP_KINDS;

export type StopChoice =
  | { readonly ok: true; readonly poi: Poi; readonly offRouteM: number }
  | { readonly ok: false; readonly reason: 'none-near' | 'already-on-route' };

/**
 * The amenity of the asked kind closest to the route line (ties: earlier on
 * the route), within `ROUTE_STOP_MAX_OFF_ROUTE_M`, that is not already a stop.
 */
export function chooseStop(
  kind: StopKind,
  line: readonly LngLat[],
  waypoints: readonly LngLat[],
  pois: readonly Poi[],
): StopChoice {
  const accepts: readonly PoiKind[] = STOP_KINDS[kind].accepts;
  let best: { poi: Poi; offRouteM: number; doneM: number } | undefined;
  let alreadyOnRoute = false;
  for (const poi of pois) {
    if (!accepts.includes(poi.kind)) continue;
    if (waypoints.some((w) => haversineM(w, poi.at) <= ROUTE_STOP_SAME_PLACE_M)) {
      alreadyOnRoute = true;
      continue;
    }
    const progress = progressAlong(line, poi.at);
    if (progress === undefined || progress.offRouteM > ROUTE_STOP_MAX_OFF_ROUTE_M) continue;
    if (
      best === undefined ||
      progress.offRouteM < best.offRouteM - 1 ||
      (Math.abs(progress.offRouteM - best.offRouteM) <= 1 && progress.doneM < best.doneM)
    ) {
      best = { poi, offRouteM: progress.offRouteM, doneM: progress.doneM };
    }
  }
  if (best !== undefined) return { ok: true, poi: best.poi, offRouteM: best.offRouteM };
  return { ok: false, reason: alreadyOnRoute ? 'already-on-route' : 'none-near' };
}
