/**
 * Route persistence and exchange: saved routes (localStorage via the caller),
 * share links and GPX. Pure functions; no storage access here.
 */

import { ROUTE_MAX_WAYPOINTS } from '../../config';
import type { LngLat } from './route';

export interface SavedRoute {
  readonly id: string;
  readonly name: string;
  readonly waypoints: readonly LngLat[];
  readonly roundTrip: boolean;
  readonly savedAt: number;
}

const COORD_DECIMALS = 5; // ~1 m — plenty for a waypoint

/** `#route=52.36200,5.22350;52.37050,5.21860[;loop]` — lat,lng pairs. */
export function encodeRouteHash(waypoints: readonly LngLat[], roundTrip: boolean): string {
  const pairs = waypoints.map(([lng, lat]) => `${lat.toFixed(COORD_DECIMALS)},${lng.toFixed(COORD_DECIMALS)}`);
  return `#route=${pairs.join(';')}${roundTrip ? ';loop' : ''}`;
}

export function decodeRouteHash(hash: string): { waypoints: LngLat[]; roundTrip: boolean } | undefined {
  const match = /^#?route=([^&]+)/.exec(hash);
  if (match?.[1] === undefined) return undefined;
  const parts = decodeURIComponent(match[1]).split(';');
  const roundTrip = parts[parts.length - 1] === 'loop';
  const waypoints: LngLat[] = [];
  for (const part of roundTrip ? parts.slice(0, -1) : parts) {
    const [latText, lngText] = part.split(',');
    const lat = Number(latText);
    const lng = Number(lngText);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return undefined;
    waypoints.push([lng, lat]);
  }
  return waypoints.length >= 2 && waypoints.length <= ROUTE_MAX_WAYPOINTS ? { waypoints, roundTrip } : undefined;
}

const escapeXml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** GPX 1.1 track — opens in Komoot, OsmAnd, Garmin, Strava and friends. */
export function toGpx(name: string, line: readonly LngLat[]): string {
  const points = line
    .map(([lng, lat]) => `      <trkpt lat="${lat.toFixed(6)}" lon="${lng.toFixed(6)}"/>`)
    .join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="PawPath" xmlns="http://www.topografix.com/GPX/1/1">',
    `  <metadata><name>${escapeXml(name)}</name></metadata>`,
    `  <trk><name>${escapeXml(name)}</name><trkseg>`,
    points,
    '  </trkseg></trk>',
    '</gpx>',
    '',
  ].join('\n');
}

export function isSavedRouteList(value: unknown): value is SavedRoute[] {
  return (
    Array.isArray(value) &&
    value.every(
      (r) =>
        typeof r === 'object' &&
        r !== null &&
        typeof (r as SavedRoute).id === 'string' &&
        typeof (r as SavedRoute).name === 'string' &&
        Array.isArray((r as SavedRoute).waypoints),
    )
  );
}
