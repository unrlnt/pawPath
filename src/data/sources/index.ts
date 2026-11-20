/**
 * The data layer's public surface. UI code imports from here and nowhere
 * deeper, so swapping `OverpassTileSource` for a future `WorkerTileSource`
 * touches this file alone (CLAUDE.md §3).
 */

export type {
  Feature,
  FeatureGeometry,
  FeatureSource,
  LngLat,
  SourceAttribution,
  TileFetchMeta,
  TileFetchResult,
  TileRequest,
  TileSource,
  TileSourceErrorKind,
} from './tileSource';
export { SOURCE_ATTRIBUTION, TileSourceError } from './tileSource';

export type {
  FeatureLevel,
  LayerDefinition,
  LayerKey,
  OsmElementKind,
  TagCondition,
  TagSelector,
} from './layers';
export {
  ALL_FEATURE_LEVELS,
  ALL_LAYERS,
  ALL_SELECTORS,
  DEFAULT_DISABLED_FEATURE_LEVELS,
  LAYERS,
  LAYER_KEYS,
  WALKABLE_HIGHWAY_PATTERN,
  isFeatureLevel,
  isLayerKey,
} from './layers';

export {
  OverpassTileSource,
  matchesSelector,
  normaliseElements,
  tileCacheKey,
} from './overpassTileSource';
export type {
  ProbeRequest,
  ProbeResult,
  TagDistributionRequest,
  TagDistributionResult,
  TagValueCount,
} from './overpassTileSource';
export { buildOverpassQL } from './overpassQuery';

export { CachedTileSource } from './cachedTileSource';
export type { CacheInventory, CacheStats } from './cachedTileSource';
export { ProxyTileSource } from './proxyTileSource';

export {
  allInstanceHealth,
  isParked,
  resetInstanceHealth,
  statusUrlFor,
} from './overpassHealth';
export type { InstanceHealth } from './overpassHealth';

export { sessionUsage, testInstanceConnectivity } from './overpassClient';
export type { ConnectivityResult, RetryProgress, SessionUsage } from './overpassClient';

import { CachedTileSource } from './cachedTileSource';
import { OverpassTileSource } from './overpassTileSource';
import { ProxyTileSource } from './proxyTileSource';
import type { TileSource } from './tileSource';

const overpass = new OverpassTileSource();

/**
 * The tile source the app uses, assembled here and nowhere else.
 *
 * Composition rather than configuration inside the sources: the cache wraps
 * whichever transport is selected, so both paths get identical caching and
 * neither transport knows the cache exists.
 */
const transport: TileSource = ProxyTileSource.isConfigured() ? new ProxyTileSource() : overpass;

const cached = new CachedTileSource(transport);

/** The tile source the app uses. Nothing outside this module picks the parts. */
export const tileSource: TileSource = cached;

/** The cache wrapper, for the dev inspector's stats and clear button. */
export const tileCache = cached;

/** The uncached Overpass source, for the recon page's `probe()` diagnostics. */
export const overpassSource = overpass;
