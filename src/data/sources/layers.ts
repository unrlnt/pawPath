/**
 * The declarative layer → OSM tag map.
 *
 * This is the ONLY place layers are defined. Query building, normalisation,
 * level derivation and the recon page are all driven from this table, so a new
 * layer is added here and nowhere else.
 */

import { DEFAULT_DISABLED_LEVELS, WALKABLE_HIGHWAY_TYPES } from '../../config';
import { surfaceKindFor, pawRiskForSurfaceKind } from '../../lib/surface';

/**
 * Anchored alternation of the walkable highway types, for Overpass's `~`
 * operator. Anchors matter: unanchored, `path` would also match `footpath` and
 * `cyclepath`.
 */
export const WALKABLE_HIGHWAY_PATTERN = `^(${WALKABLE_HIGHWAY_TYPES.join('|')})$`;

/* ------------------------------------------------------------------ *
 * Selector vocabulary
 * ------------------------------------------------------------------ */

export type OsmElementKind = 'node' | 'way' | 'relation';

/**
 * One tag condition. Conditions within a selector are ANDed by Overpass, which
 * is why `surface` can be restricted to highways rather than matching every
 * tagged polygon in the tile.
 */
export type TagCondition =
  | { readonly op: 'equals'; readonly key: string; readonly value: string }
  | { readonly op: 'notEquals'; readonly key: string; readonly value: string }
  | { readonly op: 'exists'; readonly key: string }
  | { readonly op: 'matches'; readonly key: string; readonly pattern: string };

/**
 * A single queryable tag combination. Selectors are the unit the recon page
 * reports on — "does `amenity=waste_basket` actually exist in Leipzig" is a
 * per-selector question, not a per-layer one.
 */
export interface TagSelector {
  /** Stable id, `<layerKey>.<slug>`. Used as the recon table row key. */
  readonly id: string;
  /** Human-readable tag expression, e.g. `amenity=bench`. */
  readonly label: string;
  readonly kinds: readonly OsmElementKind[];
  readonly conditions: readonly TagCondition[];
}

/* ------------------------------------------------------------------ *
 * Levels
 *
 * Most symbols encode a level rather than mere presence (CLAUDE.md §6). The
 * level is derived from tags at normalisation time so the render layer never
 * has to reach back into raw OSM tags.
 * ------------------------------------------------------------------ */

/*
 * Levels are declared as const arrays and their types derived from them, so
 * there is exactly one list of valid values — one that config values can be
 * checked against at runtime (see `isFeatureLevel`).
 */

export const SHADE_LEVELS = ['dense', 'medium', 'light'] as const;
export type ShadeLevel = (typeof SHADE_LEVELS)[number];

/**
 * `dog=off_leash` DOES NOT EXIST in OSM. It was queried in Run 1 and returned
 * zero features in all four cities, which was our bug, not missing data. The
 * documented values are `yes` / `no` / `leashed` / `unleashed` / `designated`.
 *
 * `allowed_leash_unknown` (`dog=yes`) is a distinct level for a reason — see
 * `offLeashLevel` below. It must never be collapsed into `off_leash`.
 */
export const OFF_LEASH_LEVELS = [
  'off_leash',
  'off_leash_fenced',
  'leashed',
  'prohibited',
  'allowed_leash_unknown',
] as const;
export type OffLeashLevel = (typeof OFF_LEASH_LEVELS)[number];

/** Paw-heat risk of the surface, not its material. */
export const SURFACE_LEVELS = ['high', 'mid', 'low'] as const;
export type SurfaceLevel = (typeof SURFACE_LEVELS)[number];

export const WASTE_LEVELS = ['general', 'dog_bin', 'bag_dispenser'] as const;
export type WasteLevel = (typeof WASTE_LEVELS)[number];

/**
 * Phase 1 can only tell monitored from unmonitored candidates; the third
 * state ('warning') arrives in Phase 6 from the warnings source.
 */
export const WATER_LEVELS = ['warning', 'monitored', 'candidate'] as const;
export type WaterLevel = (typeof WATER_LEVELS)[number];

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

/**
 * `DEFAULT_DISABLED_LEVELS` from config, narrowed to real levels. A typo there
 * becomes an empty filter rather than a silent no-op, and the test suite
 * asserts nothing was dropped.
 */
export const DEFAULT_DISABLED_FEATURE_LEVELS: readonly FeatureLevel[] =
  DEFAULT_DISABLED_LEVELS.filter(isFeatureLevel);

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
  /**
   * Amenity layers are point-ish and return fast; area layers are polygon-ish
   * and are slow. Phase 4's progressive render fetches `amenity` first.
   */
  readonly kind: 'amenity' | 'area';
  /**
   * `center` asks Overpass for a single representative coordinate per element
   * (cheap); `geom` asks for full node lists (expensive, needed to draw
   * polygons in Phase 5).
   */
  readonly defaultOutput: 'center' | 'geom';
  readonly selectors: readonly TagSelector[];
  /** Derives the level from raw tags. Absent means the layer is flat. */
  readonly level?: (tags: Readonly<Record<string, string>>) => FeatureLevel | undefined;
  /** Anything the recon results need read alongside them. */
  readonly note?: string;
}

const shadeLevel = (tags: Readonly<Record<string, string>>): ShadeLevel | undefined => {
  if (tags['natural'] === 'wood' || tags['landuse'] === 'forest') return 'dense';
  if (tags['natural'] === 'scrub') return 'medium';
  if (tags['natural'] === 'tree_row') return 'light';
  return undefined;
};

/**
 * DO NOT MAP `dog=yes` TO AN OFF-LEASH LEVEL. Ever.
 *
 * `dog=yes` means dogs are permitted. It says nothing whatsoever about leashes:
 * the OSM default is that local leash law applies, and in the Netherlands and
 * Germany that means leashed. Treating it as off-leash would tell someone their
 * dog may run free somewhere it legally may not — the worst failure this app
 * can have. It gets its own `allowed_leash_unknown` level, renders neutrally
 * (never green), and is OFF by default in the filter
 * (`DEFAULT_DISABLED_LEVELS` in `config.ts`).
 *
 * Explicit `dog=*` wins over `leisure=dog_park` because it is the more specific
 * claim, except for `dog=yes`, which asserts nothing a dog_park does not
 * already say better.
 */
const offLeashLevel = (tags: Readonly<Record<string, string>>): OffLeashLevel | undefined => {
  const dog = tags['dog'];
  if (dog === 'unleashed' || dog === 'designated') return 'off_leash';
  if (dog === 'leashed') return 'leashed';
  if (dog === 'no') return 'prohibited';
  // A fenced, purpose-built area: off-leash, but bounded. Distinct from an open
  // off-leash zone because the advice to a walker differs.
  if (tags['leisure'] === 'dog_park') return 'off_leash_fenced';
  if (dog === 'yes') return 'allowed_leash_unknown';
  return undefined;
};

const surfaceLevel = (tags: Readonly<Record<string, string>>): SurfaceLevel | undefined => {
  const kind = surfaceKindFor(tags['surface']);
  return kind === undefined ? undefined : pawRiskForSurfaceKind(kind);
};

/**
 * `vending=excrement_bags` is checked first and without requiring an `amenity`
 * tag: Run 1 paired the two and found 1 dispenser in Leipzig and 0 in Almere,
 * because the tag is frequently used alone. It is also roughly 50× more common
 * than `waste=dog_excrement`.
 */
const wasteLevel = (tags: Readonly<Record<string, string>>): WasteLevel | undefined => {
  if (tags['vending'] === 'excrement_bags') return 'bag_dispenser';
  const amenity = tags['amenity'];
  if (tags['waste'] === 'dog_excrement') return 'dog_bin';
  if (amenity !== undefined && DOG_WASTE_AMENITY_PATTERN.test(amenity)) return 'dog_bin';
  if (amenity === 'waste_basket') return 'general';
  return undefined;
};

/** Long tail of dog-specific bin tagging. Kept in sync with the selector below. */
const DOG_WASTE_AMENITY_PATTERN = /dog_waste.*|dog_excrement/;

/**
 * Phase 1 has no warnings feed and no EEA join, so everything OSM knows about
 * is a *candidate* bathing location at best. Phase 6 upgrades matched
 * locations to 'monitored' / 'warning'. Nothing is ever rendered green.
 */
const waterLevel = (): WaterLevel => 'candidate';

export const LAYERS: Readonly<Record<LayerKey, LayerDefinition>> = {
  shade: {
    key: 'shade',
    label: 'Shade',
    kind: 'area',
    defaultOutput: 'geom',
    level: shadeLevel,
    selectors: [
      {
        id: 'shade.wood',
        label: 'natural=wood',
        kinds: ['way', 'relation'],
        conditions: [{ op: 'equals', key: 'natural', value: 'wood' }],
      },
      {
        id: 'shade.forest',
        label: 'landuse=forest',
        kinds: ['way', 'relation'],
        conditions: [{ op: 'equals', key: 'landuse', value: 'forest' }],
      },
      {
        id: 'shade.treeRow',
        label: 'natural=tree_row',
        kinds: ['way'],
        conditions: [{ op: 'equals', key: 'natural', value: 'tree_row' }],
      },
      {
        id: 'shade.scrub',
        label: 'natural=scrub',
        kinds: ['way', 'relation'],
        conditions: [{ op: 'equals', key: 'natural', value: 'scrub' }],
      },
    ],
  },

  offLeash: {
    key: 'offLeash',
    label: 'Off-leash',
    kind: 'area',
    defaultOutput: 'geom',
    level: offLeashLevel,
    note:
      'dog=* and leisure=dog_park are independent sources, not alternatives. ' +
      'Expect this layer to be sparse everywhere: dog=unleashed had only ~200 ' +
      'uses globally as of 2020. In NL especially, off-leash areas are ' +
      'municipal data that is largely absent from OSM. dog=yes is NOT ' +
      'off-leash and is off by default.',
    /*
     * dog=unleashed, dog=designated and dog=leashed are FIRST-CLASS selectors,
     * not a fallback for leisure=dog_park. Off-leash zones frequently exist
     * inside ordinary parks, forests and beaches with no dog_park feature
     * present; in the Netherlands a "losloopgebied" is normally exactly that.
     * A dog_park-only query would silently miss them.
     *
     * Sparse dog=* coverage is EXPECTED, not a bug: dog=unleashed had roughly
     * 200 uses worldwide as of 2020, and Dutch off-leash zones live in
     * municipal datasets rather than OSM (see Phase 8). Thin numbers in a
     * region are a coverage finding for CLAUDE.md §12 — never a reason to drop
     * the tag or to widen dog=yes into off-leash to fill the gap.
     *
     * dog=off_leash was queried in Run 1 and is NOT a valid OSM value; it
     * returned 0 in all four cities. Do not reintroduce it.
     */
    selectors: [
      {
        id: 'offLeash.dogUnleashed',
        label: 'dog=unleashed',
        kinds: ['node', 'way', 'relation'],
        conditions: [{ op: 'equals', key: 'dog', value: 'unleashed' }],
      },
      {
        id: 'offLeash.dogDesignated',
        label: 'dog=designated',
        kinds: ['node', 'way', 'relation'],
        conditions: [{ op: 'equals', key: 'dog', value: 'designated' }],
      },
      {
        id: 'offLeash.dogPark',
        label: 'leisure=dog_park',
        kinds: ['node', 'way', 'relation'],
        conditions: [{ op: 'equals', key: 'leisure', value: 'dog_park' }],
      },
      {
        id: 'offLeash.dogLeashed',
        label: 'dog=leashed',
        kinds: ['node', 'way', 'relation'],
        conditions: [{ op: 'equals', key: 'dog', value: 'leashed' }],
      },
      {
        id: 'offLeash.dogNo',
        label: 'dog=no',
        kinds: ['node', 'way', 'relation'],
        conditions: [{ op: 'equals', key: 'dog', value: 'no' }],
      },
      {
        // Permission only — no leash information. See offLeashLevel.
        id: 'offLeash.dogYes',
        label: 'dog=yes',
        kinds: ['node', 'way', 'relation'],
        conditions: [{ op: 'equals', key: 'dog', value: 'yes' }],
      },
    ],
  },

  surface: {
    key: 'surface',
    label: 'Surface',
    kind: 'area',
    defaultOutput: 'geom',
    level: surfaceLevel,
    note:
      'Restricted to the walkable highway types in WALKABLE_HIGHWAY_TYPES. ' +
      'Run 1 measured 700–780 features/km² with all highway types — about 2,800 ' +
      'per 2 km tile, not viable client-side — and a motorway surface is ' +
      'irrelevant to a dog walk.',
    selectors: [
      {
        id: 'surface.walkway',
        label: `highway~${WALKABLE_HIGHWAY_PATTERN} + surface=*`,
        kinds: ['way'],
        conditions: [
          { op: 'matches', key: 'highway', pattern: WALKABLE_HIGHWAY_PATTERN },
          { op: 'exists', key: 'surface' },
        ],
      },
    ],
  },

  water: {
    key: 'water',
    label: 'Water',
    kind: 'area',
    defaultOutput: 'geom',
    level: waterLevel,
    note:
      'OSM only supplies candidate water bodies. Monitoring status and active ' +
      'warnings come from EEA WISE and the national portals in Phase 6. Never ' +
      'render a green "safe" state from this layer alone.',
    selectors: [
      {
        id: 'water.natural',
        label: 'natural=water',
        kinds: ['way', 'relation'],
        conditions: [{ op: 'equals', key: 'natural', value: 'water' }],
      },
      {
        id: 'water.swimmingArea',
        label: 'leisure=swimming_area',
        kinds: ['node', 'way', 'relation'],
        conditions: [{ op: 'equals', key: 'leisure', value: 'swimming_area' }],
      },
      {
        id: 'water.beach',
        label: 'natural=beach',
        kinds: ['node', 'way', 'relation'],
        conditions: [{ op: 'equals', key: 'natural', value: 'beach' }],
      },
    ],
  },

  benches: {
    key: 'benches',
    label: 'Benches',
    kind: 'amenity',
    defaultOutput: 'center',
    selectors: [
      {
        id: 'benches.bench',
        label: 'amenity=bench',
        kinds: ['node', 'way'],
        conditions: [{ op: 'equals', key: 'amenity', value: 'bench' }],
      },
    ],
  },

  waste: {
    key: 'waste',
    label: 'Waste bins & bag dispensers',
    kind: 'amenity',
    defaultOutput: 'center',
    level: wasteLevel,
    note:
      'vending=excrement_bags is queried on its own, on any element type. Run 1 ' +
      'required amenity=vending_machine alongside it and found 1 dispenser in ' +
      'Leipzig and 0 in Almere; the tag is frequently used with no amenity tag ' +
      'at all, and is ~50× more common than waste=dog_excrement. The ' +
      'dog_waste/dog_excrement amenity regex catches the long tail.',
    selectors: [
      {
        id: 'waste.basket',
        label: 'amenity=waste_basket',
        kinds: ['node', 'way'],
        conditions: [{ op: 'equals', key: 'amenity', value: 'waste_basket' }],
      },
      {
        // Overlaps waste.basket by design: the recon page counts selectors
        // independently, so this shows how many bins are dog-specific.
        id: 'waste.dogBin',
        label: 'amenity=waste_basket + waste=dog_excrement',
        kinds: ['node', 'way'],
        conditions: [
          { op: 'equals', key: 'amenity', value: 'waste_basket' },
          { op: 'equals', key: 'waste', value: 'dog_excrement' },
        ],
      },
      {
        id: 'waste.bagDispenser',
        label: 'vending=excrement_bags',
        kinds: ['node', 'way', 'relation'],
        conditions: [{ op: 'equals', key: 'vending', value: 'excrement_bags' }],
      },
      {
        id: 'waste.dogWasteAmenity',
        label: `amenity~${DOG_WASTE_AMENITY_PATTERN.source}`,
        kinds: ['node', 'way'],
        conditions: [
          { op: 'matches', key: 'amenity', pattern: DOG_WASTE_AMENITY_PATTERN.source },
        ],
      },
    ],
  },

  drinkingWater: {
    key: 'drinkingWater',
    label: 'Drinking water',
    kind: 'amenity',
    defaultOutput: 'center',
    note: 'Expected to be sparse in NL — one of the layers Phase 1 is meant to judge.',
    selectors: [
      {
        id: 'drinkingWater.drinkingWater',
        label: 'amenity=drinking_water',
        kinds: ['node', 'way'],
        conditions: [{ op: 'equals', key: 'amenity', value: 'drinking_water' }],
      },
      {
        id: 'drinkingWater.waterPoint',
        label: 'amenity=water_point',
        kinds: ['node', 'way'],
        conditions: [{ op: 'equals', key: 'amenity', value: 'water_point' }],
      },
    ],
  },
};

export const ALL_LAYERS: readonly LayerDefinition[] = LAYER_KEYS.map((key) => LAYERS[key]);

/** Every selector across every layer, paired with its owning layer. */
export const ALL_SELECTORS: readonly {
  layer: LayerDefinition;
  selector: TagSelector;
}[] = ALL_LAYERS.flatMap((layer) =>
  layer.selectors.map((selector) => ({ layer, selector })),
);

export function isLayerKey(value: string): value is LayerKey {
  return (LAYER_KEYS as readonly string[]).includes(value);
}
