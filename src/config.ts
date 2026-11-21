/**
 * All tunables live here. No magic numbers in components, lib functions or
 * data sources — import from this file instead.
 *
 * This module is also imported by the Node build tools (tools/tiles), where
 * `import.meta.env` does not exist — read env vars through `ENV` only.
 */

const ENV: Readonly<Record<string, string | undefined>> =
  (import.meta as { env?: Record<string, string | undefined> }).env ?? {};

/* ------------------------------------------------------------------ *
 * Identity
 * ------------------------------------------------------------------ */

export const APP_NAME = 'PawPath';

/** Sentinel meaning "no contact URL has been set yet". */
export const APP_CONTACT_URL_UNSET = 'UNSET';

/**
 * Public contact for the project — the repository once it is public
 * (CLAUDE.md §11, Phase 7 checklist). Shown in the about/attribution text.
 */
export const APP_CONTACT_URL: string = APP_CONTACT_URL_UNSET;

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
 * on submit only, at most one per `PHOTON_MIN_INTERVAL_MS`, never per keystroke.
 */
export const PHOTON_URL: string = ENV['VITE_PHOTON_URL'] ?? 'https://photon.komoot.io/api/';
export const PHOTON_MIN_QUERY_LENGTH = 3;
export const PHOTON_MIN_INTERVAL_MS = 1_000;
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

export const STORAGE_KEYS = {
  lastLocation: 'pawpath.lastLocation.v1',
  disclaimerAccepted: 'pawpath.disclaimer.v1',
  enabledLayers: 'pawpath.layers.v2',
} as const;
