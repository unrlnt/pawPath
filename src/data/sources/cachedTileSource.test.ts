import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TILE_SIZE_KM } from '../../config';
import { TILE_LAT_STEP, bboxAround, tileIdFor, tilesForViewport } from '../../lib/tiles';
import { CachedTileSource, approximateBytes } from './cachedTileSource';
import type {
  Feature,
  TileFetchResult,
  TileRequest,
  TileSource,
  TilesFetchResult,
  TilesRequest,
} from './tileSource';
import { TileSourceError } from './tileSource';

/* ------------------------------------------------------------------ *
 * In-memory stand-in for idb-keyval, so the wrapper can be tested
 * without IndexedDB.
 * ------------------------------------------------------------------ */

const store = new Map<string, unknown>();

vi.mock('idb-keyval', () => ({
  get: async (key: string) => store.get(key),
  set: async (key: string, value: unknown) => {
    store.set(key, value);
  },
  del: async (key: string) => {
    store.delete(key);
  },
  keys: async () => [...store.keys()],
}));

const TILE_ID = `${TILE_SIZE_KM}km:2913:279`;

function feature(id: string, layer: Feature['layer']): Feature {
  return {
    id: `osm:node/${id}`,
    source: 'osm',
    layer,
    lat: 52.35,
    lng: 5.26,
    tags: { amenity: 'bench' },
  };
}

/** Records what it was asked for, so cache hits are observable. */
class RecordingSource implements TileSource {
  readonly id = 'recording';
  readonly requests: TileRequest[] = [];
  readonly batchRequests: TilesRequest[] = [];
  result: TileFetchResult | undefined;
  batchError: TileSourceError | undefined;

  constructor(private readonly features: readonly Feature[] = []) {}

  async fetchTile(request: TileRequest): Promise<TileFetchResult> {
    this.requests.push(request);
    if (this.result !== undefined) return this.result;
    return {
      ok: true,
      tileId: request.tileId,
      bbox: { south: 52, west: 5, north: 53, east: 6 },
      features: this.features.filter((f) => request.layers.includes(f.layer)),
      meta: {
        durationMs: 1,
        endpoint: 'https://example.test',
        attempts: 1,
        truncated: false,
        query: 'q',
        fromCache: false,
      },
    };
  }

  async fetchTiles(request: TilesRequest): Promise<TilesFetchResult> {
    this.batchRequests.push(request);
    const features =
      this.batchError === undefined
        ? this.features.filter((f) => request.layers.includes(f.layer))
        : [];
    return {
      features,
      loadedTileIds: this.batchError === undefined ? request.tileIds : [],
      error: this.batchError,
      meta: {
        durationMs: 1,
        endpoint: 'https://example.test',
        attempts: 1,
        truncated: false,
        query: 'q',
        fromCache: false,
      },
    };
  }
}

beforeEach(() => {
  store.clear();
});

describe('CachedTileSource', () => {
  it('wraps rather than replaces — it is a TileSource itself', async () => {
    const inner = new RecordingSource([feature('1', 'benches')]);
    const cached = new CachedTileSource(inner);
    expect(cached.id).toBe('cached(recording)');

    const result = await cached.fetchTile({ tileId: TILE_ID, layers: ['benches'] });
    expect(result.ok).toBe(true);
    expect(inner.requests).toHaveLength(1);
  });

  it('serves a second identical request without touching the inner source', async () => {
    const inner = new RecordingSource([feature('1', 'benches')]);
    const cached = new CachedTileSource(inner);

    await cached.fetchTile({ tileId: TILE_ID, layers: ['benches'] });
    const second = await cached.fetchTile({ tileId: TILE_ID, layers: ['benches'] });

    expect(inner.requests).toHaveLength(1);
    expect(second.ok && second.features).toHaveLength(1);
    expect(second.meta.fromCache).toBe(true);
  });

  /**
   * The bug this guards: keying by layer SET would make every filter toggle a
   * brand-new key, missing tiles already held.
   */
  it('reuses a cached layer when the layer set changes', async () => {
    const inner = new RecordingSource([feature('1', 'benches'), feature('2', 'water')]);
    const cached = new CachedTileSource(inner);

    await cached.fetchTile({ tileId: TILE_ID, layers: ['benches'] });
    inner.requests.length = 0;

    await cached.fetchTile({ tileId: TILE_ID, layers: ['benches', 'water'] });

    // Only the layer we did not already hold is fetched.
    expect(inner.requests).toHaveLength(1);
    expect(inner.requests[0]?.layers).toEqual(['water']);
  });

  it('splits one response into one entry per layer', async () => {
    const inner = new RecordingSource([feature('1', 'benches'), feature('2', 'water')]);
    const cached = new CachedTileSource(inner);

    await cached.fetchTile({ tileId: TILE_ID, layers: ['benches', 'water'] });

    const keys = [...store.keys()];
    expect(keys).toHaveLength(2);
    expect(keys.some((key) => key.endsWith('|benches'))).toBe(true);
    expect(keys.some((key) => key.endsWith('|water'))).toBe(true);
  });

  /** An empty result is a real answer; omitting it re-queries empty tiles forever. */
  it('caches layers that returned nothing', async () => {
    const inner = new RecordingSource([]);
    const cached = new CachedTileSource(inner);

    await cached.fetchTile({ tileId: TILE_ID, layers: ['benches'] });
    inner.requests.length = 0;
    const second = await cached.fetchTile({ tileId: TILE_ID, layers: ['benches'] });

    expect(inner.requests).toHaveLength(0);
    expect(second.ok && second.features).toHaveLength(0);
  });

  it('treats a centre-only entry as a miss when geometry is needed', async () => {
    const inner = new RecordingSource([feature('1', 'shade')]);
    const cached = new CachedTileSource(inner);

    await cached.fetchTile({ tileId: TILE_ID, layers: ['shade'], includeGeometry: false });
    inner.requests.length = 0;
    await cached.fetchTile({ tileId: TILE_ID, layers: ['shade'], includeGeometry: true });

    expect(inner.requests).toHaveLength(1);
  });

  it('keeps cached layers when a later fetch fails', async () => {
    const inner = new RecordingSource([feature('1', 'benches')]);
    const cached = new CachedTileSource(inner);

    await cached.fetchTile({ tileId: TILE_ID, layers: ['benches'] });

    inner.result = {
      ok: false,
      tileId: TILE_ID,
      bbox: undefined,
      error: new TileSourceError('network', 'offline'),
      meta: {
        durationMs: 1,
        endpoint: undefined,
        attempts: 1,
        truncated: false,
        query: undefined,
        fromCache: false,
      },
    };

    const result = await cached.fetchTile({ tileId: TILE_ID, layers: ['benches', 'water'] });
    // Benches came from cache, so a failure on water must not lose them.
    expect(result.ok).toBe(true);
    expect(result.ok && result.features).toHaveLength(1);
  });

  it('propagates the failure when nothing was cached', async () => {
    const inner = new RecordingSource();
    inner.result = {
      ok: false,
      tileId: TILE_ID,
      bbox: undefined,
      error: new TileSourceError('network', 'offline'),
      meta: {
        durationMs: 1,
        endpoint: undefined,
        attempts: 1,
        truncated: false,
        query: undefined,
        fromCache: false,
      },
    };

    const result = await new CachedTileSource(inner).fetchTile({
      tileId: TILE_ID,
      layers: ['benches'],
    });
    expect(result.ok).toBe(false);
  });

  it('reports inventory and clears only its own keys', async () => {
    const cached = new CachedTileSource(new RecordingSource([feature('1', 'benches')]));
    store.set('unrelated-key', { some: 'other app' });

    await cached.fetchTile({ tileId: TILE_ID, layers: ['benches'] });
    const inventory = await cached.inventory();
    expect(inventory.entries).toBe(1);
    expect(inventory.approximateBytes).toBeGreaterThan(0);

    await cached.clear();
    expect(store.has('unrelated-key')).toBe(true);
    expect((await cached.inventory()).entries).toBe(0);
  });

  it('counts hits and misses', async () => {
    const cached = new CachedTileSource(new RecordingSource([feature('1', 'benches')]));
    await cached.fetchTile({ tileId: TILE_ID, layers: ['benches'] });
    await cached.fetchTile({ tileId: TILE_ID, layers: ['benches'] });

    const stats = cached.cacheStats();
    expect(stats.misses).toBe(1);
    expect(stats.hits).toBe(1);
    expect(stats.writes).toBe(1);
  });
});

describe('batched fetching', () => {
  const centre = { lat: 52.3508, lng: 5.2647 };
  const tileIds = tilesForViewport(bboxAround(centre.lat, centre.lng, 3), centre, 9).tileIds;

  it('covers a whole viewport with ONE call to the inner source', async () => {
    const inner = new RecordingSource([feature('1', 'benches')]);
    const cached = new CachedTileSource(inner);

    await cached.fetchTiles({ tileIds, layers: ['benches', 'water'] });

    // Nine tiles × two layers used to be up to eighteen serialised requests.
    expect(inner.batchRequests).toHaveLength(1);
    expect(inner.batchRequests[0]?.tileIds).toHaveLength(tileIds.length);
  });

  it('asks only for the tiles it does not already hold', async () => {
    const inner = new RecordingSource([feature('1', 'benches')]);
    const cached = new CachedTileSource(inner);

    const firstTile = tileIds[0];
    expect(firstTile).toBeDefined();
    if (firstTile === undefined) return;

    await cached.fetchTiles({ tileIds: [firstTile], layers: ['benches'] });
    inner.batchRequests.length = 0;

    await cached.fetchTiles({ tileIds, layers: ['benches'] });

    // The tile fetched a moment ago is not requested again — this is the pan
    // case, and it is why the split-on-write has to be per tile.
    const requested = inner.batchRequests[0]?.tileIds ?? [];
    expect(requested).not.toContain(firstTile);
    expect(requested).toHaveLength(tileIds.length - 1);
  });

  it('splits the response into per-tile entries by containment', async () => {
    // Two features in two different tiles, returned by one batched query.
    const here = { lat: 52.3508, lng: 5.2647 };
    const farther = { lat: 52.3508 + TILE_LAT_STEP * 2, lng: 5.2647 };
    const inner = new RecordingSource([
      { ...feature('1', 'benches'), lat: here.lat, lng: here.lng },
      { ...feature('2', 'benches'), lat: farther.lat, lng: farther.lng },
    ]);
    const cached = new CachedTileSource(inner);

    const a = tileIdFor(here.lat, here.lng);
    const b = tileIdFor(farther.lat, farther.lng);
    await cached.fetchTiles({ tileIds: [a, b], layers: ['benches'] });

    // Each feature landed in its own tile's entry, exactly as a per-tile fetch
    // would have stored it.
    const entryA = store.get(`v1|${a}|benches`) as { features: Feature[] } | undefined;
    const entryB = store.get(`v1|${b}|benches`) as { features: Feature[] } | undefined;
    expect(entryA?.features.map((f) => f.id)).toEqual(['osm:node/1']);
    expect(entryB?.features.map((f) => f.id)).toEqual(['osm:node/2']);
  });

  it('serves a repeat viewport entirely from cache', async () => {
    const inner = new RecordingSource([feature('1', 'benches')]);
    const cached = new CachedTileSource(inner);

    await cached.fetchTiles({ tileIds, layers: ['benches'] });
    inner.batchRequests.length = 0;

    const second = await cached.fetchTiles({ tileIds, layers: ['benches'] });
    expect(inner.batchRequests).toHaveLength(0);
    expect(second.meta.fromCache).toBe(true);
    expect(second.loadedTileIds).toHaveLength(tileIds.length);
  });

  it('still returns cached features when the batch fails', async () => {
    const inner = new RecordingSource([feature('1', 'benches')]);
    const cached = new CachedTileSource(inner);

    const firstTile = tileIds[0];
    if (firstTile === undefined) return;
    await cached.fetchTiles({ tileIds: [firstTile], layers: ['benches'] });

    inner.batchError = new TileSourceError('network', 'offline');
    const result = await cached.fetchTiles({ tileIds, layers: ['benches'] });

    expect(result.error?.kind).toBe('network');
    expect(result.features.length).toBeGreaterThan(0);
  });
});

describe('approximateBytes', () => {
  it('grows with tag and geometry size', () => {
    const bare = approximateBytes([feature('1', 'benches')]);
    const tagged = approximateBytes([
      { ...feature('1', 'benches'), tags: { amenity: 'bench', name: 'A long bench name here' } },
    ]);
    expect(tagged).toBeGreaterThan(bare);
    expect(approximateBytes([])).toBeGreaterThan(0);
  });
});
