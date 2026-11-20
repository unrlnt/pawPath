/**
 * Proxy seam — a stub, deliberately.
 *
 * This forwards the SAME generated Overpass QL to a configurable endpoint and
 * parses the response client-side, exactly as the direct source does. There is
 * no server-side extraction and no server-side parsing: the €0 constraint and
 * the Cloudflare free tier's 10 ms CPU limit rule that out (CLAUDE.md §3).
 *
 * The proxy itself is NOT built. This exists so that turning it on later is a
 * config change rather than a refactor.
 *
 * Why a pass-through proxy is the preferred pre-launch configuration:
 *  - it can set a real `User-Agent`, which a browser cannot, and that is what
 *    instance operators use to identify and contact a client;
 *  - an edge cache collapses duplicate requests, so far less traffic reaches
 *    Overpass than every client querying directly.
 *
 * The open question is real: routing every user through Cloudflare concentrates
 * them behind a small set of IPs, and the usage policy's language on cloud
 * workers disfavours exactly that. Resolve it by asking the instance operator
 * before launch. Client-direct is the fallback and remains the default.
 */

import { PROXY_ENABLED, PROXY_ENDPOINT } from '../../config';
import type {
  TileFetchResult,
  TileRequest,
  TileSource,
  TilesFetchResult,
  TilesRequest,
} from './tileSource';
import { TileSourceError } from './tileSource';

export class ProxyTileSource implements TileSource {
  readonly id = 'proxy';

  private readonly endpoint: string;

  constructor(endpoint: string = PROXY_ENDPOINT) {
    this.endpoint = endpoint;
  }

  /** True when the flag is on AND an endpoint is configured. */
  static isConfigured(): boolean {
    return PROXY_ENABLED && PROXY_ENDPOINT !== '';
  }

  async fetchTiles(request: TilesRequest): Promise<TilesFetchResult> {
    const single = await this.fetchTile({
      tileId: request.tileIds[0] ?? '',
      layers: request.layers,
    });
    return {
      features: [],
      loadedTileIds: [],
      error: single.ok ? undefined : single.error,
      meta: single.meta,
    };
  }

  async fetchTile(request: TileRequest): Promise<TileFetchResult> {
    return {
      ok: false,
      tileId: request.tileId,
      bbox: undefined,
      error: new TileSourceError(
        'invalidRequest',
        `ProxyTileSource is a seam, not an implementation: no proxy is deployed at ` +
          `${this.endpoint === '' ? '<unset>' : this.endpoint}. ` +
          'See CLAUDE.md §11, Phase 2, "Proxy-ready seam".',
        this.endpoint === '' ? {} : { endpoint: this.endpoint },
      ),
      meta: {
        durationMs: 0,
        endpoint: this.endpoint === '' ? undefined : this.endpoint,
        attempts: 0,
        truncated: false,
        query: undefined,
        fromCache: false,
      },
    };
  }
}
