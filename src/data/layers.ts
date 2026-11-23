/**
 * The declarative layer table — the ONE definition of what PawPath shows.
 *
 * Everything else is derived from it:
 *  - the Planetiler schema that builds our vector tiles
 *    (`tools/tiles/generateSchema.ts` → `tools/tiles/pawpath.schema.yml`);
 *  - the in-app evaluator below, used by tests and by popups;
 *  - the map styling, which keys off `LayerKey` and `FeatureLevel`.
 *
 * Levels are ORDERED RULES, first match wins. That is exactly how Planetiler's
 * match expressions work, so the build and the app cannot disagree about which
 * level a feature gets — and `layerExamples.ts` is checked against both
 * (vitest here, `planetiler verify` for the build).
 */

import { DEFAULT_DISABLED_LEVELS, LAYER_MIN_ZOOM, WALKABLE_HIGHWAY_TYPES } from '../config';
import { SURFACE_VALUES_BY_RISK } from '../lib/surface';

/* ------------------------------------------------------------------ *
 * Tag vocabulary
 * ------------------------------------------------------------------ */

/**
 * One tag condition. Conditions inside a selector or a level rule are ANDed.
 *
 * Deliberately small: every operator here has an exact equivalent in
 * Planetiler's structured boolean expressions, so the schema generator never
 * has to approximate.
 */
export type TagCondition =
  | { readonly op: 'equals'; readonly key: string; readonly value: string }
  | { readonly op: 'oneOf'; readonly key: string; readonly values: readonly string[] }
  /** Value starts with `prefix`. Planetiler: `prefix%`. */
  | { readonly op: 'prefix'; readonly key: string; readonly prefix: string }
  | { readonly op: 'exists'; readonly key: string };

/**
 * How a matched OSM element becomes a tile geometry.
 *  - `polygon` / `line` / `point` pass the element through as that type;
 *  - `centroid` turns any element (a bench mapped as a way, say) into a point.
 */
export type OutputGeometry = 'polygon' | 'line' | 'point' | 'centroid';

export interface TagSelector {
  /** Stable id, `<layerKey>.<slug>`. */
  readonly id: string;
  /** Human-readable tag expression, e.g. `amenity=bench`. */
  readonly label: string;
  readonly geometries: readonly OutputGeometry[];
  readonly conditions: readonly TagCondition[];
}

/* ------------------------------------------------------------------ *
 * Levels
 *
 * Declared as const arrays with types derived, so config values can be
 * checked against the real list at runtime (`isFeatureLevel`).
 * ------------------------------------------------------------------ */

export const SHADE_LEVELS = ['dense', 'medium', 'light'] as const;

/**
 * `dog=off_leash` DOES NOT EXIST in OSM — querying it was Run 1's bug. The
 * documented values are yes / no / leashed / unleashed / designated.
 *
 * `allowed_leash_unknown` (`dog=yes`) is its own level for a reason; see the
 * offLeash rules below. It must never be collapsed into `off_leash`.
 */
export const OFF_LEASH_LEVELS = [
  'off_leash',
  'off_leash_fenced',
  'leashed',
  'prohibited',
  'allowed_leash_unknown',
] as const;

/** Paw-heat risk of the surface, not its material. */
export const SURFACE_LEVELS = ['high', 'mid', 'low'] as const;

export const WASTE_LEVELS = ['general', 'dog_bin', 'bag_dispenser'] as const;

/**
 * Only 'candidate' can be derived from OSM. 'monitored' and 'warning' come
 * from EEA and the national feeds in Phase 6. Nothing is ever rendered green.
 */
export const WATER_LEVELS = ['warning', 'monitored', 'candidate'] as const;

export const ALL_FEATURE_LEVELS = [
  ...SHADE_LEVELS,
  ...OFF_LEASH_LEVELS,
  ...SURFACE_LEVELS,
  ...WASTE_LEVELS,
  ...WATER_LEVELS,
] as const;

export type FeatureLevel = (typeof ALL_FEATURE_LEVELS)[number];

export function isFeatureLevel(value: string): value is FeatureLevel {
  return (ALL_FEATURE_LEVELS as readonly string[]).includes(value);
}

/** `DEFAULT_DISABLED_LEVELS` from config, narrowed. A test asserts none were dropped. */
export const DEFAULT_DISABLED_FEATURE_LEVELS: readonly FeatureLevel[] =
  DEFAULT_DISABLED_LEVELS.filter(isFeatureLevel);

/** First matching rule wins. */
export interface LevelRule {
  readonly level: FeatureLevel;
  /** ANDed. An empty list always matches (use it last, as a default). */
  readonly when: readonly TagCondition[];
}

/* ------------------------------------------------------------------ *
 * Layer definitions
 * ------------------------------------------------------------------ */

export const LAYER_KEYS = [
  'shade',
  'offLeash',
  'surface',
  'water',
  'benches',
  'waste',
  'drinkingWater',
] as const;

export type LayerKey = (typeof LAYER_KEYS)[number];

export interface LayerDefinition {
  readonly key: LayerKey;
  readonly label: string;
  /** Points of interest vs areas and lines. Drives styling defaults. */
  readonly kind: 'amenity' | 'area';
  /** Lowest zoom the layer is built into the tiles at (mirrored in config). */
  readonly minZoom: number;
  /** An element is in the layer if ANY selector matches. */
  readonly selectors: readonly TagSelector[];
  /** Absent means the layer is flat (no level attribute). */
  readonly levels?: readonly LevelRule[];
  /** OSM tags copied into the tile for popups. Never the full tag set. */
  readonly keepTags: readonly string[];
  readonly note?: string;
  /**
   * A non-OSM source feeding this layer at build time (Phase 6 onwards). The
   * generator adds it to the Planetiler schema; `selectors` stay OSM-only.
   */
  readonly externalSource?: ExternalSourceKey;
}

/** Build-time sources other than OSM. Each is a `sources:` entry in the schema. */
export const EXTERNAL_SOURCES = {
  /**
   * Official EU bathing water sites (EEA, Bathing Water Directive), fetched by
   * tools/tiles/fetch-bathing-waters.sh. Properties: bwid, name, category,
   * quality, quality_year, profile, country. Point geometry.
   *
   * `requiredProperty`: only features carrying it reach the tiles. The fetch
   * script's fallback (EEA unreachable) writes one placeholder point without
   * it, because Planetiler 0.10.2 crashes on a GeoJSON file with no features.
   */
  eeaBathingWater: {
    id: 'eea_bathing',
    arg: 'bathing_path',
    defaultPath: 'data/bathing-waters.geojson',
    requiredProperty: 'bwid',
  },
} as const;

export type ExternalSourceKey = keyof typeof EXTERNAL_SOURCES;

const eq = (key: string, value: string): TagCondition => ({ op: 'equals', key, value });

/**
 * Off-leash selectors, each in two shapes:
 *  - as an area or a point (parks, forests, beaches, dog parks);
 *  - as a line, but ONLY on paths (`highway=*`) — e.g. `dog=no` on a footway.
 *
 * The split exists because Planetiler treats a closed OSM way as both a
 * possible line and a possible polygon; without it every park outline would be
 * drawn twice.
 */
const OFF_LEASH_TAGS: readonly { slug: string; label: string; condition: TagCondition }[] = [
  { slug: 'dogUnleashed', label: 'dog=unleashed', condition: eq('dog', 'unleashed') },
  { slug: 'dogDesignated', label: 'dog=designated', condition: eq('dog', 'designated') },
  { slug: 'dogPark', label: 'leisure=dog_park', condition: eq('leisure', 'dog_park') },
  { slug: 'dogLeashed', label: 'dog=leashed', condition: eq('dog', 'leashed') },
  { slug: 'dogNo', label: 'dog=no', condition: eq('dog', 'no') },
  // Permission only — says nothing about leashes. See the offLeash rules.
  { slug: 'dogYes', label: 'dog=yes', condition: eq('dog', 'yes') },
];

const OFF_LEASH_SELECTORS: readonly TagSelector[] = OFF_LEASH_TAGS.flatMap(
  ({ slug, label, condition }): TagSelector[] => [
    { id: `offLeash.${slug}`, label, geometries: ['polygon', 'point'], conditions: [condition] },
    {
      id: `offLeash.${slug}.path`,
      label: `${label} on a path`,
      geometries: ['line'],
      conditions: [condition, { op: 'exists', key: 'highway' }],
    },
  ],
);

/**
 * Surface values we can score. An unscored value draws nothing (§2.6), so the
 * selector itself requires a known value rather than any `surface=*`.
 */
const SCORED_SURFACES: readonly string[] = [
  ...SURFACE_VALUES_BY_RISK.high,
  ...SURFACE_VALUES_BY_RISK.mid,
  ...SURFACE_VALUES_BY_RISK.low,
];

export const LAYERS: Readonly<Record<LayerKey, LayerDefinition>> = {
  shade: {
    key: 'shade',
    label: 'Shade',
    kind: 'area',
    minZoom: LAYER_MIN_ZOOM.shade,
    keepTags: ['name', 'leaf_type'],
    selectors: [
      { id: 'shade.wood', label: 'natural=wood', geometries: ['polygon'], conditions: [eq('natural', 'wood')] },
      { id: 'shade.forest', label: 'landuse=forest', geometries: ['polygon'], conditions: [eq('landuse', 'forest')] },
      { id: 'shade.scrub', label: 'natural=scrub', geometries: ['polygon'], conditions: [eq('natural', 'scrub')] },
      { id: 'shade.treeRow', label: 'natural=tree_row', geometries: ['line'], conditions: [eq('natural', 'tree_row')] },
    ],
    levels: [
      { level: 'dense', when: [eq('natural', 'wood')] },
      { level: 'dense', when: [eq('landuse', 'forest')] },
      { level: 'medium', when: [eq('natural', 'scrub')] },
      { level: 'light', when: [eq('natural', 'tree_row')] },
    ],
  },

  offLeash: {
    key: 'offLeash',
    label: 'Off-leash & dog rules',
    kind: 'area',
    minZoom: LAYER_MIN_ZOOM.offLeash,
    keepTags: ['name', 'dog', 'leisure', 'barrier'],
    note:
      'dog=* and leisure=dog_park are independent sources, not alternatives. ' +
      'Expect sparse data: dog=unleashed had ~200 uses worldwide in 2020, and ' +
      'Dutch losloopgebieden are municipal data largely absent from OSM.',
    /*
     * dog=unleashed / designated / leashed / no are FIRST-CLASS selectors.
     * Off-leash zones usually sit inside ordinary parks, forests and beaches
     * with no dog_park feature; a dog_park-only query would miss them.
     * dog=off_leash is NOT a valid value — do not reintroduce it.
     */
    selectors: OFF_LEASH_SELECTORS,
    /*
     * DO NOT MAP dog=yes TO AN OFF-LEASH LEVEL. Ever.
     *
     * dog=yes means dogs are permitted and nothing more: the OSM default is
     * that local leash law applies, which in NL and DE means leashed. Showing
     * it as off-leash would tell someone their dog may run free where it may
     * not — the worst failure this app can have. It gets its own level, renders
     * neutrally (never green) and is off by default (DEFAULT_DISABLED_LEVELS).
     *
     * Order matters: an explicit dog=* beats leisure=dog_park because it is the
     * more specific claim — except dog=yes, which says less than a dog park does.
     */
    levels: [
      { level: 'off_leash', when: [{ op: 'oneOf', key: 'dog', values: ['unleashed', 'designated'] }] },
      { level: 'leashed', when: [eq('dog', 'leashed')] },
      { level: 'prohibited', when: [eq('dog', 'no')] },
      { level: 'off_leash_fenced', when: [eq('leisure', 'dog_park')] },
      { level: 'allowed_leash_unknown', when: [eq('dog', 'yes')] },
    ],
  },

  surface: {
    key: 'surface',
    label: 'Path surface',
    kind: 'area',
    minZoom: LAYER_MIN_ZOOM.surface,
    keepTags: ['surface', 'highway', 'name'],
    note:
      'Restricted to walkable highway types and to surface values the paw ' +
      'model can score. 700–780 features/km² were measured with all highways.',
    selectors: [
      {
        id: 'surface.walkway',
        label: 'highway∈walkable + surface∈scored',
        geometries: ['line'],
        conditions: [
          { op: 'oneOf', key: 'highway', values: WALKABLE_HIGHWAY_TYPES },
          { op: 'oneOf', key: 'surface', values: SCORED_SURFACES },
        ],
      },
    ],
    levels: [
      { level: 'high', when: [{ op: 'oneOf', key: 'surface', values: SURFACE_VALUES_BY_RISK.high }] },
      { level: 'mid', when: [{ op: 'oneOf', key: 'surface', values: SURFACE_VALUES_BY_RISK.mid }] },
      { level: 'low', when: [{ op: 'oneOf', key: 'surface', values: SURFACE_VALUES_BY_RISK.low }] },
    ],
  },

  water: {
    key: 'water',
    label: 'Water',
    kind: 'area',
    minZoom: LAYER_MIN_ZOOM.water,
    keepTags: ['bwid', 'name', 'category', 'quality', 'quality_year', 'profile', 'country'],
    note:
      'Official EU bathing sites only (EEA). Unmonitored water — ponds, ditches, ' +
      'canals — is never drawn (§6). Warnings arrive at runtime from ' +
      'water-warnings.json when a source with clear terms exists. Never "safe".',
    /*
     * No OSM selectors on purpose: OSM cannot tell a monitored bathing site
     * from any pond, and §6 says unmonitored water draws nothing. Phase 2R
     * shipped natural=water / swimming_area / beach as "candidate" — never
     * drawn, only bytes; removed in Phase 6.
     */
    selectors: [],
    externalSource: 'eeaBathingWater',
    levels: [{ level: 'monitored', when: [] }],
  },

  benches: {
    key: 'benches',
    label: 'Benches',
    kind: 'amenity',
    minZoom: LAYER_MIN_ZOOM.benches,
    keepTags: ['backrest', 'material'],
    selectors: [
      { id: 'benches.bench', label: 'amenity=bench', geometries: ['centroid'], conditions: [eq('amenity', 'bench')] },
    ],
  },

  waste: {
    key: 'waste',
    label: 'Bins & bag dispensers',
    kind: 'amenity',
    minZoom: LAYER_MIN_ZOOM.waste,
    keepTags: ['waste', 'vending'],
    note:
      'vending=excrement_bags is matched on its own: it is frequently used ' +
      'with no amenity tag, and is ~50× more common than waste=dog_excrement.',
    selectors: [
      { id: 'waste.basket', label: 'amenity=waste_basket', geometries: ['centroid'], conditions: [eq('amenity', 'waste_basket')] },
      { id: 'waste.bagDispenser', label: 'vending=excrement_bags', geometries: ['centroid'], conditions: [eq('vending', 'excrement_bags')] },
      { id: 'waste.dogWasteAmenity', label: 'amenity=dog_waste*', geometries: ['centroid'], conditions: [{ op: 'prefix', key: 'amenity', prefix: 'dog_waste' }] },
      { id: 'waste.dogExcrementAmenity', label: 'amenity=dog_excrement', geometries: ['centroid'], conditions: [eq('amenity', 'dog_excrement')] },
    ],
    levels: [
      { level: 'bag_dispenser', when: [eq('vending', 'excrement_bags')] },
      { level: 'dog_bin', when: [eq('waste', 'dog_excrement')] },
      { level: 'dog_bin', when: [{ op: 'prefix', key: 'amenity', prefix: 'dog_waste' }] },
      { level: 'dog_bin', when: [eq('amenity', 'dog_excrement')] },
      { level: 'general', when: [eq('amenity', 'waste_basket')] },
    ],
  },

  drinkingWater: {
    key: 'drinkingWater',
    label: 'Drinking water',
    kind: 'amenity',
    minZoom: LAYER_MIN_ZOOM.drinkingWater,
    keepTags: ['name', 'bottle', 'dog'],
    note: 'Expected to be sparse in NL.',
    selectors: [
      { id: 'drinkingWater.drinkingWater', label: 'amenity=drinking_water', geometries: ['centroid'], conditions: [eq('amenity', 'drinking_water')] },
      { id: 'drinkingWater.waterPoint', label: 'amenity=water_point', geometries: ['centroid'], conditions: [eq('amenity', 'water_point')] },
    ],
  },
};

export const ALL_LAYERS: readonly LayerDefinition[] = LAYER_KEYS.map((key) => LAYERS[key]);

export function isLayerKey(value: string): value is LayerKey {
  return (LAYER_KEYS as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ *
 * Evaluator — the app-side twin of the generated Planetiler schema
 * ------------------------------------------------------------------ */

export type Tags = Readonly<Record<string, string>>;

export function matchesCondition(tags: Tags, condition: TagCondition): boolean {
  const value = tags[condition.key];
  if (value === undefined) return false;
  switch (condition.op) {
    case 'exists':
      return true;
    case 'equals':
      return value === condition.value;
    case 'oneOf':
      return condition.values.includes(value);
    case 'prefix':
      return value.startsWith(condition.prefix);
  }
}

export const matchesAll = (tags: Tags, conditions: readonly TagCondition[]): boolean =>
  conditions.every((condition) => matchesCondition(tags, condition));

export function matchesLayer(tags: Tags, layer: LayerDefinition): boolean {
  return layer.selectors.some((selector) => matchesAll(tags, selector.conditions));
}

/** The level a matching element gets, or undefined for flat layers / no match. */
export function levelFor(layer: LayerDefinition, tags: Tags): FeatureLevel | undefined {
  if (!matchesLayer(tags, layer)) return undefined;
  return layer.levels?.find((rule) => matchesAll(tags, rule.when))?.level;
}

/** Every layer an element belongs to — layers are independent toggles, not a partition. */
export function layersFor(tags: Tags): readonly LayerKey[] {
  return ALL_LAYERS.filter((layer) => matchesLayer(tags, layer)).map((layer) => layer.key);
}
