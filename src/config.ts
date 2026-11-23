/**
 * All tunables live here. No magic numbers in components, lib functions or
 * data sources — import from this file instead.
 *
 * This module is also imported by the Node build tools (tools/tiles), where
 * `import.meta.env` does not exist — read env vars through `ENV` only.
 */

/**
 * Env vars with empty values dropped. docker-compose passes unset build args
 * as EMPTY strings (`${VITE_X:-}`), and `'' ?? default` keeps the ''. On the
 * first live deploy that gave the map an empty style URL (no basemap) and
 * search an empty Photon URL (every search threw). Empty means unset.
 */
export function nonEmptyEnv(raw: Readonly<Record<string, unknown>>): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' && value.trim() !== '') out[key] = value.trim();
  }
  return out;
}

const ENV: Readonly<Record<string, string | undefined>> = nonEmptyEnv(
  (import.meta as { env?: Record<string, unknown> }).env ?? {},
);

/* ------------------------------------------------------------------ *
 * Identity
 * ------------------------------------------------------------------ */

export const APP_NAME = 'PawPath';

/**
 * Public contact for the project: the repository (CLAUDE.md §11, Phase 7
 * checklist). Shown in the disclaimer as "source & feedback". It resolves
 * once the repository is public.
 */
export const APP_CONTACT_URL = 'https://github.com/unrlnt/pawPath';

/* ------------------------------------------------------------------ *
 * Our vector tiles  (CLAUDE.md §3, §8)
 * ------------------------------------------------------------------ */

/** Highest zoom the tiles are built to; MapLibre overzooms above it. */
export const TILE_MAX_ZOOM = 14;

/**
 * Lowest zoom each layer is shown at. Built into the tiles at
 * `min(value, TILE_MAX_ZOOM)` and used by the style and the "zoom in" hint.
 *
 * Surface is held back to z15: it is an order of magnitude denser than every
 * other layer (700–780 features/km² measured with all highways).
 */
export const LAYER_MIN_ZOOM = {
  shade: 11,
  offLeash: 11,
  water: 11,
  surface: 15,
  benches: 13,
  waste: 13,
  drinkingWater: 13,
} as const;

/**
 * Small JSON written by the tile build: `{ "url": "pawpath-YYYYMMDD.pmtiles", ... }`.
 * Served with a short cache lifetime, while the `.pmtiles` it points at is
 * immutable — so a new build never mixes with tiles cached from an old one.
 */
export const TILES_MANIFEST_URL: string = ENV['VITE_TILES_MANIFEST_URL'] ?? '/tiles/manifest.json';

/**
 * Optional runtime water warnings (Phase 6, format in docs/water-warnings.md).
 * Missing file = no warnings known: sites stay "monitored", never "safe".
 */
export const WATER_WARNINGS_URL: string = ENV['VITE_WATER_WARNINGS_URL'] ?? '/tiles/water-warnings.json';

/** How often the app re-reads the warnings file. */
export const WATER_WARNINGS_REFRESH_MS = 30 * 60_000;

/** Official bathing seasons run roughly May–September (1-based months, inclusive). */
export const BATHING_SEASON_MONTHS = { start: 5, end: 9 } as const;

/* ------------------------------------------------------------------ *
 * Conditions  (Phase 3)
 * ------------------------------------------------------------------ */

export const CONDITIONS_TTL_MS = 60 * 60 * 1000; // 1 hour

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
  oakProcessionary: {
    startMonth: 4,
    endMonth: 7,
    /** Months when the stinging hairs are most abundant. */
    peakMonths: [5, 6],
    countries: ['NL', 'DE', 'BE'],
  },
  breedingSeasonLeash: {
    start: { month: 3, day: 1 },
    end: { month: 7, day: 15 },
    countries: ['NL'],
  },
  ticks: {
    /** Daily mean above this for `consecutiveDays` days activates the warning. */
    activationTempC: 7,
    consecutiveDays: 3,
    /** Spring and autumn peaks. */
    peakMonths: [4, 5, 6, 9, 10],
  },
  /**
   * Winter paws (added 2026-11-21, §12): frost and snow mean ice and road salt,
   * both hard on pads. Derived from the forecast, no extra source.
   */
  winterPaws: { frostAtOrBelowC: 0, snowfallCm: 0.1 },
} as const;

/**
 * Rough country boxes for the country-specific advisories above. Deliberately
 * approximate (they overlap at borders): showing the oak-caterpillar note a
 * few km into France is harmless, and it avoids a geocoding call.
 */
export const COUNTRY_BOXES: Readonly<Record<string, { south: number; west: number; north: number; east: number }>> = {
  NL: { south: 50.75, west: 3.2, north: 53.7, east: 7.25 },
  BE: { south: 49.5, west: 2.5, north: 51.5, east: 6.4 },
  DE: { south: 47.25, west: 5.85, north: 55.1, east: 15.05 },
};

/* ------------------------------------------------------------------ *
 * Conditions scoring  (CLAUDE.md §7)
 * ------------------------------------------------------------------ */

/** WHO UV index bands: low < 3, moderate < 6, high < 8, very high < 11, extreme. */
export const UV_BANDS = { moderate: 3, high: 6, veryHigh: 8, extreme: 11 } as const;

/** European AQI bands (EEA): good < 20, fair < 40, moderate < 60, poor < 80, very poor < 100. */
export const AQI_BANDS = { fair: 20, moderate: 40, poor: 60, veryPoor: 80, extremelyPoor: 100 } as const;

/** Precipitation probability (%) that makes an hour "ok" or "poor" for a walk. */
export const RAIN_PROBABILITY = { ok: 30, poor: 60 } as const;

/** A 15-minute slot with at least this much rain (mm) counts as wet. */
export const RAIN_WET_MM_PER_15MIN = 0.1;

/**
 * Heat stress for dogs, on the FELT (apparent) temperature at the location —
 * a general factor, not per path (§7). Rough vet guidance: risk rises from
 * ~20 °C for flat-faced, old, overweight or thick-coated dogs, and from ~28 °C
 * for every dog. Approximate by nature; worded as advice.
 */
export const DOG_HEAT_BANDS_C = { moderate: 20, high: 24, veryHigh: 28, extreme: 32 } as const;

/**
 * Pollen (grains/m³, CAMS, Europe only) — shown as a note, never in the
 * verdict. Thresholds approximate the usual low/moderate/high levels per type.
 */
export const POLLEN_BANDS = {
  grass: { moderate: 20, high: 50 },
  birch: { moderate: 50, high: 100 },
  alder: { moderate: 50, high: 100 },
  mugwort: { moderate: 20, high: 50 },
  ragweed: { moderate: 10, high: 50 },
  olive: { moderate: 50, high: 200 },
} as const;

/** How far ahead the short-range rain window looks. */
export const RAIN_WINDOW_MINUTES = 120;

/** How far ahead the walk window looks (CLAUDE.md §7: next 24 h). */
export const WALK_WINDOW_HOURS = 24;

/* ------------------------------------------------------------------ *
 * Open-Meteo  (CLAUDE.md §5) — free tier is non-commercial
 * ------------------------------------------------------------------ */

export const OPEN_METEO_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
export const OPEN_METEO_AIR_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';

/**
 * Requests are snapped to this grid (degrees) so neighbours share a cache
 * entry and a visitor panning around costs a handful of calls, not hundreds.
 * 0.1° ≈ 11 km — finer than the weather models' own resolution matters for.
 */
export const CONDITIONS_GRID_DEG = 0.1;

/** Past days requested, for the tick rule's consecutive-day check. */
export const CONDITIONS_PAST_DAYS = 3;

export const CONDITIONS_TIMEOUT_MS = 10_000;

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
 * Components read MAP_STYLE_URL and MAP_ATTRIBUTION and nothing else, so
 * swapping provider is an env-var change.
 * ------------------------------------------------------------------ */

/** Default basemap: no key, no request limits (CLAUDE.md §4). */
export const OPENFREEMAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

const MAPTILER_KEY = ENV['VITE_MAPTILER_KEY'] ?? '';

/**
 * Style URL for the basemap. NEVER tile.openstreetmap.org — their usage policy
 * forbids apps like this one.
 */
export const MAP_STYLE_URL: string =
  ENV['VITE_MAP_STYLE_URL'] ??
  (MAPTILER_KEY === ''
    ? OPENFREEMAP_STYLE_URL
    : `https://api.maptiler.com/maps/streets-v2/style.json?key=${MAPTILER_KEY}`);

/**
 * Whether to repaint the basemap in PawPath's palette. Only safe for styles
 * built on the OpenMapTiles schema (OpenFreeMap, MapTiler streets).
 */
export const MAP_RECOLOUR_BASEMAP = ENV['VITE_MAP_RECOLOUR'] !== 'false';

/**
 * Extra basemap credit. Normally unset: OpenFreeMap and MapTiler styles carry
 * their own attribution, and adding it again just duplicates it. Set
 * `VITE_MAP_ATTRIBUTION` only for a style that credits nothing itself.
 */
export const MAP_ATTRIBUTION: string | undefined = ENV['VITE_MAP_ATTRIBUTION'];

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

/**
 * Photon place search (CLAUDE.md §5). Public instance is fair-use: searches run
 * as suggestions while typing (owner, 2026-11-23): after `PHOTON_MIN_QUERY_LENGTH`
 * letters and a `PHOTON_DEBOUNCE_MS` pause, stale requests aborted, recent
 * queries cached, and at most one request per `PHOTON_MIN_INTERVAL_MS`.
 */
export const PHOTON_URL: string = ENV['VITE_PHOTON_URL'] ?? 'https://photon.komoot.io/api/';
export const PHOTON_MIN_QUERY_LENGTH = 3;
export const PHOTON_MIN_INTERVAL_MS = 300;
/** Pause after the last keystroke before suggestions are fetched. */
export const PHOTON_DEBOUNCE_MS = 350;
/** Recent queries answered from memory (typing back and forth costs nothing). */
export const PHOTON_CACHE_SIZE = 50;
export const PHOTON_RESULT_LIMIT = 5;
export const PHOTON_TIMEOUT_MS = 10_000;

/* ------------------------------------------------------------------ *
 * Feature flags
 * ------------------------------------------------------------------ */

/** Phase 7's ad slot. Off by default; the layout reserves the space either way. */
export const ADS_ENABLED = ENV['VITE_ADS_ENABLED'] === 'true';

/** Height of the reserved ad slot, in CSS pixels. */
export const AD_SLOT_HEIGHT_PX = 50;

/* ------------------------------------------------------------------ *
 * localStorage keys. Bump a version suffix to reset a changed value.
 * ------------------------------------------------------------------ */

// ---------------------------------------------------------------------------
// Route planner (Phase 9) — routing runs in the browser on the `walk` layer.
// ---------------------------------------------------------------------------

/** Walking pace for the time estimate, km/h — dog walks are sniff-paced. */
export const ROUTE_WALK_KMH = 4;
/** A waypoint further than this from any path cannot be snapped. */
export const ROUTE_MAX_SNAP_M = 250;
/** Graph tiles loaded around the waypoints' bounding box, metres. */
export const ROUTE_TILE_MARGIN_M = 800;
/** Upper bound on graph tiles per route (~1.5 km each at 52° N). */
export const ROUTE_MAX_TILES = 64;
/** At most this many waypoints per route (also the share-link limit). */
export const ROUTE_MAX_WAYPOINTS = 30;
/** "Add a stop": only amenities at most this far from the current route, metres. */
export const ROUTE_STOP_MAX_OFF_ROUTE_M = 400;
/** An amenity this close to an existing stop counts as already on the route. */
export const ROUTE_STOP_SAME_PLACE_M = 20;
/**
 * "Find nearby": z14 tiles searched around the starting point, widening ring
 * by ring until something is found (1 = 3×3 tiles ≈ 4 km across in NL).
 */
export const NEARBY_TILE_RINGS = [1, 3] as const;
/** How many results "Find nearby" lists. */
export const NEARBY_RESULTS = 3;
/** Saved routes kept in localStorage. */
export const ROUTE_MAX_SAVED = 50;
/** Cost per metre by highway class: 1 = preferred. */
export const ROUTE_HIGHWAY_FACTOR = { preferred: 1, normal: 1.25, tertiary: 2, major: 3.5, unknown: 1.5 } as const;
/** Cost multiplier for surfaces in each live paw band. */
export const ROUTE_HEAT_FACTOR = { fine: 1, caution: 1.8, danger: 4 } as const;
/**
 * Canopy fraction per shade level, fed into the paw model's shade factor
 * (1 − 0.7 × canopy). Forest/wood dense, scrub medium, tree row light.
 */
export const SHADE_CANOPY_FRACTION = { sun: 0, light: 0.3, medium: 0.5, dense: 0.85 } as const;
/**
 * How far to each side of a path to look for woodland, metres. Woods are often
 * mapped with paths as gaps between polygons: wooded on both sides = in the
 * wood, on one side = forest edge (light shade).
 */
export const ROUTE_SHADE_SIDE_REACH_M = 8;
/** A path within this distance of a tree row counts as lightly shaded, metres. */
export const ROUTE_TREE_ROW_REACH_M = 10;
/**
 * Extra cost per metre in full sun, by felt temperature (°C, from): the route
 * leans into shade as it gets warmer — heat stress is about the dog, not the
 * path. Light shade (tree rows) pays half the extra. Checked high to low.
 */
export const ROUTE_SUN_FACTOR_BY_FELT_C = [
  { fromC: DOG_HEAT_BANDS_C.veryHigh, factor: 1.6 },
  { fromC: DOG_HEAT_BANDS_C.high, factor: 1.35 },
  { fromC: DOG_HEAT_BANDS_C.moderate, factor: 1.15 },
] as const;
/** Bonus for explicitly off-leash ways (dog=unleashed/designated). */
export const ROUTE_OFF_LEASH_FACTOR = 0.85;
/** Share of the asphalt heat penalty applied to ways with no mapped surface. */
export const ROUTE_UNKNOWN_SURFACE_HEAT_SHARE = 0.5;

// ---------------------------------------------------------------------------
// Reporting what's missing (Phase 12) — anonymous OpenStreetMap notes.
// ---------------------------------------------------------------------------

/** OSM notes API (JSON). `VITE_OSM_NOTES_URL` can point at the OSM dev server for testing. */
export const OSM_NOTES_URL: string = ENV['VITE_OSM_NOTES_URL'] ?? 'https://api.openstreetmap.org/api/0.6/notes.json';
/** Public page of a note, `{id}` replaced. */
export const OSM_NOTE_PAGE = 'https://www.openstreetmap.org/note/{id}';
/** One note per minute per browser — volunteers read every one. */
export const NOTE_MIN_INTERVAL_MS = 60_000;
/** Where the report crosshair sits, as a fraction of the map height (above the sheet). */
export const REPORT_CROSSHAIR_Y = 0.3;
/** OSM rejects longer note texts. */
export const NOTE_MAX_LENGTH = 2_000;

export const STORAGE_KEYS = {
  lastLocation: 'pawpath.lastLocation.v1',
  disclaimerAccepted: 'pawpath.disclaimer.v1',
  enabledLayers: 'pawpath.layers.v2',
  disabledLevels: 'pawpath.disabledLevels.v1',
  conditionsCard: 'pawpath.conditionsCard.v1',
  /** Prefix: one entry per grid cell, `${prefix}${lat},${lng}`. */
  conditionsCachePrefix: 'pawpath.conditions.v1:',
  savedRoutes: 'pawpath.routes.v1',
  lastNoteAt: 'pawpath.lastNoteAt.v1',
} as const;
