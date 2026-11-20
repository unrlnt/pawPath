/**
 * `TileSource` backed by the public Overpass API, queried straight from the
 * browser (CLAUDE.md §3).
 *
 * Query building is entirely driven by the selectors in `layers.ts`; this file
 * only decides how many requests to make and how to turn OSM elements into
 * normalised features.
 */

import {
  OVERPASS_RESULT_CAP,
  OVERPASS_SERVER_TIMEOUT_S,
  OVERPASS_TIMEOUT_MS,
  TILE_CACHE_SCHEMA_VERSION,
} from '../../config';
import {
  boundingBoxOfTiles,
  boundsForTileId,
  type BBox,
  type TileId,
} from '../../lib/tiles';
import {
  LAYERS,
  isLayerKey,
  type LayerDefinition,
  type LayerKey,
  type TagCondition,
  type TagSelector,
} from './layers';
import { runOverpassQuery, type OverpassElement } from './overpassClient';
import { buildOverpassQL, type OverpassOutput } from './overpassQuery';
import {
  TileSourceError,
  type Feature,
  type FeatureGeometry,
  type FeatureSource,
  type LngLat,
  type TileFetchMeta,
  type TileFetchResult,
  type TileRequest,
  type TileSource,
  type TilesFetchResult,
  type TilesRequest,
} from './tileSource';

/** Everything this source produces is OSM data. */
const OSM_SOURCE: FeatureSource = 'osm';

/* ------------------------------------------------------------------ *
 * Tag matching
 *
 * The same conditions are evaluated twice: once by Overpass to fetch, and once
 * here to attribute a returned element back to the layer that asked for it.
 * One query can serve several layers, so this is how a bench is told from a
 * bin without a second round trip.
 * ------------------------------------------------------------------ */

export function matchesCondition(
  tags: Readonly<Record<string, string>>,
  condition: TagCondition,
): boolean {
  const value = tags[condition.key];
  switch (condition.op) {
    case 'exists':
      return value !== undefined;
    case 'equals':
      return value === condition.value;
    case 'notEquals':
      return value !== undefined && value !== condition.value;
    case 'matches':
      return value !== undefined && new RegExp(condition.pattern).test(value);
  }
}

export function matchesSelector(
  tags: Readonly<Record<string, string>>,
  selector: TagSelector,
): boolean {
  return selector.conditions.every((condition) => matchesCondition(tags, condition));
}

function matchesLayer(tags: Readonly<Record<string, string>>, layer: LayerDefinition): boolean {
  return layer.selectors.some((selector) => matchesSelector(tags, selector));
}

/* ------------------------------------------------------------------ *
 * Normalisation
 * ------------------------------------------------------------------ */

function representativePoint(
  element: OverpassElement,
): { lat: number; lng: number } | undefined {
  if (typeof element.lat === 'number' && typeof element.lon === 'number') {
    return { lat: element.lat, lng: element.lon };
  }
  if (element.center !== undefined) {
    return { lat: element.center.lat, lng: element.center.lon };
  }
  if (element.bounds !== undefined) {
    return {
      lat: (element.bounds.minlat + element.bounds.maxlat) / 2,
      lng: (element.bounds.minlon + element.bounds.maxlon) / 2,
    };
  }
  if (element.geometry !== undefined && element.geometry.length > 0) {
    let latSum = 0;
    let lonSum = 0;
    for (const point of element.geometry) {
      latSum += point.lat;
      lonSum += point.lon;
    }
    return { lat: latSum / element.geometry.length, lng: lonSum / element.geometry.length };
  }
  return undefined;
}

function geometryOf(element: OverpassElement): FeatureGeometry | undefined {
  // Relation geometry arrives as member ways and needs ring assembly to be
  // drawable. That is Phase 5 work; until then relations carry a centre only.
  if (element.type !== 'way') return undefined;
  const points = element.geometry;
  if (points === undefined || points.length < 2) return undefined;

  const coordinates: LngLat[] = points.map((point) => [point.lon, point.lat] as const);
  const first = coordinates[0];
  const last = coordinates[coordinates.length - 1];
  const closed =
    coordinates.length >= 4 &&
    first !== undefined &&
    last !== undefined &&
    first[0] === last[0] &&
    first[1] === last[1];

  return { type: closed ? 'Polygon' : 'LineString', coordinates };
}

/**
 * Turns raw OSM elements into features for the given layers. An element that
 * matches two enabled layers (a scrubby dog park, say) is emitted once per
 * layer — layers are independent toggles, not a partition.
 */
export function normaliseElements(
  elements: readonly OverpassElement[],
  layers: readonly LayerDefinition[],
  options: { includeGeometry: boolean },
): Feature[] {
  const features: Feature[] = [];

  for (const element of elements) {
    const tags = element.tags;
    if (tags === undefined) continue; // Untagged member nodes of a way.

    const point = representativePoint(element);
    if (point === undefined) continue;

    const geometry = options.includeGeometry ? geometryOf(element) : undefined;
    // Source-prefixed so a Phase 8 provider using the same numeric ids cannot
    // collide with an OSM feature.
    const id = `${OSM_SOURCE}:${element.type}/${element.id}`;

    for (const layer of layers) {
      if (!matchesLayer(tags, layer)) continue;
      const level = layer.level?.(tags);
      features.push({
        id,
        source: OSM_SOURCE,
        layer: layer.key,
        lat: point.lat,
        lng: point.lng,
        tags,
        ...(geometry === undefined ? {} : { geometry }),
        ...(level === undefined ? {} : { level }),
      });
    }
  }

  return features;
}

/* ------------------------------------------------------------------ *
 * Request grouping
 * ------------------------------------------------------------------ */

/**
 * Layers are grouped by the output mode they need, so a tile costs at most two
 * requests: the cheap `center` group (amenities) and the expensive `geom` group
 * (polygons). Callers wanting the progressive render of CLAUDE.md §8 should
 * call `fetchTile` once per group, amenity layers first.
 */
function groupByOutput(
  layers: readonly LayerDefinition[],
  includeGeometry: boolean | undefined,
): Map<OverpassOutput, LayerDefinition[]> {
  const groups = new Map<OverpassOutput, LayerDefinition[]>();
  for (const layer of layers) {
    const output: OverpassOutput =
      includeGeometry === undefined
        ? layer.defaultOutput
        : includeGeometry
          ? 'geom'
          : 'center';
    const existing = groups.get(output);
    if (existing === undefined) groups.set(output, [layer]);
    else existing.push(layer);
  }
  // `center` first: it is the fast one, and returning it early is what makes
  // the progressive render feel progressive.
  return new Map(
    [...groups].sort(([a], [b]) => (a === b ? 0 : a === 'center' ? -1 : 1)),
  );
}

/**
 * Timeouts per output group.
 *
 * A healthy amenity query answers in 1–3 s; a polygon query legitimately takes
 * tens of seconds. Giving both 45 s means every failed amenity query costs 45 s
 * of a user's attention for no reason.
 */
function timeoutsFor(output: OverpassOutput): { clientMs: number; serverS: number } {
  return output === 'center'
    ? { clientMs: OVERPASS_TIMEOUT_MS.amenity, serverS: OVERPASS_SERVER_TIMEOUT_S.amenity }
    : { clientMs: OVERPASS_TIMEOUT_MS.area, serverS: OVERPASS_SERVER_TIMEOUT_S.area };
}

/**
 * Cache key for one layer of one tile.
 *
 * Deliberately per-layer rather than per-layer-set: a layer set is a property
 * of the moment's filter panel, not of the data. Keying by the set means every
 * toggle produces a key that has never been seen before and misses tiles we
 * already hold, while storing the same features many times over.
 *
 * The schema version is part of the key so a change to `Feature`, to a level
 * derivation or to a layer's selectors invalidates old entries cleanly instead
 * of resurrecting them under new semantics.
 */
export function tileCacheKey(tileId: TileId, layer: LayerKey): string {
  return `v${TILE_CACHE_SCHEMA_VERSION}|${tileId}|${layer}`;
}

/* ------------------------------------------------------------------ *
 * The source
 * ------------------------------------------------------------------ */

/** A single-query diagnostic probe. Used by the Phase 1 recon page. */
export interface ProbeRequest {
  readonly bbox: BBox;
  readonly layer: LayerKey;
  /** Defaults to every selector of the layer. */
  readonly selectors?: readonly TagSelector[];
  readonly output?: OverpassOutput;
  readonly context?: string;
  readonly signal?: AbortSignal;
  /** Minimum gap since the previous Overpass request. */
  readonly minIntervalMs?: number;
}

export type ProbeResult =
  | { readonly ok: true; readonly features: readonly Feature[]; readonly meta: TileFetchMeta }
  | { readonly ok: false; readonly error: TileSourceError; readonly meta: TileFetchMeta };

/** How often each value of one tag key occurs in an area. Diagnostics only. */
export interface TagDistributionRequest {
  readonly bbox: BBox;
  /** The tag key to tally, e.g. `dog`. */
  readonly key: string;
  readonly context?: string;
  readonly signal?: AbortSignal;
  readonly minIntervalMs?: number;
}

export interface TagValueCount {
  readonly value: string;
  readonly count: number;
}

export type TagDistributionResult =
  | {
      readonly ok: true;
      readonly key: string;
      /** Descending by count. */
      readonly values: readonly TagValueCount[];
      readonly total: number;
      readonly meta: TileFetchMeta;
    }
  | { readonly ok: false; readonly key: string; readonly error: TileSourceError; readonly meta: TileFetchMeta };

export class OverpassTileSource implements TileSource {
  readonly id = 'overpass';

  async fetchTile(request: TileRequest): Promise<TileFetchResult> {
    const startedAt = Date.now();
    const bbox = boundsForTileId(request.tileId);

    if (bbox === undefined) {
      return this.invalidTile(request.tileId, `Unusable tile id: ${request.tileId}`, startedAt);
    }

    const unknown = request.layers.filter((key) => !isLayerKey(key));
    if (unknown.length > 0) {
      return this.invalidTile(
        request.tileId,
        `Unknown layer key(s): ${unknown.join(', ')}`,
        startedAt,
        bbox,
      );
    }
    if (request.layers.length === 0) {
      return {
        ok: true,
        tileId: request.tileId,
        bbox,
        features: [],
        meta: emptyMeta(Date.now() - startedAt),
      };
    }

    /* -- Phase 2 cache seam ------------------------------------------------
     * The IndexedDB tile cache goes exactly here, wrapping the fetch below.
     *
     * ONE ENTRY PER (tileId, layerKey), never per layer set — see
     * `tileCacheKey`. A layer set describes the filter panel at one moment,
     * not the data, so keying by it would miss tiles we already hold as soon
     * as the user toggles anything.
     *
     * Read — partition the request, do not treat it as all-or-nothing:
     *
     *   const fresh: Feature[] = [];
     *   const missing: LayerKey[] = [];
     *   for (const layer of request.layers) {
     *     const hit = await tileCache.get(tileCacheKey(request.tileId, layer));
     *     if (hit !== undefined && Date.now() - hit.storedAt < OSM_TILE_TTL_MS) {
     *       fresh.push(...hit.features);
     *     } else {
     *       missing.push(layer);
     *     }
     *   }
     *   if (missing.length === 0) return { ... features: fresh, fromCache: true };
     *
     * Fetch only `missing`, then split the response before writing: one
     * response can cover several layers, and each layer's slice is stored
     * under its own key. An element matching two layers is normalised into one
     * feature per layer already (see `normaliseElements`), so the split is a
     * group-by on `feature.layer`:
     *
     *   for (const layer of missing) {
     *     await tileCache.set(tileCacheKey(request.tileId, layer), {
     *       storedAt: Date.now(),
     *       features: fetched.filter((feature) => feature.layer === layer),
     *     });
     *   }
     *
     * Write a key for EVERY layer in `missing`, including ones that produced
     * no features — an empty array is a real answer ("nothing here"), and
     * omitting it makes empty tiles re-query forever.
     *
     * One caveat to carry into Phase 5: entries record whichever output mode
     * produced them, so a centre-only entry must count as a miss for a caller
     * that needs geometry.
     *
     * These keys cover OSM tiles only. Phase 8's regional sources ship as
     * build-time static GeoJSON and are not tile-cached at all; if a future
     * source is ever fetched per tile, add its `FeatureSource` to the key and
     * bump TILE_CACHE_SCHEMA_VERSION.
     *
     * Deliberately not implemented in Phase 1 — see CLAUDE.md §11, Phase 2.
     * -------------------------------------------------------------------- */

    const definitions = request.layers.map((key) => LAYERS[key as LayerKey]);
    const groups = groupByOutput(definitions, request.includeGeometry);

    const features: Feature[] = [];
    const queries: string[] = [];
    let endpoint: string | undefined;
    let attempts = 0;
    let truncated = false;

    for (const [output, groupLayers] of groups) {
      const ql = buildOverpassQL({
        bbox,
        selectors: groupLayers.flatMap((layer) => layer.selectors),
        output,
        context: `tile=${request.tileId} layers=${groupLayers.map((l) => l.key).join('+')}`,
      });
      queries.push(ql);

      const run = await runOverpassQuery(ql, {
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        ...(request.onProgress === undefined
          ? {}
          : {
              onProgress: (progress) => {
                request.onProgress?.({
                  message: progress.message,
                  endpoint: progress.endpoint,
                });
              },
            }),
      });
      attempts += run.attempts;
      endpoint = run.endpoint ?? endpoint;

      if (!run.ok) {
        return {
          ok: false,
          tileId: request.tileId,
          bbox,
          error: run.error,
          meta: {
            durationMs: Date.now() - startedAt,
            endpoint,
            attempts,
            truncated,
            query: queries.join('\n'),
            fromCache: false,
          },
        };
      }

      truncated = truncated || run.elements.length >= OVERPASS_RESULT_CAP;
      features.push(
        ...normaliseElements(run.elements, groupLayers, { includeGeometry: output === 'geom' }),
      );
    }

    return {
      ok: true,
      tileId: request.tileId,
      bbox,
      features,
      meta: {
        durationMs: Date.now() - startedAt,
        endpoint,
        attempts,
        truncated,
        query: queries.join('\n'),
        fromCache: false,
      },
    };
  }

  /**
   * Fetches many tiles with ONE query per output group.
   *
   * The tiles' bounding boxes are collapsed into a single rectangle and queried
   * once, rather than issuing a request per tile. With concurrency pinned at 1,
   * nine tiles × two groups was eighteen serialised requests for a single pan —
   * minutes of latency and a burst the usage policy asks us not to create.
   *
   * WHAT THIS IS NOT: an excuse to widen the area. The caller must keep the
   * per-viewport tile cap. A 20 km radius is ~1,250 km², which at Run 1's
   * measured densities (surface alone: 700–780 features/km²) is tens of
   * megabytes — it would blow the server-side timeout and fail *after*
   * consuming a slot, which is worse than not asking. The cap now bounds query
   * SIZE rather than request COUNT; do not raise it to save requests.
   */
  async fetchTiles(request: TilesRequest): Promise<TilesFetchResult> {
    const startedAt = Date.now();
    const bbox = boundingBoxOfTiles(request.tileIds);

    if (bbox === undefined || request.tileIds.length === 0 || request.layers.length === 0) {
      return {
        features: [],
        loadedTileIds: [],
        error:
          bbox === undefined && request.tileIds.length > 0
            ? new TileSourceError('invalidRequest', 'No usable tile ids in request')
            : undefined,
        meta: emptyMeta(Date.now() - startedAt),
      };
    }

    const unknown = request.layers.filter((key) => !isLayerKey(key));
    if (unknown.length > 0) {
      return {
        features: [],
        loadedTileIds: [],
        error: new TileSourceError(
          'invalidRequest',
          `Unknown layer key(s): ${unknown.join(', ')}`,
        ),
        meta: emptyMeta(Date.now() - startedAt),
      };
    }

    const definitions = request.layers.map((key) => LAYERS[key]);
    const groups = groupByOutput(definitions, request.includeGeometry);

    const features: Feature[] = [];
    const queries: string[] = [];
    let endpoint: string | undefined;
    let attempts = 0;
    let truncated = false;
    let firstError: TileSourceError | undefined;

    for (const [output, groupLayers] of groups) {
      const { clientMs, serverS } = timeoutsFor(output);
      const ql = buildOverpassQL({
        bbox,
        selectors: groupLayers.flatMap((layer) => layer.selectors),
        output,
        serverTimeoutS: serverS,
        context: `tiles=${request.tileIds.length} layers=${groupLayers
          .map((l) => l.key)
          .join('+')}`,
      });
      queries.push(ql);

      const run = await runOverpassQuery(ql, {
        timeoutMs: clientMs,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        ...(request.onProgress === undefined
          ? {}
          : {
              onProgress: (progress) => {
                request.onProgress?.({
                  message: progress.message,
                  endpoint: progress.endpoint,
                });
              },
            }),
      });

      attempts += run.attempts;
      endpoint = run.endpoint ?? endpoint;

      if (!run.ok) {
        // Keep going: the amenity group may have succeeded even if polygons
        // failed, and partial data beats none.
        firstError ??= run.error;
        continue;
      }

      truncated = truncated || run.elements.length >= OVERPASS_RESULT_CAP;
      features.push(
        ...normaliseElements(run.elements, groupLayers, { includeGeometry: output === 'geom' }),
      );
    }

    return {
      features,
      loadedTileIds: firstError === undefined ? request.tileIds : [],
      error: firstError,
      meta: {
        durationMs: Date.now() - startedAt,
        endpoint,
        attempts,
        truncated,
        query: queries.join('\n'),
        fromCache: false,
      },
    };
  }

  /**
   * Runs one query for an arbitrary bounding box and selector set, bypassing
   * the tile grid. Diagnostics only — the recon page uses this to measure
   * coverage tag by tag. Product code must go through `fetchTile`.
   */
  async probe(request: ProbeRequest): Promise<ProbeResult> {
    const startedAt = Date.now();
    const layer = LAYERS[request.layer];
    const selectors = request.selectors ?? layer.selectors;
    const output = request.output ?? layer.defaultOutput;

    if (selectors.length === 0) {
      return {
        ok: false,
        error: new TileSourceError('invalidRequest', `No selectors for layer ${request.layer}`),
        meta: emptyMeta(0),
      };
    }

    const ql = buildOverpassQL({
      bbox: request.bbox,
      selectors,
      output,
      ...(request.context === undefined ? {} : { context: request.context }),
    });

    const run = await runOverpassQuery(ql, {
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.minIntervalMs === undefined ? {} : { minIntervalMs: request.minIntervalMs }),
    });

    const meta: TileFetchMeta = {
      durationMs: Date.now() - startedAt,
      endpoint: run.endpoint,
      attempts: run.attempts,
      truncated: run.ok && run.elements.length >= OVERPASS_RESULT_CAP,
      query: ql,
      fromCache: false,
    };

    if (!run.ok) return { ok: false, error: run.error, meta };

    return {
      ok: true,
      features: normaliseElements(run.elements, [layer], {
        includeGeometry: output === 'geom',
      }),
      meta,
    };
  }

  /**
   * Tallies every value of one tag key in an area.
   *
   * Answers "what do mappers here actually write for `dog=*`?" without us
   * having to guess a value list first — which is exactly the mistake that made
   * Run 1 query the non-existent `dog=off_leash`. Diagnostics only.
   */
  async probeTagDistribution(request: TagDistributionRequest): Promise<TagDistributionResult> {
    const startedAt = Date.now();
    const ql = buildOverpassQL({
      bbox: request.bbox,
      output: 'center',
      selectors: [
        {
          id: `distribution.${request.key}`,
          label: `${request.key}=*`,
          kinds: ['node', 'way', 'relation'],
          conditions: [{ op: 'exists', key: request.key }],
        },
      ],
      ...(request.context === undefined ? {} : { context: request.context }),
    });

    const run = await runOverpassQuery(ql, {
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.minIntervalMs === undefined ? {} : { minIntervalMs: request.minIntervalMs }),
    });

    const meta: TileFetchMeta = {
      durationMs: Date.now() - startedAt,
      endpoint: run.endpoint,
      attempts: run.attempts,
      truncated: run.ok && run.elements.length >= OVERPASS_RESULT_CAP,
      query: ql,
      fromCache: false,
    };

    if (!run.ok) return { ok: false, key: request.key, error: run.error, meta };

    const counts = new Map<string, number>();
    for (const element of run.elements) {
      const value = element.tags?.[request.key];
      if (value === undefined) continue;
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }

    const values = [...counts]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));

    return {
      ok: true,
      key: request.key,
      values,
      total: values.reduce((sum, entry) => sum + entry.count, 0),
      meta,
    };
  }

  private invalidTile(
    tileId: TileId,
    message: string,
    startedAt: number,
    bbox?: BBox,
  ): TileFetchResult {
    return {
      ok: false,
      tileId,
      bbox,
      error: new TileSourceError('invalidRequest', message),
      meta: emptyMeta(Date.now() - startedAt),
    };
  }
}

function emptyMeta(durationMs: number): TileFetchMeta {
  return {
    durationMs,
    endpoint: undefined,
    attempts: 0,
    truncated: false,
    query: undefined,
    fromCache: false,
  };
}
