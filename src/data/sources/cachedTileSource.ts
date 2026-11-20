/**
 * IndexedDB tile cache, as a WRAPPER around any `TileSource`.
 *
 * Composition, not modification: `OverpassTileSource` knows nothing about
 * caching, and a future `WorkerTileSource` gets the same cache for free by
 * being wrapped the same way. The wrapper implements `TileSource` itself, so
 * nothing downstream can tell the difference.
 *
 * Cache keys are per `(tileId, layerKey, schemaVersion)` — never per layer set.
 * See `tileCacheKey`: a layer set describes the filter panel at one moment, not
 * the data, so keying by it would miss tiles already held every time the user
 * toggles a layer.
 */

import { del, get, keys, set } from 'idb-keyval';

import {
  OSM_TILE_TTL_MS,
  TILE_CACHE_EVICTION_BATCH,
  TILE_CACHE_MAX_BYTES,
  TILE_CACHE_MAX_ENTRIES,
} from '../../config';
import { boundsForTileId, tileIdFor, type TileId } from '../../lib/tiles';
import type { LayerKey } from './layers';
import { tileCacheKey } from './overpassTileSource';
import type {
  Feature,
  TileFetchMeta,
  TileFetchResult,
  TileRequest,
  TileSource,
  TilesFetchResult,
  TilesRequest,
} from './tileSource';

/* ------------------------------------------------------------------ *
 * Stored shape
 * ------------------------------------------------------------------ */

interface CacheEntry {
  readonly storedAt: number;
  /** Last read, for LRU eviction. */
  lastUsedAt: number;
  /** Approximate serialised size, so the budget does not need a re-measure. */
  readonly bytes: number;
  /** Whether the entry holds geometry; a centre-only entry misses a geometry read. */
  readonly hasGeometry: boolean;
  readonly features: readonly Feature[];
}

export interface CacheStats {
  hits: number;
  misses: number;
  writes: number;
  evictions: number;
  errors: number;
}

export interface CacheInventory {
  readonly entries: number;
  readonly approximateBytes: number;
}

/* ------------------------------------------------------------------ *
 * The wrapper
 * ------------------------------------------------------------------ */

export class CachedTileSource implements TileSource {
  readonly id: string;

  private readonly inner: TileSource;
  private readonly stats: CacheStats = { hits: 0, misses: 0, writes: 0, evictions: 0, errors: 0 };
  /** Approximate live byte count, maintained incrementally to avoid rescans. */
  private trackedBytes = 0;
  private trackedEntries = 0;
  private inventoryLoaded = false;

  constructor(inner: TileSource) {
    this.inner = inner;
    this.id = `cached(${inner.id})`;
  }

  cacheStats(): Readonly<CacheStats> {
    return { ...this.stats };
  }

  async fetchTile(request: TileRequest): Promise<TileFetchResult> {
    const startedAt = Date.now();
    const bbox = boundsForTileId(request.tileId);
    if (bbox === undefined || request.layers.length === 0) {
      // Malformed ids and empty requests are the inner source's business.
      return this.inner.fetchTile(request);
    }

    const wantsGeometry = request.includeGeometry === true;
    const cachedFeatures: Feature[] = [];
    const missing: LayerKey[] = [];

    for (const layer of request.layers) {
      const entry = await this.read(request.tileId, layer);
      const usable =
        entry !== undefined &&
        Date.now() - entry.storedAt < OSM_TILE_TTL_MS &&
        // A centre-only entry cannot answer a request that needs geometry.
        (!wantsGeometry || entry.hasGeometry);

      if (usable && entry !== undefined) {
        this.stats.hits += 1;
        cachedFeatures.push(...entry.features);
      } else {
        this.stats.misses += 1;
        missing.push(layer);
      }
    }

    if (missing.length === 0) {
      return {
        ok: true,
        tileId: request.tileId,
        bbox,
        features: cachedFeatures,
        meta: {
          durationMs: Date.now() - startedAt,
          endpoint: undefined,
          attempts: 0,
          truncated: false,
          query: undefined,
          fromCache: true,
        },
      };
    }

    const fetched = await this.inner.fetchTile({
      ...request,
      layers: missing,
    });

    if (!fetched.ok) {
      // A failed fetch must not discard what the cache already answered. If
      // some layers were served from cache, return those and report partial.
      if (cachedFeatures.length > 0) {
        return {
          ok: true,
          tileId: request.tileId,
          bbox,
          features: cachedFeatures,
          meta: { ...fetched.meta, fromCache: true },
        };
      }
      return fetched;
    }

    await this.writeSplit(request.tileId, missing, fetched.features, wantsGeometry);

    const meta: TileFetchMeta = {
      ...fetched.meta,
      durationMs: Date.now() - startedAt,
      fromCache: cachedFeatures.length > 0,
    };

    return {
      ok: true,
      tileId: request.tileId,
      bbox,
      features: [...cachedFeatures, ...fetched.features],
      meta,
    };
  }

  /**
   * Batched read: whatever is cached comes from IndexedDB, and everything else
   * is fetched in ONE query per output group.
   *
   * The split back into per-`(tile, layer)` entries happens here rather than
   * server-side, which is what keeps cache reuse on pan identical to the
   * one-request-per-tile version: a tile fetched as part of a batch is stored
   * under exactly the same key it would have had on its own.
   */
  async fetchTiles(request: TilesRequest): Promise<TilesFetchResult> {
    const startedAt = Date.now();
    const wantsGeometry = request.includeGeometry === true;

    const cachedFeatures: Feature[] = [];
    /** Tile ids still needed, per layer. */
    const missingByLayer = new Map<LayerKey, TileId[]>();
    const loaded = new Set<TileId>();

    for (const tileId of request.tileIds) {
      if (boundsForTileId(tileId) === undefined) continue;
      for (const layer of request.layers) {
        const entry = await this.read(tileId, layer);
        const usable =
          entry !== undefined &&
          Date.now() - entry.storedAt < OSM_TILE_TTL_MS &&
          (!wantsGeometry || entry.hasGeometry);

        if (usable && entry !== undefined) {
          this.stats.hits += 1;
          cachedFeatures.push(...entry.features);
          loaded.add(tileId);
        } else {
          this.stats.misses += 1;
          const list = missingByLayer.get(layer);
          if (list === undefined) missingByLayer.set(layer, [tileId]);
          else list.push(tileId);
        }
      }
    }

    if (missingByLayer.size === 0) {
      return {
        features: cachedFeatures,
        loadedTileIds: [...loaded],
        error: undefined,
        meta: {
          durationMs: Date.now() - startedAt,
          endpoint: undefined,
          attempts: 0,
          truncated: false,
          query: undefined,
          fromCache: true,
        },
      };
    }

    // Every tile missing any layer has to be covered by the query anyway, so
    // one union over the whole missing set is both simplest and smallest.
    const missingTiles = [...new Set([...missingByLayer.values()].flat())];
    const missingLayers = [...missingByLayer.keys()];

    const fetched = await this.inner.fetchTiles({
      ...request,
      tileIds: missingTiles,
      layers: missingLayers,
    });

    if (fetched.features.length > 0 || fetched.error === undefined) {
      await this.writeSplitByTile(missingByLayer, fetched.features, wantsGeometry);
      for (const tileId of missingTiles) loaded.add(tileId);
    }

    return {
      features: [...cachedFeatures, ...fetched.features],
      loadedTileIds: [...loaded],
      error: fetched.error,
      meta: {
        ...fetched.meta,
        durationMs: Date.now() - startedAt,
        fromCache: cachedFeatures.length > 0,
      },
    };
  }

  /**
   * Splits a batched response back into one entry per `(tile, layer)`.
   *
   * A feature belongs to the tile containing its representative point, which is
   * the same rule `tileIdFor` uses everywhere else — so a tile stored from a
   * batch is byte-for-byte what a single-tile fetch would have stored.
   *
   * Only tiles that were actually requested for that layer are written: the
   * union rectangle can overlap tiles we already hold, and their cached entries
   * are already correct.
   */
  private async writeSplitByTile(
    missingByLayer: ReadonlyMap<LayerKey, readonly TileId[]>,
    features: readonly Feature[],
    hasGeometry: boolean,
  ): Promise<void> {
    const now = Date.now();
    /** `${tileId}|${layer}` → features. */
    const buckets = new Map<string, Feature[]>();

    for (const feature of features) {
      const tileId = tileIdFor(feature.lat, feature.lng);
      const key = `${tileId}|${feature.layer}`;
      const bucket = buckets.get(key);
      if (bucket === undefined) buckets.set(key, [feature]);
      else bucket.push(feature);
    }

    for (const [layer, tileIds] of missingByLayer) {
      for (const tileId of tileIds) {
        // An empty array is a real answer ("nothing here"); omitting it would
        // make empty tiles re-query for ever.
        const slice = buckets.get(`${tileId}|${layer}`) ?? [];
        const entry: CacheEntry = {
          storedAt: now,
          lastUsedAt: now,
          bytes: approximateBytes(slice),
          hasGeometry,
          features: slice,
        };
        try {
          await set(tileCacheKey(tileId, layer), entry);
          this.stats.writes += 1;
          this.trackedBytes += entry.bytes;
          this.trackedEntries += 1;
        } catch (cause) {
          this.stats.errors += 1;
          console.warn('[cache] write failed', { tileId, layer, cause });
        }
      }
    }
    await this.evictIfNeeded();
  }

  /**
   * Splits one response into one entry per layer.
   *
   * Every requested layer gets an entry, including layers that produced nothing:
   * an empty array is a real answer ("nothing here"), and omitting it would make
   * empty tiles re-query for ever.
   */
  private async writeSplit(
    tileId: string,
    layers: readonly LayerKey[],
    features: readonly Feature[],
    hasGeometry: boolean,
  ): Promise<void> {
    const now = Date.now();
    for (const layer of layers) {
      const slice = features.filter((feature) => feature.layer === layer);
      const entry: CacheEntry = {
        storedAt: now,
        lastUsedAt: now,
        bytes: approximateBytes(slice),
        hasGeometry,
        features: slice,
      };
      try {
        await set(tileCacheKey(tileId, layer), entry);
        this.stats.writes += 1;
        this.trackedBytes += entry.bytes;
        this.trackedEntries += 1;
      } catch (cause) {
        // A full or unavailable IndexedDB must never break the map.
        this.stats.errors += 1;
        console.warn('[cache] write failed', { tileId, layer, cause });
      }
    }
    await this.evictIfNeeded();
  }

  private async read(tileId: string, layer: LayerKey): Promise<CacheEntry | undefined> {
    const key = tileCacheKey(tileId, layer);
    try {
      const entry = await get<CacheEntry>(key);
      if (entry === undefined) return undefined;
      // Touch for LRU. Fire-and-forget: a failed touch only costs accuracy.
      void set(key, { ...entry, lastUsedAt: Date.now() }).catch(() => undefined);
      return entry;
    } catch (cause) {
      this.stats.errors += 1;
      console.warn('[cache] read failed', { key, cause });
      return undefined;
    }
  }

  /** Entry count and approximate size, for the dev inspector. */
  async inventory(): Promise<CacheInventory> {
    try {
      const all = await keys();
      const cacheKeys = all.filter(isCacheKey);
      let bytes = 0;
      for (const key of cacheKeys) {
        const entry = await get<CacheEntry>(key);
        bytes += entry?.bytes ?? 0;
      }
      this.trackedEntries = cacheKeys.length;
      this.trackedBytes = bytes;
      this.inventoryLoaded = true;
      return { entries: cacheKeys.length, approximateBytes: bytes };
    } catch (cause) {
      this.stats.errors += 1;
      console.warn('[cache] inventory failed', { cause });
      return { entries: 0, approximateBytes: 0 };
    }
  }

  async clear(): Promise<void> {
    try {
      const all = await keys();
      await Promise.all(all.filter(isCacheKey).map((key) => del(key)));
      this.trackedBytes = 0;
      this.trackedEntries = 0;
    } catch (cause) {
      this.stats.errors += 1;
      console.warn('[cache] clear failed', { cause });
    }
  }

  /**
   * LRU eviction once either budget is exceeded.
   *
   * Removes a batch rather than a single entry, so a cache sitting exactly at
   * the limit does not pay a full scan on every write.
   */
  private async evictIfNeeded(): Promise<void> {
    if (!this.inventoryLoaded) {
      await this.inventory();
    }
    if (
      this.trackedEntries <= TILE_CACHE_MAX_ENTRIES &&
      this.trackedBytes <= TILE_CACHE_MAX_BYTES
    ) {
      return;
    }

    try {
      const cacheKeys = (await keys()).filter(isCacheKey);
      const entries: { key: IDBValidKey; lastUsedAt: number; bytes: number }[] = [];
      for (const key of cacheKeys) {
        const entry = await get<CacheEntry>(key);
        if (entry === undefined) continue;
        entries.push({ key, lastUsedAt: entry.lastUsedAt ?? entry.storedAt, bytes: entry.bytes });
      }

      entries.sort((a, b) => a.lastUsedAt - b.lastUsedAt); // oldest use first

      const overEntries = Math.max(0, entries.length - TILE_CACHE_MAX_ENTRIES);
      let overBytes = Math.max(
        0,
        entries.reduce((sum, entry) => sum + entry.bytes, 0) - TILE_CACHE_MAX_BYTES,
      );
      let removed = 0;

      for (const entry of entries) {
        const needMore = removed < overEntries || overBytes > 0;
        if (!needMore || removed >= overEntries + TILE_CACHE_EVICTION_BATCH) break;
        await del(entry.key);
        removed += 1;
        overBytes -= entry.bytes;
        this.trackedBytes -= entry.bytes;
        this.trackedEntries -= 1;
        this.stats.evictions += 1;
      }
    } catch (cause) {
      this.stats.errors += 1;
      console.warn('[cache] eviction failed', { cause });
    }
  }
}

/** Only our own keys are touched; other IndexedDB users share the store. */
function isCacheKey(key: IDBValidKey): key is string {
  return typeof key === 'string' && key.startsWith('v') && key.includes('km:');
}

/**
 * Rough serialised size. Exact accounting would mean serialising twice; the
 * budget only needs to be approximately right.
 */
export function approximateBytes(features: readonly Feature[]): number {
  let bytes = 64;
  for (const feature of features) {
    bytes += 120; // id, layer, source, coordinates, object overhead
    for (const [key, value] of Object.entries(feature.tags)) {
      bytes += key.length + value.length + 4;
    }
    if (feature.geometry !== undefined) bytes += feature.geometry.coordinates.length * 18;
  }
  return bytes;
}
