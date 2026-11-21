/**
 * Place search via Photon (CLAUDE.md §5).
 *
 * The public instance is fair-use, so: searches run when the user submits, at
 * most one per `PHOTON_MIN_INTERVAL_MS`, and never per keystroke. The floor is
 * enforced here, not in the UI, so no caller can bypass it.
 */

import {
  PHOTON_MIN_INTERVAL_MS,
  PHOTON_MIN_QUERY_LENGTH,
  PHOTON_RESULT_LIMIT,
  PHOTON_TIMEOUT_MS,
  PHOTON_URL,
} from '../../config';

export interface PlaceResult {
  readonly label: string;
  readonly lat: number;
  readonly lng: number;
}

export type SearchOutcome =
  | { readonly ok: true; readonly results: readonly PlaceResult[] }
  | { readonly ok: false; readonly message: string };

let lastRequestAt = 0;

/** Photon's label parts, most specific first, deduplicated. */
export function photonLabel(properties: Record<string, unknown>): string {
  const keys = ['name', 'street', 'city', 'state', 'country'];
  const parts: string[] = [];
  for (const key of keys) {
    const value = properties[key];
    if (typeof value === 'string' && value !== '' && !parts.includes(value)) parts.push(value);
  }
  return parts.join(', ');
}

export function parsePhotonResponse(raw: unknown): PlaceResult[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const features = (raw as { features?: unknown }).features;
  if (!Array.isArray(features)) return [];
  const results: PlaceResult[] = [];
  for (const feature of features as unknown[]) {
    if (typeof feature !== 'object' || feature === null) continue;
    const { geometry, properties } = feature as { geometry?: unknown; properties?: unknown };
    const coordinates = (geometry as { coordinates?: unknown } | undefined)?.coordinates;
    if (!Array.isArray(coordinates)) continue;
    const [lng, lat] = coordinates as unknown[];
    if (typeof lat !== 'number' || typeof lng !== 'number') continue;
    const label =
      typeof properties === 'object' && properties !== null
        ? photonLabel(properties as Record<string, unknown>)
        : '';
    if (label === '') continue;
    results.push({ label, lat, lng });
  }
  return results;
}

export async function searchPlaces(
  query: string,
  near?: { lat: number; lng: number },
  signal?: AbortSignal,
): Promise<SearchOutcome> {
  const trimmed = query.trim();
  if (trimmed.length < PHOTON_MIN_QUERY_LENGTH) {
    return { ok: false, message: `Type at least ${PHOTON_MIN_QUERY_LENGTH} letters.` };
  }

  const wait = lastRequestAt + PHOTON_MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();

  const url = new URL(PHOTON_URL);
  url.searchParams.set('q', trimmed);
  url.searchParams.set('limit', String(PHOTON_RESULT_LIMIT));
  if (near !== undefined) {
    // Bias, not filter: nearby results rank first, the world stays searchable.
    url.searchParams.set('lat', near.lat.toFixed(3));
    url.searchParams.set('lon', near.lng.toFixed(3));
  }

  const timeout = AbortSignal.timeout(PHOTON_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      credentials: 'omit',
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    });
    if (!response.ok) return { ok: false, message: `Search failed (HTTP ${response.status}).` };
    return { ok: true, results: parsePhotonResponse(await response.json()) };
  } catch (cause) {
    if (signal?.aborted === true) return { ok: true, results: [] };
    const name = cause instanceof Error ? cause.name : '';
    console.warn('[search] failed', cause);
    return {
      ok: false,
      message: name === 'TimeoutError' ? 'Search timed out.' : 'Search is unavailable right now.',
    };
  }
}
