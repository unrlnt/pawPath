/**
 * The data-layer contract (CLAUDE.md §3).
 *
 * UI code depends on THIS FILE ONLY — never on Overpass, never on `fetch`.
 * A future `WorkerTileSource` backed by a shared server-side cache implements
 * the same interface and drops in without any UI change.
 *
 * Implementations never throw raw fetch/parse errors: every failure comes back
 * as a `TileSourceError` inside an `ok: false` result.
 */

import type { BBox, TileId } from '../../lib/tiles';
import type { FeatureLevel, LayerKey } from './layers';

// Note: this file deliberately imports no implementation, so implementations
// can depend on it without a cycle. Import concrete sources from `./index`.

/* ------------------------------------------------------------------ *
 * Normalised features
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Provenance
 *
 * A type-level seam, nothing more. Today every feature is 'osm'; Phase 8 adds
 * official municipal/national data on top, and this is what lets a layer hold
 * features from more than one provider without anything having to change shape.
 *
 * NOT a source registry. There is no discovery, no per-region fetching and no
 * provider plumbing — see CLAUDE.md §11, Phase 8.
 * ------------------------------------------------------------------ */

/** Extend the union when a provider is actually added, not before. */
export type FeatureSource = 'osm';

export interface SourceAttribution {
  /** Shown in the attribution footer. */
  readonly label: string;
  /** Licence the data is used under. */
  readonly licence: string;
  readonly url: string;
}

/**
 * Licence string per source. Attribution is a licence requirement, not a
 * nicety (CLAUDE.md §10), so a new provider registers here as it is added —
 * and every source present in the rendered features must be credited.
 */
export const SOURCE_ATTRIBUTION: Readonly<Record<FeatureSource, SourceAttribution>> = {
  osm: {
    label: '© OpenStreetMap contributors',
    licence: 'ODbL 1.0',
    url: 'https://www.openstreetmap.org/copyright',
  },
};

/** `[lng, lat]`, GeoJSON axis order. */
export type LngLat = readonly [lng: number, lat: number];

export interface FeatureGeometry {
  /** Closed ways become `Polygon`; open ways stay `LineString`. */
  readonly type: 'LineString' | 'Polygon';
  readonly coordinates: readonly LngLat[];
}

/**
 * One normalised map feature. Deliberately flat: the render layer should never
 * need to reach back into raw OSM semantics — `level` is already derived.
 * `tags` is kept for popups and for debugging in the recon page.
 */
export interface Feature {
  /**
   * Unique across sources — source-prefixed, e.g. `osm:way/12345`. Two
   * providers can describe the same real-world object with the same local id,
   * so nothing may key a feature on an unprefixed id.
   */
  readonly id: string;
  /**
   * Which provider this came from. Required, so a second source cannot be added
   * without every consumer having to account for provenance.
   *
   * One layer may hold features from several sources at once: consumers merge
   * by concatenating and must not assume a single source, a single licence, or
   * that one source's absence means the layer is empty.
   */
  readonly source: FeatureSource;
  readonly layer: LayerKey;
  /** Representative point: the node itself, or the centre of a way/relation. */
  readonly lat: number;
  readonly lng: number;
  /** Present only when the query asked for geometry and the element is a way. */
  readonly geometry?: FeatureGeometry;
  /** Derived level for symbol encoding. Absent on flat layers. */
  readonly level?: FeatureLevel;
  readonly tags: Readonly<Record<string, string>>;
}

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

export type TileSourceErrorKind =
  /** Client abort or upstream 504 / server-side query timeout. */
  | 'timeout'
  /** HTTP 429, or the instance reporting slot exhaustion. */
  | 'rateLimited'
  /** 5xx, or an Overpass `remark` describing a runtime error. */
  | 'server'
  /** DNS, CORS, offline — anything that stopped the request from completing. */
  | 'network'
  /** 200 with a body that is not the JSON shape we expect. */
  | 'parse'
  /** The caller's AbortSignal fired. */
  | 'aborted'
  /** Every instance was tried and every one failed. */
  | 'exhausted'
  /** The session's Overpass request budget is spent. */
  | 'budgetExhausted'
  /**
   * Our own fault: an unknown layer key, a bad tile id, malformed QL (400), or
   * an `Accept` header Overpass cannot satisfy (406). Never retried, never
   * rotated — every instance answers these identically.
   */
  | 'invalidRequest';

export interface TileSourceErrorDetails {
  readonly endpoint?: string;
  readonly status?: number;
  readonly cause?: unknown;
  /** Milliseconds from request start to failure. */
  readonly elapsedMs?: number;
  /** Whether any HTTP response arrived at all — the CORS/DNS discriminator. */
  readonly responseReceived?: boolean;
  /** `name` of the underlying error, e.g. `TypeError`, `AbortError`. */
  readonly errorName?: string;
}

/**
 * Every failure carries enough context to diagnose it without a repro.
 *
 * The Phase 1 lesson: "Could not reach X" collapsed CORS rejections, DNS
 * failures, offline states and timeouts into one string, and we spent a session
 * believing the instances were down when they were not. `elapsedMs`,
 * `responseReceived` and `errorName` are what tell those cases apart.
 */
export class TileSourceError extends Error {
  readonly kind: TileSourceErrorKind;
  readonly endpoint: string | undefined;
  readonly status: number | undefined;
  readonly cause: unknown;
  readonly elapsedMs: number | undefined;
  readonly responseReceived: boolean | undefined;
  readonly errorName: string | undefined;

  constructor(kind: TileSourceErrorKind, message: string, details: TileSourceErrorDetails = {}) {
    super(message);
    this.name = 'TileSourceError';
    this.kind = kind;
    this.endpoint = details.endpoint;
    this.status = details.status;
    this.cause = details.cause;
    this.elapsedMs = details.elapsedMs;
    this.responseReceived = details.responseReceived;
    this.errorName = details.errorName;
  }

  /** Whether trying again — here or elsewhere — could plausibly help. */
  get isRetryable(): boolean {
    return (
      this.kind === 'timeout' ||
      this.kind === 'rateLimited' ||
      this.kind === 'server' ||
      this.kind === 'network'
    );
  }
}

/* ------------------------------------------------------------------ *
 * Requests and results
 * ------------------------------------------------------------------ */

/**
 * Progress note from a source while a request is in flight — a retry, a wait
 * for a slot, a rotation.
 *
 * Sources report these so the UI can say "retrying (2/5)" instead of appearing
 * to hang. A silent 30-second backoff is indistinguishable from a crash.
 */
export interface TileProgress {
  readonly message: string;
  readonly endpoint: string | undefined;
}

export interface TileRequest {
  readonly tileId: TileId;
  /** Only enabled layers are ever requested (CLAUDE.md §8). */
  readonly layers: readonly LayerKey[];
  /**
   * Force geometry on or off. Omitted, each layer uses its own default:
   * polygons ask for geometry, amenities ask for centres only.
   */
  readonly includeGeometry?: boolean;
  readonly signal?: AbortSignal;
  /** Called as the source retries, waits or rotates. Never for success. */
  readonly onProgress?: (progress: TileProgress) => void;
}

export interface TileFetchMeta {
  readonly durationMs: number;
  /** Instance that answered, or the last one tried. */
  readonly endpoint: string | undefined;
  /** Number of instances tried, including the successful one. */
  readonly attempts: number;
  /** The result hit the element cap and is therefore incomplete. */
  readonly truncated: boolean;
  /** Generated Overpass QL, kept for the recon page and debugging. */
  readonly query: string | undefined;
  /** True once the Phase 2 cache layer serves this without a network call. */
  readonly fromCache: boolean;
}

export type TileFetchResult =
  | {
      readonly ok: true;
      readonly tileId: TileId;
      readonly bbox: BBox;
      readonly features: readonly Feature[];
      readonly meta: TileFetchMeta;
    }
  | {
      readonly ok: false;
      readonly tileId: TileId;
      readonly bbox: BBox | undefined;
      readonly error: TileSourceError;
      readonly meta: TileFetchMeta;
    };

/* ------------------------------------------------------------------ *
 * Batched requests
 * ------------------------------------------------------------------ */

export interface TilesRequest {
  /** Tiles to cover, ideally contiguous — they are fetched as one query. */
  readonly tileIds: readonly TileId[];
  readonly layers: readonly LayerKey[];
  readonly includeGeometry?: boolean;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: TileProgress) => void;
}

export interface TilesFetchResult {
  /** Features for every tile that succeeded, already normalised. */
  readonly features: readonly Feature[];
  /** Tiles whose data is now present (from cache or freshly fetched). */
  readonly loadedTileIds: readonly TileId[];
  /** Present when some or all of the request failed. */
  readonly error: TileSourceError | undefined;
  readonly meta: TileFetchMeta;
}

/**
 * A source of normalised map features for the query grid.
 *
 * Implementations must:
 *  - query only the layers they are asked for;
 *  - resolve rather than reject on failure, with a typed error;
 *  - be safe to call concurrently (internal throttling is their business).
 *
 * `fetchTiles` is the path the map uses: one Overpass query covers a whole
 * viewport's worth of tiles, because a request per tile per output group is up
 * to 18 requests for one pan — a burst the usage policy forbids and the
 * one-at-a-time queue would serialise into minutes. `fetchTile` remains for
 * single-tile callers and diagnostics.
 */
export interface TileSource {
  /** Identifier for logs and the recon page, e.g. `overpass`. */
  readonly id: string;
  fetchTile(request: TileRequest): Promise<TileFetchResult>;
  fetchTiles(request: TilesRequest): Promise<TilesFetchResult>;
}
