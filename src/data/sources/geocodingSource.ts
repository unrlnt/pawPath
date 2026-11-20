/**
 * Place search via Nominatim, for when geolocation is denied or the user wants
 * to look somewhere else.
 *
 * Nominatim's usage policy is stricter than Overpass's: at most one request per
 * second, no heavy use, and clients must identify themselves. A browser cannot
 * set `User-Agent`, so we identify via the `Referer`/`Origin` the browser sends
 * and an explicit `email`-style contact in the query when one is configured.
 * The one-request-per-second floor is enforced here rather than trusted to the
 * debounce in the UI — a debounce is a UX device, not a rate limiter.
 */

import {
  APP_CONTACT_URL,
  APP_CONTACT_URL_UNSET,
  APP_NAME,
  NOMINATIM_MIN_INTERVAL_MS,
  NOMINATIM_RESULT_LIMIT,
  NOMINATIM_TIMEOUT_MS,
  NOMINATIM_URL,
} from '../../config';

export interface GeocodeResult {
  readonly label: string;
  readonly lat: number;
  readonly lng: number;
}

export type GeocodeOutcome =
  | { readonly ok: true; readonly results: readonly GeocodeResult[] }
  | { readonly ok: false; readonly message: string };

interface NominatimEntry {
  readonly display_name?: unknown;
  readonly lat?: unknown;
  readonly lon?: unknown;
}

let lastRequestAt = 0;
let queue: Promise<unknown> = Promise.resolve();

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Serialises searches and enforces the one-per-second floor.
 *
 * Requests queue rather than being dropped: a user typing fast should get the
 * result for what they finally typed, not a rejection.
 */
async function rateLimited<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const since = Date.now() - lastRequestAt;
    if (since < NOMINATIM_MIN_INTERVAL_MS) {
      await sleep(NOMINATIM_MIN_INTERVAL_MS - since);
    }
    try {
      return await task();
    } finally {
      lastRequestAt = Date.now();
    }
  });
  // Keep the chain alive even when one task rejects.
  queue = run.catch(() => undefined);
  return run;
}

export async function searchPlaces(
  query: string,
  signal?: AbortSignal,
): Promise<GeocodeOutcome> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return { ok: true, results: [] };

  return rateLimited(async () => {
    const url = new URL(NOMINATIM_URL);
    url.searchParams.set('q', trimmed);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', String(NOMINATIM_RESULT_LIMIT));
    url.searchParams.set('addressdetails', '0');
    if (APP_CONTACT_URL !== APP_CONTACT_URL_UNSET) {
      // Nominatim asks for a contact so operators can reach abusive clients.
      url.searchParams.set('email', APP_CONTACT_URL);
    }

    const timeout = AbortSignal.timeout(NOMINATIM_TIMEOUT_MS);
    const composed =
      signal === undefined ? timeout : AbortSignal.any([signal, timeout]);

    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        credentials: 'omit',
        signal: composed,
      });
      if (!response.ok) {
        return {
          ok: false as const,
          message: `Place search failed (HTTP ${response.status}).`,
        };
      }
      const raw: unknown = await response.json();
      if (!Array.isArray(raw)) {
        return { ok: false as const, message: 'Place search returned an unexpected response.' };
      }

      const results: GeocodeResult[] = [];
      for (const entry of raw as NominatimEntry[]) {
        const lat = Number(entry.lat);
        const lng = Number(entry.lon);
        const label = typeof entry.display_name === 'string' ? entry.display_name : '';
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || label === '') continue;
        results.push({ label, lat, lng });
      }
      return { ok: true as const, results };
    } catch (cause) {
      if (signal?.aborted === true) return { ok: true as const, results: [] };
      const name = cause instanceof Error ? cause.name : typeof cause;
      const message = cause instanceof Error ? cause.message : String(cause);
      console.warn(`[${APP_NAME}] place search failed`, { cause });
      return {
        ok: false as const,
        message:
          name === 'TimeoutError'
            ? 'Place search timed out.'
            : `Place search unavailable (${name}: ${message || 'no message'}).`,
      };
    }
  });
}
