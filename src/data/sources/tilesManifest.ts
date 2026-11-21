/**
 * Finds the current PawPath tile file.
 *
 * The build writes `manifest.json` next to an immutable, date-stamped
 * `.pmtiles` (CLAUDE.md §8). The manifest is the only thing that must not be
 * cached for long; everything it points at can be cached forever.
 */

import { TILES_MANIFEST_URL } from '../../config';

export interface TilesManifest {
  /** Absolute URL of the current `.pmtiles` file. */
  readonly url: string;
  readonly builtAt: string | undefined;
}

export type ManifestOutcome =
  | { readonly ok: true; readonly manifest: TilesManifest }
  | { readonly ok: false; readonly message: string };

export async function loadTilesManifest(signal?: AbortSignal): Promise<ManifestOutcome> {
  const manifestUrl = new URL(TILES_MANIFEST_URL, window.location.href);
  try {
    const response = await fetch(manifestUrl, {
      cache: 'no-cache',
      credentials: 'omit',
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) {
      return { ok: false, message: `Map data unavailable (HTTP ${response.status}).` };
    }
    const raw: unknown = await response.json();
    const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    if (typeof record['url'] !== 'string' || record['url'] === '') {
      return { ok: false, message: 'Map data manifest is malformed.' };
    }
    return {
      ok: true,
      manifest: {
        // Relative to the manifest, so tiles can live on any host or path.
        url: new URL(record['url'], manifestUrl).toString(),
        builtAt: typeof record['builtAt'] === 'string' ? record['builtAt'] : undefined,
      },
    };
  } catch (cause) {
    if (signal?.aborted === true) return { ok: false, message: 'Cancelled.' };
    console.warn('[tiles] manifest failed', cause);
    return { ok: false, message: 'Map data could not be loaded. Check your connection.' };
  }
}
