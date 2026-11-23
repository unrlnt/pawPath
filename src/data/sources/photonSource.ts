/**
 * Place search via Photon (CLAUDE.md §5) — also used for suggestions while
 * typing, which is what Photon is built for.
 *
 * The public instance is fair-use, so the UI debounces, and this source adds
 * what no caller can bypass: at most one request per `PHOTON_MIN_INTERVAL_MS`
 * and an in-memory cache of recent queries.
 */

import {
  PHOTON_CACHE_SIZE,
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
const cache = new Map<string, readonly PlaceResult[]>();

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
    // Photon often returns the same place twice (node and area); one is enough.
    if (label === '' || results.some((r) => r.label === label)) continue;
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

  const key = `${trimmed.toLowerCase()}|${near === undefined ? '' : `${near.lat.toFixed(2)},${near.lng.toFixed(2)}`}`;
  const cached = cache.get(key);
  if (cached !== undefined) return { ok: true, results: cached };

  const wait = lastRequestAt + PHOTON_MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  if (signal?.aborted === true) return { ok: true, results: [] };
  lastRequestAt = Date.now();

  const url = new URL(PHOTON_URL);
  url.searchParams.set('q', trimmed);
  url.searchParams.set('limit', String(PHOTON_RESULT_LIMIT));
  if (near !== undefined) {
    // Bias, not filter: nearby results rank first, the world stays searchable.
    url.searchParams.set('lat', near.lat.toFixed(3));
    url.searchParams.set('lon', near.lng.toFixed(3));
  }

  // One controller for both the caller's abort and the timeout. Not
  // AbortSignal.any/timeout: Safari before 17.4 lacks them, and every search
  // would then fail there.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, PHOTON_TIMEOUT_MS);
  const onAbort = (): void => controller.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    const response = await fetch(url, { credentials: 'omit', signal: controller.signal });
    if (!response.ok) return { ok: false, message: `Search failed (HTTP ${response.status}).` };
    const results = parsePhotonResponse(await response.json());
    cache.set(key, results);
    if (cache.size > PHOTON_CACHE_SIZE) cache.delete(cache.keys().next().value as string);
    return { ok: true, results };
  } catch (cause) {
    // Re-read: TypeScript narrowed `aborted` to false above, but it can change.
    if ((signal as AbortSignal | undefined)?.aborted === true && !timedOut) return { ok: true, results: [] };
    console.warn('[search] failed', cause);
    return { ok: false, message: timedOut ? 'Search timed out.' : 'Search is unavailable right now.' };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
