/** Pure helpers for editing a route and following it on a walk. */

import { haversineM } from './graph';
import type { LngLat } from './route';

/** Local metric projection around a point — fine at dog-walk scale. */
function project(origin: LngLat): (p: LngLat) => [number, number] {
  const kx = 111_320 * Math.cos((origin[1] * Math.PI) / 180);
  return (p) => [(p[0] - origin[0]) * kx, (p[1] - origin[1]) * 111_320];
}

/** Closest point on segment a–b to p, as fraction t and distance in metres. */
function onSegment(p: LngLat, a: LngLat, b: LngLat): { t: number; distanceM: number } {
  const to = project(p);
  const [ax, ay] = to(a);
  const [bx, by] = to(b);
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
  return { t, distanceM: Math.hypot(ax + t * dx, ay + t * dy) };
}

/**
 * Where a new via point belongs: the position in the waypoint list that adds
 * the least straight-line detour. Dragging the route line or tapping it uses
 * this, so the new point lands between the two stops it sits between.
 */
export function bestInsertIndex(waypoints: readonly LngLat[], point: LngLat): number {
  if (waypoints.length < 2) return waypoints.length;
  let best = waypoints.length;
  let bestCost = Number.POSITIVE_INFINITY;
  for (let i = 1; i < waypoints.length; i += 1) {
    const a = waypoints[i - 1];
    const b = waypoints[i];
    if (a === undefined || b === undefined) continue;
    const cost = haversineM(a, point) + haversineM(point, b) - haversineM(a, b);
    if (cost < bestCost) {
      bestCost = cost;
      best = i;
    }
  }
  return best;
}

export interface Progress {
  /** Metres still to walk along the route from the nearest point on it. */
  readonly remainingM: number;
  readonly doneM: number;
  /** Distance from the route line. */
  readonly offRouteM: number;
}

/** Where a position is along a route line ("walk it" mode). */
export function progressAlong(line: readonly LngLat[], position: LngLat): Progress | undefined {
  if (line.length < 2) return undefined;
  const lengths: number[] = [];
  let total = 0;
  for (let i = 1; i < line.length; i += 1) {
    const len = haversineM(line[i - 1] as LngLat, line[i] as LngLat);
    lengths.push(len);
    total += len;
  }
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestDone = 0;
  let before = 0;
  for (let i = 1; i < line.length; i += 1) {
    const segLen = lengths[i - 1] ?? 0;
    const { t, distanceM } = onSegment(position, line[i - 1] as LngLat, line[i] as LngLat);
    if (distanceM < bestDistance) {
      bestDistance = distanceM;
      bestDone = before + t * segLen;
    }
    before += segLen;
  }
  return { remainingM: Math.max(0, total - bestDone), doneM: bestDone, offRouteM: bestDistance };
}

/** "1.4 km" / "650 m" */
export function formatDistance(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(m >= 10_000 ? 0 : 1)} km` : `${Math.round(m / 10) * 10} m`;
}

/** "1 h 20 min" / "35 min" */
export function formatMinutes(min: number): string {
  if (min < 60) return `${Math.max(1, Math.round(min))} min`;
  const h = Math.floor(min / 60);
  const rest = Math.round(min - h * 60);
  return rest === 0 ? `${h} h` : `${h} h ${rest} min`;
}
