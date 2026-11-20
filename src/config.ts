/**
 * All tunables live here. No magic numbers in components, lib functions or
 * data sources — import from this file instead.
 *
 * Values are taken from CLAUDE.md; where the spec gave a range or an
 * approximation the chosen concrete value is noted in a comment.
 */

/* ------------------------------------------------------------------ *
 * Identity
 * ------------------------------------------------------------------ */

export const APP_NAME = 'PawPath';

/**
 * Sentinel meaning "no contact URL has been set yet". Queries built while this
 * is still in place say so honestly rather than carrying an invented URL — see
 * `buildOverpassQL`.
 */
export const APP_CONTACT_URL_UNSET = 'UNSET';

/**
 * How an Overpass instance operator reaches us before deciding to block us.
 *
 * Browsers forbid setting `User-Agent`, so the spec's "descriptive
 * User-Agent-equivalent" (§5) is emitted as a comment at the top of every
 * query instead, and this URL is the whole of its value.
 *
 * MUST be set to a real, reachable public URL — a repository or the deployed
 * site — before the app is posted publicly (CLAUDE.md §11, Phase 7). Keep it
 * current afterwards: a dead link here is the same as no contact at all.
 */
export const APP_CONTACT_URL: string = APP_CONTACT_URL_UNSET;

/* ------------------------------------------------------------------ *
 * Tile grid  (CLAUDE.md §8)
 * ------------------------------------------------------------------ */

/** Edge length of one query tile, in kilometres. Spec says "~2 km". */
export const TILE_SIZE_KM = 2;

/** Mean earth radius in km — used to convert the tile size to degrees. */
export const EARTH_RADIUS_KM = 6371;

/** Degrees of latitude per kilometre. Constant everywhere. */
export const DEGREES_PER_KM_LAT = 360 / (2 * Math.PI * EARTH_RADIUS_KM);

/**
 * Latitude beyond which the grid stops widening tiles in longitude.
 * Prevents a divide-by-~0 in the cos(lat) correction at the poles.
 */
export const TILE_GRID_MAX_LATITUDE = 85;

/* ------------------------------------------------------------------ *
 * Query strategy  (CLAUDE.md §8)
 * ------------------------------------------------------------------ */

/** Below this zoom, show a "zoom in" hint instead of querying amenities. */
export const MIN_QUERY_ZOOM = 13;

/**
 * Layers that need to be closer in than `MIN_QUERY_ZOOM` before they load.
 *
 * Surface measured 700–780 features/km² in Run 1 — roughly 2,800 ways per 2 km
 * tile, an order of magnitude past everything else. Loading it at the same zoom
 * as benches would dominate every viewport's payload and slot time. At z16 a
 * viewport covers about a sixteenth of the area, which brings it back in line.
 */
export const LAYER_MIN_ZOOM: Readonly<Record<string, number>> = {
  surface: 16,
};

/** Minimum zoom at which a layer may be queried. */
export function minZoomForLayer(layer: string): number {
  return LAYER_MIN_ZOOM[layer] ?? MIN_QUERY_ZOOM;
}

/** Milliseconds to wait after the map settles before issuing queries. */
export const QUERY_DEBOUNCE_MS = 500;

/**
 * Client-side abort for a single Overpass request, per output group.
 *
 * A healthy amenity query returns in 1–3 s (measured in Run 1: benches 1.1 s,
 * drinking water 1.1 s). Waiting 40 s for one is waiting on a request that has
 * already failed. Polygon queries genuinely do take tens of seconds, so they
 * keep a long timeout — the two must not share a budget.
 */
export const OVERPASS_TIMEOUT_MS = {
  /** Point queries: benches, bins, drinking water. */
  amenity: 12_000,
  /** Polygon queries: shade, water, off-leash areas, surface. */
  area: 45_000,
} as const;

/** Fallback for callers outside the two groups (recon, connectivity test). */
export const OVERPASS_REQUEST_TIMEOUT_MS = OVERPASS_TIMEOUT_MS.area;

/**
 * Value passed to Overpass's own `[timeout:N]` setting, per group, in seconds.
 * Kept below the client timeout so the server gives up first and returns a
 * readable remark rather than us aborting blind.
 */
export const OVERPASS_SERVER_TIMEOUT_S = {
  amenity: 10,
  area: 40,
} as const;

/* ------------------------------------------------------------------ *
 * Latency budget  (per user action, not per request)
 * ------------------------------------------------------------------ */

/**
 * Longest the UI will block on one user action — a pan, a zoom, a search.
 *
 * The retry policy's worst case is minutes, which on mobile is
 * indistinguishable from broken. Past this cap the UI stops waiting and shows
 * whatever has arrived; the retries do NOT stop, they continue in the
 * background and paint tiles as they land. A cap that cancelled the work would
 * just be the Phase 1 "give up early" bug wearing a new hat.
 */
export const USER_ACTION_LATENCY_BUDGET_MS = 50_000;

/**
 * Hard cap on elements returned by one query (`out ... <cap>`). A response at
 * exactly this size is reported as truncated rather than silently trusted.
 */
export const OVERPASS_RESULT_CAP = 20_000;

/**
 * ONE request at a time, always.
 *
 * The Overpass usage policy asks clients not to run requests in parallel from
 * one IP or IP block: an instance's slots are shared across everyone behind
 * that address, so parallelism from a single client crowds out other users and
 * is what earns a 429. This is a policy constraint, not a tuning knob — raising
 * it is a violation, not an optimisation.
 */
export const OVERPASS_MAX_CONCURRENCY = 1;

/** Pause between sequential Overpass requests. Politeness, not a limit. */
export const OVERPASS_INTER_REQUEST_DELAY_MS = 300;

/**
 * Attempts against ONE instance before rotating.
 *
 * Run 2's failures were not the servers: the same queries succeed by hand from
 * overpass-turbo in the same browser on the same IP. We rotated through every
 * instance on the first network-class error and gave up in 10–18 s with no real
 * retry. Transient errors are normal and clear on retry, so we now try the same
 * instance repeatedly before moving on.
 */
export const OVERPASS_ATTEMPTS_PER_INSTANCE = 3;

/** Total attempts for one query across all instances. */
export const OVERPASS_MAX_ATTEMPTS = 5;

/** First backoff pause, doubling per attempt: ~1s, 2s, 4s, 8s, 16s. */
export const OVERPASS_BACKOFF_BASE_MS = 1_000;

/** Ceiling for a single backoff pause. */
export const OVERPASS_BACKOFF_MAX_MS = 30_000;

/**
 * Jitter fraction of each backoff delay. 0.5 = "equal jitter": half the delay
 * is fixed, half is random. Without this, every client that hit the same
 * outage retries in lockstep and re-creates the burst that caused it.
 */
export const OVERPASS_BACKOFF_JITTER = 0.5;

/** Consecutive failures before an instance is parked by the circuit breaker. */
export const OVERPASS_BREAKER_THRESHOLD = 3;

/** How long a parked instance stays parked before it is probed again. */
export const OVERPASS_BREAKER_COOLDOWN_MS = 5 * 60_000;

/** How long a fetched `/api/status` reading stays usable. */
export const OVERPASS_STATUS_TTL_MS = 10_000;

/** Cap on how long we will wait for a slot reported by `/api/status`. */
export const OVERPASS_MAX_SLOT_WAIT_MS = 90_000;

/* ------------------------------------------------------------------ *
 * Overpass instances
 * ------------------------------------------------------------------ */

export interface OverpassInstanceConfig {
  readonly label: string;
  readonly url: string;
  /** `/api/status`, used for slot-aware waiting on 429. */
  readonly statusUrl: string;
  /**
   * `active` instances take part in rotation. `candidate` ones do not: they
   * appear only in the dev connectivity tester, so they can be verified
   * (planet-wide coverage, CORS, no UA policing) before being promoted here.
   */
  readonly status: 'active' | 'candidate';
  readonly note: string;
}

/**
 * Public Overpass instances, in the order they are tried
 * (https://wiki.openstreetmap.org/wiki/Overpass_API#Public_Overpass_API_instances).
 *
 * kumi.systems leads because its wiki entry permits use for any purpose and it
 * has the largest public capacity. overpass-api.de is at normal priority: the
 * 406 that once demoted it was our own `Accept` header, not bot filtering —
 * see `OVERPASS_ACCEPT_HEADER`.
 *
 * To add an instance: confirm from the wiki table that it serves **planet**
 * data (several are regional extracts and would silently return nothing
 * outside their region), then that it sends permissive CORS headers, then flip
 * `status` to `active`. The connectivity tester on the map page does the last
 * two checks for you.
 */
export const OVERPASS_INSTANCE_CONFIGS: readonly OverpassInstanceConfig[] = [
  {
    label: 'kumi.systems',
    url: 'https://overpass.kumi.systems/api/interpreter',
    statusUrl: 'https://overpass.kumi.systems/api/status',
    status: 'active',
    note: 'Wiki entry permits any purpose. Largest public capacity. Primary.',
  },
  {
    label: 'overpass-api.de',
    url: 'https://overpass-api.de/api/interpreter',
    statusUrl: 'https://overpass-api.de/api/status',
    status: 'active',
    note: 'Reference instance. Normal priority.',
  },
  {
    label: 'private.coffee',
    url: 'https://overpass.private.coffee/api/interpreter',
    statusUrl: 'https://overpass.private.coffee/api/status',
    status: 'active',
    note: 'Planet-wide community instance.',
  },
  {
    label: 'osm.ch',
    url: 'https://overpass.osm.ch/api/interpreter',
    statusUrl: 'https://overpass.osm.ch/api/status',
    status: 'candidate',
    note:
      'Swiss OSM association. VERIFY planet coverage and CORS with the ' +
      'connectivity tester before promoting — it may be a regional extract.',
  },
  {
    label: 'osm.jp',
    url: 'https://overpass.osm.jp/api/interpreter',
    statusUrl: 'https://overpass.osm.jp/api/status',
    status: 'candidate',
    note: 'Japanese mirror. VERIFY planet coverage and CORS before promoting.',
  },
];

/** Instances that take part in rotation, in order. */
export const OVERPASS_INSTANCES: readonly string[] = OVERPASS_INSTANCE_CONFIGS.filter(
  (instance) => instance.status === 'active',
).map((instance) => instance.url);

/* ------------------------------------------------------------------ *
 * Request shape  (CORS — see CLAUDE.md §5)
 * ------------------------------------------------------------------ */

/**
 * `Accept` sent on every Overpass request.
 *
 * States our intent (`application/json`) but keeps a wildcard fallback, and the
 * fallback is deliberate. Measured against overpass-api.de on 2026-09-07:
 *
 * | From                     | Accept                | Result |
 * |--------------------------|-----------------------|--------|
 * | browser `fetch`, localhost | wildcard            | 200    |
 * | browser address bar      | `text/html,…`         | 406    |
 * | curl (default UA)        | `application/json`    | 200    |
 * | curl (default UA)        | `text/html,…`         | 200    |
 * | curl (browser UA string) | any of the above      | 406    |
 *
 * So the discriminator is not the same everywhere: from a browser it is the
 * `Accept` header; from this development machine it is the `User-Agent`, and
 * `Accept` makes no difference at all. `overpass-api.de` balances across
 * backends whose configuration differs, so both observations are real.
 *
 * A bare `application/json` would therefore be a bet. The wildcard fallback
 * means negotiation cannot fail even on an instance that labels its JSON
 * `application/osm3s+json`, while the explicit type still says what we want.
 *
 * `Accept` is a CORS-safelisted request header, so this adds no preflight.
 */
export const OVERPASS_ACCEPT_HEADER = 'application/json, */*;q=0.8';

/**
 * `Content-Type` for the POST body.
 *
 * MUST stay one of the three CORS-safelisted values (`text/plain`,
 * `application/x-www-form-urlencoded`, `multipart/form-data`). Anything else —
 * `application/json` above all — turns every request into a preflighted one,
 * and a failed `OPTIONS` preflight surfaces in the browser as a bare
 * `TypeError` with no status and no response: exactly the "pre-HTTP fetch
 * rejection" that Run 2 hit on all three instances at once.
 */
export const OVERPASS_CONTENT_TYPE = 'application/x-www-form-urlencoded';

/* ------------------------------------------------------------------ *
 * Usage policy compliance  (CLAUDE.md §5, §9)
 * ------------------------------------------------------------------ */

/**
 * Documented safety margin in the Overpass usage policy: roughly 10,000
 * queries or 1 GB per day from one user. We budget per session, well under it,
 * and stop rather than degrade quietly. Surfaced in the dev cache inspector.
 */
export const OVERPASS_SESSION_REQUEST_BUDGET = 1_000;

/** Session download budget in bytes, against the policy's ~1 GB/day. */
export const OVERPASS_SESSION_BYTE_BUDGET = 100 * 1024 * 1024;

/* ------------------------------------------------------------------ *
 * Cache TTLs  (CLAUDE.md §8) — consumed by the Phase 2 IndexedDB layer
 * ------------------------------------------------------------------ */

export const OSM_TILE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const CONDITIONS_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Part of every cached tile key. Bump it whenever the shape of a normalised
 * `Feature`, a level derivation or a layer's selectors change — old entries
 * then stop matching instead of being silently reused under new semantics.
 */
export const TILE_CACHE_SCHEMA_VERSION = 1;

/* ------------------------------------------------------------------ *
 * Paw surface temperature model  (CLAUDE.md §7)
 *
 * T_surface ≈ T_air + k × (shortwave / 1000) × wind_factor × shade_factor
 * ------------------------------------------------------------------ */

export const PAW_K_VALUES = {
  asphalt: 28,
  concrete: 20,
  sand: 18,
  gravel: 14,
  grass: 8,
} as const;

export type PawSurfaceKind = keyof typeof PAW_K_VALUES;

/** wind_factor = 1 / (1 + WIND_FACTOR_COEFFICIENT × wind_kmh) */
export const PAW_WIND_FACTOR_COEFFICIENT = 0.06;

/** shade_factor = 1 − SHADE_FACTOR_COEFFICIENT × canopy_fraction */
export const PAW_SHADE_FACTOR_COEFFICIENT = 0.7;

/** Reference irradiance the k values are calibrated against, in W/m². */
export const PAW_REFERENCE_IRRADIANCE_W_M2 = 1000;

/**
 * Contact-burn thresholds in °C. Below `caution` is fine; at or above `danger`
 * a dog can burn its pads within about a minute.
 */
export const PAW_THRESHOLDS_C = {
  caution: 45,
  danger: 52,
} as const;

/**
 * The model is an estimate, so it is always presented as a range. This is the
 * ± half-width in °C applied to the point estimate.
 */
export const PAW_ESTIMATE_SPREAD_C = 3;

/* ------------------------------------------------------------------ *
 * Seasonal rules  (CLAUDE.md §7) — advisory only
 * Months are 1-based to match how the spec is written.
 * ------------------------------------------------------------------ */

export const SEASONAL_RULES = {
  grassSeeds: { startMonth: 6, endMonth: 8 },
  oakProcessionary: { startMonth: 4, endMonth: 7 },
  breedingSeasonLeash: {
    start: { month: 3, day: 1 },
    end: { month: 7, day: 15 },
  },
  ticks: {
    /** Daily mean above this for `consecutiveDays` days activates the warning. */
    activationTempC: 7,
    consecutiveDays: 3,
  },
} as const;

/* ------------------------------------------------------------------ *
 * Layers
 * ------------------------------------------------------------------ */

/**
 * Enabled on a first visit — a deliberately lightweight subset (CLAUDE.md §8).
 * The full list of layer keys lives in `src/data/sources/layers.ts`.
 */
export const DEFAULT_ENABLED_LAYERS = ['shade', 'offLeash', 'water'] as const;

/**
 * Levels that are OFF until the user opts in, even when their layer is on.
 *
 * `allowed_leash_unknown` is `dog=yes`: dogs are permitted, leash status
 * unstated, local law applies — which in NL/DE means leashed. Showing it
 * alongside genuine off-leash areas would imply a freedom that may not exist,
 * so it is opt-in and never rendered green. See `offLeashLevel` in
 * `src/data/sources/layers.ts`.
 *
 * Values are `FeatureLevel`s; kept as plain strings here because `layers.ts`
 * imports this module. A test asserts they are all real levels.
 */
export const DEFAULT_DISABLED_LEVELS: readonly string[] = ['allowed_leash_unknown'];

/**
 * Highway types worth colouring by paw-heat risk. Run 1 measured 700–780
 * features/km² when every highway type was included — roughly 2,800 ways per
 * 2 km tile, which is not viable to fetch, parse and draw client-side. A
 * motorway's surface is also irrelevant to a dog walk.
 */
export const WALKABLE_HIGHWAY_TYPES = [
  'path',
  'footway',
  'track',
  'pedestrian',
  'cycleway',
  'steps',
  'living_street',
  'residential',
  'service',
  'unclassified',
] as const;

/* ------------------------------------------------------------------ *
 * Basemap  (CLAUDE.md §4)
 *
 * Nothing provider-specific may leak into components: they read MAP_STYLE_URL
 * and MAP_ATTRIBUTION and nothing else. Swapping MapTiler for Stadia or
 * Protomaps is an env-var change.
 * ------------------------------------------------------------------ */

const MAPTILER_KEY = import.meta.env['VITE_MAPTILER_KEY'] ?? '';

/**
 * Default basemap (decided 2026-11-20, CLAUDE.md §4): OpenFreeMap needs no
 * key and has no request limits, so the app works with no configuration.
 */
export const OPENFREEMAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

/**
 * Style URL for the basemap.
 *
 * NEVER point this at tile.openstreetmap.org — their tile usage policy forbids
 * apps like this one, and doing so gets the app blocked (CLAUDE.md §4).
 *
 * `VITE_MAP_STYLE_URL` overrides everything, so a different provider needs no
 * code change. Otherwise MapTiler is used when a key is present.
 */
export const MAP_STYLE_URL: string =
  import.meta.env['VITE_MAP_STYLE_URL'] ??
  (MAPTILER_KEY === ''
    ? OPENFREEMAP_STYLE_URL
    : `https://api.maptiler.com/maps/streets-v2/style.json?key=${MAPTILER_KEY}`);

/** True when no basemap provider is configured; the app then runs map-less. */
export const MAP_STYLE_CONFIGURED = MAP_STYLE_URL !== '';

/** Credit for the basemap provider. Displayed permanently — licence terms. */
export const MAP_ATTRIBUTION: string =
  import.meta.env['VITE_MAP_ATTRIBUTION'] ??
  (MAPTILER_KEY === '' ? 'OpenFreeMap © OpenMapTiles' : '© MapTiler');

export const MAP_DEFAULT_ZOOM = 15;
export const MAP_MAX_ZOOM = 19;
export const MAP_MIN_ZOOM = 3;

/** Where the map opens when there is no stored location and no geolocation. */
export const MAP_FALLBACK_CENTRE = { lat: 52.3508, lng: 5.2647, label: 'Almere, NL' };

/* ------------------------------------------------------------------ *
 * Geolocation and search
 * ------------------------------------------------------------------ */

export const GEOLOCATION_TIMEOUT_MS = 10_000;
export const GEOLOCATION_MAX_AGE_MS = 60_000;

/** Nominatim's usage policy allows at most one request per second. */
export const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
export const NOMINATIM_MIN_INTERVAL_MS = 1_000;
export const NOMINATIM_DEBOUNCE_MS = 600;
export const NOMINATIM_RESULT_LIMIT = 5;
export const NOMINATIM_TIMEOUT_MS = 10_000;

/* ------------------------------------------------------------------ *
 * Viewport → tiles
 * ------------------------------------------------------------------ */

/**
 * Most tiles fetched for one viewport. Over this, the centre-most tiles are
 * fetched and the UI says coverage is partial — better than a burst of
 * requests that will be rate limited anyway.
 */
export const MAX_TILES_PER_VIEWPORT = 9;

/* ------------------------------------------------------------------ *
 * Tile cache  (CLAUDE.md §8)
 * ------------------------------------------------------------------ */

/** Maximum cached tile-layer entries before LRU eviction starts. */
export const TILE_CACHE_MAX_ENTRIES = 2_000;

/** Approximate byte budget for the cache; eviction targets whichever binds first. */
export const TILE_CACHE_MAX_BYTES = 40 * 1024 * 1024;

/** Entries removed past the limit in one eviction pass, to avoid thrashing. */
export const TILE_CACHE_EVICTION_BATCH = 100;

/* ------------------------------------------------------------------ *
 * Feature flags
 * ------------------------------------------------------------------ */

/**
 * Phase 7's ad slot. Off by default; the layout reserves the space either way
 * so enabling it shifts nothing (CLAUDE.md §9).
 */
export const ADS_ENABLED = import.meta.env['VITE_ADS_ENABLED'] === 'true';

/** Height of the reserved ad slot, in CSS pixels. Reserved whether or not it is on. */
export const AD_SLOT_HEIGHT_PX = 50;

/**
 * Route Overpass through a pass-through proxy instead of calling instances
 * directly. OFF by default — the proxy itself is not built (CLAUDE.md §11,
 * Phase 2 seam).
 */
export const PROXY_ENABLED = import.meta.env['VITE_OVERPASS_PROXY_ENABLED'] === 'true';

/** Endpoint the proxy seam forwards raw Overpass QL to when enabled. */
export const PROXY_ENDPOINT: string = import.meta.env['VITE_OVERPASS_PROXY_URL'] ?? '';

/* ------------------------------------------------------------------ *
 * Disclaimer  (CLAUDE.md §10)
 * ------------------------------------------------------------------ */

/** localStorage keys. Bump a version suffix to re-show a changed disclaimer. */
export const STORAGE_KEYS = {
  lastLocation: 'pawpath.lastLocation.v1',
  disclaimerAccepted: 'pawpath.disclaimer.v1',
  enabledLayers: 'pawpath.layers.v1',
} as const;

/* ------------------------------------------------------------------ *
 * Recon page (Phase 1, dev only)
 * ------------------------------------------------------------------ */

export const RECON_DEFAULT_RADIUS_KM = 2;

/**
 * Politeness pacing for the recon page. Run 1 fired queries back-to-back and
 * spent most of its wall clock in Overpass's queue: healthy responses came back
 * in 1–3 s, while the 35–80 s times and every 504 were our own burst waiting on
 * itself. Slowing down makes a survey both kinder and *faster* end to end.
 */
export const RECON_MIN_QUERY_INTERVAL_MS = 5_000;

/** Pause between presets when surveying several locations in one go. */
export const RECON_PRESET_INTERVAL_MS = 30_000;

/**
 * Test locations for the coverage survey. Two home markets plus two controls
 * outside Europe — one dense-mapping city and one where OSM amenity mapping is
 * known to be thinner, so the "elsewhere" answer is not one lucky sample.
 */
export const RECON_PRESETS = [
  { label: 'Almere, NL', lat: 52.3508, lng: 5.2647, country: 'NL' },
  { label: 'Leipzig, DE', lat: 51.3397, lng: 12.3731, country: 'DE' },
  { label: 'Melbourne, AU', lat: -37.8136, lng: 144.9631, country: 'AU' },
  { label: 'Bogotá, CO', lat: 4.711, lng: -74.0721, country: 'CO' },
] as const;

/**
 * Coverage verdict thresholds for the recon table, expressed as features per
 * km². Rough, but they turn a raw count into the yes/no answer Phase 1 needs:
 * is there enough data here to justify a toggle?
 */
export const RECON_DENSITY_THRESHOLDS = {
  /** At or above this, the layer is clearly worth a toggle. */
  good: 1.0,
  /** Between `thin` and `good`: usable, but sparse enough to feel empty. */
  thin: 0.2,
} as const;
