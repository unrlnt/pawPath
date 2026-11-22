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
import { ICONS, iconId } from './icons';

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
        {
          ...base,
          id: id('fill'),
          type: 'fill',
          filter: isPolygon,
          paint: {
            'fill-color': palette.sageDeep,
            'fill-opacity': ['match', ['get', 'level'], 'dense', 0.36, 'medium', 0.22, 0.16],
          },
        },
        {
          ...base,
          id: id('rows'),
          type: 'line',
          filter: isLine,
          paint: { 'line-color': palette.sageDeep, 'line-opacity': 0.55, 'line-width': 4 },
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
    case 'surface':
      return [
        {
          ...base,
          id: id('lines'),
          type: 'line',
          paint: {
            'line-color': byLevel(pawRisk, palette.inkSoft),
            'line-opacity': 0.85,
            'line-width': ['interpolate', ['linear'], ['zoom'], 15, 2, 18, 6],
          },
          layout: { 'line-cap': 'round', 'line-join': 'round' },
        },
      ];
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
