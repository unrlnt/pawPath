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

/* ------------------------------------------------------------------ *
 * Backup file of saved walks (owner, 2026-11-28: no accounts — phone
 * storage plus a file the walker keeps, e.g. to move to a new phone).
 * ------------------------------------------------------------------ */

const BACKUP_FORMAT = 'pawpath-walks';
const BACKUP_VERSION = 1;

/** The backup file's text: JSON with a format marker, so a wrong file is refused. */
export function walksBackup(routes: readonly SavedRoute[], now = Date.now()): string {
  return `${JSON.stringify({ format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: new Date(now).toISOString(), walks: routes }, null, 1)}\n`;
}

const isLngLat = (p: unknown): p is LngLat =>
  Array.isArray(p) &&
  p.length === 2 &&
  typeof p[0] === 'number' &&
  typeof p[1] === 'number' &&
  Number.isFinite(p[0]) &&
  Number.isFinite(p[1]) &&
  Math.abs(p[0]) <= 180 &&
  Math.abs(p[1]) <= 90;

/**
 * Walks from a backup file, each one checked (a file can come from anywhere).
 * `undefined` when the text is not a PawPath backup at all; invalid walks
 * inside a real backup are dropped.
 */
export function parseWalksBackup(text: string): SavedRoute[] | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null) return undefined;
  const file = raw as { format?: unknown; walks?: unknown };
  if (file.format !== BACKUP_FORMAT || !Array.isArray(file.walks)) return undefined;
  const walks: SavedRoute[] = [];
  for (const w of file.walks as unknown[]) {
    if (typeof w !== 'object' || w === null) continue;
    const r = w as Partial<Record<keyof SavedRoute, unknown>>;
    if (typeof r.id !== 'string' || r.id === '' || typeof r.name !== 'string') continue;
    if (!Array.isArray(r.waypoints) || r.waypoints.length < 2 || r.waypoints.length > ROUTE_MAX_WAYPOINTS) continue;
    if (!r.waypoints.every(isLngLat)) continue;
    walks.push({
      id: r.id.slice(0, 40),
      name: r.name.trim().slice(0, 60) || 'My walk',
      waypoints: r.waypoints as LngLat[],
      roundTrip: r.roundTrip === true,
      savedAt: typeof r.savedAt === 'number' && Number.isFinite(r.savedAt) ? r.savedAt : Date.now(),
    });
  }
  return walks;
}

/** Adds restored walks to the saved ones: same id = already there; newest first, capped. */
export function mergeWalks(
  existing: readonly SavedRoute[],
  incoming: readonly SavedRoute[],
  max: number,
): { walks: SavedRoute[]; added: number; skipped: number } {
  const known = new Set(existing.map((r) => r.id));
  const fresh = incoming.filter((r) => !known.has(r.id) && (known.add(r.id), true));
  const all = [...existing, ...fresh].sort((a, b) => b.savedAt - a.savedAt);
  const walks = all.slice(0, max);
  const kept = new Set(walks.map((r) => r.id));
  const added = fresh.filter((r) => kept.has(r.id)).length;
  return { walks, added, skipped: incoming.length - added };
}
