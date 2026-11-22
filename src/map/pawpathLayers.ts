/**
 * MapLibre layers for the PawPath vector source — one source-layer per
 * `LayerKey` (CLAUDE.md §8), coloured by level from the design tokens.
 *
 * Phase 2R draws every layer simply but correctly; Phase 4 adds icons and
 * patterns, Phase 5 live paw-heat recolouring.
 */

import type {
  DataDrivenPropertyValueSpecification,
  ExpressionSpecification,
  FilterSpecification,
  LayerSpecification,
} from 'maplibre-gl';

import { LAYER_MIN_ZOOM } from '../config';
import { LAYER_KEYS, type FeatureLevel, type LayerKey } from '../data/layers';
import { palette, pawRisk, safety } from '../styles/tokens';
import type { PawBand } from '../lib/conditions/paw';
import { PAVED_KINDS, SURFACE_VALUES_BY_KIND } from '../lib/surface';
import type { PawSurfaceKind } from '../config';
import { HATCH, ICONS, iconId } from './icons';

const PAVED_VALUES: string[] = PAVED_KINDS.flatMap((kind) => [...SURFACE_VALUES_BY_KIND[kind]]);

const BAND_COLOUR: Readonly<Record<PawBand, string>> = {
  fine: pawRisk.low,
  caution: pawRisk.mid,
  danger: pawRisk.high,
};

/** Surface layer ids — MapView repaints exactly these when conditions change. */
export const SURFACE_LAYER_IDS = ['pawpath-surface-paved', 'pawpath-surface-unpaved'] as const;

/**
 * Per-path colour and width from the live paw band of each path's OWN surface.
 * Without live data, falls back to the static material risk (`level`).
 * Hotter bands draw wider, so heat does not rely on colour alone.
 */
export function surfacePaint(
  bands: Readonly<Record<PawSurfaceKind, PawBand>> | undefined,
): { 'line-color': DataDrivenPropertyValueSpecification<string>; 'line-width': DataDrivenPropertyValueSpecification<number> } {
  const width = (factor: number): ExpressionSpecification =>
    ['interpolate', ['linear'], ['zoom'], 15, 2 * factor, 18, 6 * factor] as unknown as ExpressionSpecification;
  if (bands === undefined) {
    return { 'line-color': byLevel(pawRisk, palette.inkSoft), 'line-width': width(1) };
  }
  const kinds = Object.keys(SURFACE_VALUES_BY_KIND) as PawSurfaceKind[];
  const colour = [
    'match',
    ['get', 'surface'],
    ...kinds.flatMap((kind) => [[...SURFACE_VALUES_BY_KIND[kind]], BAND_COLOUR[bands[kind]]]),
    palette.inkSoft,
  ] as unknown as ExpressionSpecification;
  const factorFor = (band: PawBand): number => (band === 'danger' ? 1.5 : band === 'caution' ? 1.2 : 1);
  const lineWidth = [
    'interpolate',
    ['linear'],
    ['zoom'],
    15,
    ['match', ['get', 'surface'], ...kinds.flatMap((k) => [[...SURFACE_VALUES_BY_KIND[k]], 2 * factorFor(bands[k])]), 2],
    18,
    ['match', ['get', 'surface'], ...kinds.flatMap((k) => [[...SURFACE_VALUES_BY_KIND[k]], 6 * factorFor(bands[k])]), 6],
  ] as unknown as ExpressionSpecification;
  return { 'line-color': colour, 'line-width': lineWidth };
}

export const PAWPATH_SOURCE_ID = 'pawpath';

type Colour = DataDrivenPropertyValueSpecification<string>;

/** `match` on the `level` property, with a fallback colour. */
function byLevel(colours: Partial<Record<FeatureLevel, string>>, fallback: string): Colour {
  const pairs = Object.entries(colours).flatMap(([level, colour]) => [level, colour]);
  return ['match', ['get', 'level'], ...pairs, fallback] as unknown as ExpressionSpecification;
}

const isPolygon: FilterSpecification = ['==', ['geometry-type'], 'Polygon'];
const isLine: FilterSpecification = ['==', ['geometry-type'], 'LineString'];

/**
 * Hides the levels the user has switched off — `dog=yes` is off until they
 * opt in (§6). Features without a level (flat layers) are never hidden here.
 */
function levelEnabled(disabled: readonly FeatureLevel[]): FilterSpecification {
  return ['!', ['in', ['coalesce', ['get', 'level'], ''], ['literal', [...disabled]]]];
}

/** `icon-image` for a layer: a match on level, falling back to its default. */
function iconFor(layer: LayerKey): DataDrivenPropertyValueSpecification<string> {
  const levels = Object.keys(ICONS[layer] ?? {}).filter((level) => level !== 'default');
  const fallback = iconId(layer, 'default');
  if (levels.length === 0) return fallback;
  return [
    'match',
    ['coalesce', ['get', 'level'], ''],
    ...levels.flatMap((level) => [level, iconId(layer, level as FeatureLevel)]),
    fallback,
  ] as unknown as ExpressionSpecification;
}

/** Icons for points of interest. Rarer, more useful levels win collisions. */
function symbolLayer(
  id: string,
  base: { source: string; 'source-layer': string; minzoom: number },
  layer: LayerKey,
  filter: FilterSpecification,
  sortByLevel?: Partial<Record<FeatureLevel, number>>,
): LayerSpecification {
  return {
    ...base,
    id,
    type: 'symbol',
    filter,
    layout: {
      'icon-image': iconFor(layer),
      'icon-size': ['interpolate', ['linear'], ['zoom'], 13, 0.7, 17, 1.05],
      'icon-allow-overlap': false,
      'icon-padding': 1,
      ...(sortByLevel === undefined
        ? {}
        : {
            'symbol-sort-key': [
              'match',
              ['coalesce', ['get', 'level'], ''],
              ...Object.entries(sortByLevel).flatMap(([level, rank]) => [level, rank]),
              99,
            ] as unknown as ExpressionSpecification,
          }),
    },
  };
}

const all = (...filters: FilterSpecification[]): FilterSpecification =>
  ['all', ...filters] as unknown as FilterSpecification;

const OFF_LEASH_COLOURS: Partial<Record<FeatureLevel, string>> = {
  off_leash: safety.offLeash,
  off_leash_fenced: safety.offLeash,
  leashed: safety.leashed,
  prohibited: safety.prohibited,
  allowed_leash_unknown: safety.neutral,
};

/** Layers per toggle, bottom to top within each. */
function specsFor(key: LayerKey, disabled: readonly FeatureLevel[]): LayerSpecification[] {
  const enabled = levelEnabled(disabled);
  const id = (part: string): string => `pawpath-${key}-${part}`;
  const base = { source: PAWPATH_SOURCE_ID, 'source-layer': key, minzoom: LAYER_MIN_ZOOM[key] };

  switch (key) {
    case 'shade':
      return [
        // A light wash plus a hatch, so our shade reads as "shade" and does
        // not melt into the basemap's own forest green (Phase 5).
        {
          ...base,
          id: id('fill'),
          type: 'fill',
          filter: isPolygon,
          paint: {
            'fill-color': palette.sageDeep,
            'fill-opacity': ['match', ['get', 'level'], 'dense', 0.16, 0.1],
          },
        },
        {
          ...base,
          id: id('hatch'),
          type: 'fill',
          filter: isPolygon,
          paint: {
            'fill-pattern': ['match', ['get', 'level'], 'dense', HATCH.dense, HATCH.medium],
          },
        },
        {
          ...base,
          id: id('rows'),
          type: 'line',
          filter: isLine,
          // Round dots along the row: reads as a line of trees.
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': palette.sageDeep,
            'line-opacity': 0.8,
            'line-width': ['interpolate', ['linear'], ['zoom'], 12, 3, 17, 8],
            'line-dasharray': [0, 1.6],
          },
        },
      ];
    case 'offLeash':
      return [
        {
          ...base,
          id: id('fill'),
          type: 'fill',
          filter: all(isPolygon, enabled),
          paint: { 'fill-color': byLevel(OFF_LEASH_COLOURS, safety.neutral), 'fill-opacity': 0.28 },
        },
        {
          ...base,
          id: id('outline'),
          type: 'line',
          filter: all(isPolygon, enabled),
          paint: {
            'line-color': byLevel(OFF_LEASH_COLOURS, safety.neutral),
            'line-width': 2,
            'line-dasharray': [2, 1.5],
          },
        },
        {
          ...base,
          id: id('paths'),
          type: 'line',
          filter: all(isLine, enabled),
          paint: { 'line-color': byLevel(OFF_LEASH_COLOURS, safety.neutral), 'line-width': 3 },
        },
        // One badge per area or point, so the rule is readable without
        // relying on colour alone (colour-blind users, §10).
        symbolLayer(id('icons'), base, 'offLeash', all(['!=', ['geometry-type'], 'LineString'], enabled), {
          prohibited: 0,
          leashed: 1,
          off_leash: 2,
          off_leash_fenced: 3,
          allowed_leash_unknown: 4,
        }),
      ];
    case 'surface': {
      // Paved solid, unpaved dashed: the material stays readable whatever
      // the temperature. Colour and width are replaced live by
      // `surfacePaint(bands)` once conditions load (Phase 5).
      const initial = surfacePaint(undefined);
      return [
        {
          ...base,
          id: id('paved'),
          type: 'line',
          filter: ['in', ['get', 'surface'], ['literal', PAVED_VALUES]],
          paint: { ...initial, 'line-opacity': 0.9 },
          layout: { 'line-cap': 'round', 'line-join': 'round' },
        },
        {
          ...base,
          id: id('unpaved'),
          type: 'line',
          filter: ['!', ['in', ['get', 'surface'], ['literal', PAVED_VALUES]]],
          paint: { ...initial, 'line-opacity': 0.9, 'line-dasharray': [2, 1.2] },
          layout: { 'line-join': 'round' },
        },
      ];
    }
    case 'water':
      // Unmonitored water draws NOTHING (§6). Only official bathing spots
      // ('monitored') and warnings exist on the map, and both arrive in Phase 6.
      return [
        {
          ...base,
          id: id('fill'),
          type: 'fill',
          filter: all(isPolygon, ['in', ['get', 'level'], ['literal', ['monitored', 'warning']]]),
          paint: {
            'fill-color': byLevel({ warning: safety.warning, monitored: safety.monitored }, safety.monitored),
            'fill-opacity': 0.6,
          },
        },
      ];
    case 'benches':
      return [symbolLayer(id('icons'), base, 'benches', ['all'] as unknown as FilterSpecification)];
    case 'waste':
      return [
        symbolLayer(id('icons'), base, 'waste', enabled, { bag_dispenser: 0, dog_bin: 1, general: 2 }),
      ];
    case 'drinkingWater':
      return [symbolLayer(id('icons'), base, 'drinkingWater', ['all'] as unknown as FilterSpecification)];
  }
}

/** Draw order: areas under lines under points. */
const DRAW_ORDER: readonly LayerKey[] = [
  'shade',
  'water',
  'offLeash',
  'surface',
  'benches',
  'waste',
  'drinkingWater',
];

export function pawpathLayerSpecs(
  disabledLevels: readonly FeatureLevel[],
): { specs: LayerSpecification[]; idsByLayer: Record<LayerKey, string[]> } {
  const idsByLayer = Object.fromEntries(LAYER_KEYS.map((key) => [key, [] as string[]])) as Record<
    LayerKey,
    string[]
  >;
  const specs: LayerSpecification[] = [];
  for (const key of DRAW_ORDER) {
    for (const spec of specsFor(key, disabledLevels)) {
      specs.push(spec);
      idsByLayer[key].push(spec.id);
    }
  }
  return { specs, idsByLayer };
}
