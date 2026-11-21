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
import {
  DEFAULT_DISABLED_FEATURE_LEVELS,
  LAYER_KEYS,
  type FeatureLevel,
  type LayerKey,
} from '../data/layers';
import { palette, pawRisk, safety } from '../styles/tokens';

export const PAWPATH_SOURCE_ID = 'pawpath';

type Colour = DataDrivenPropertyValueSpecification<string>;

/** `match` on the `level` property, with a fallback colour. */
function byLevel(colours: Partial<Record<FeatureLevel, string>>, fallback: string): Colour {
  const pairs = Object.entries(colours).flatMap(([level, colour]) => [level, colour]);
  return ['match', ['get', 'level'], ...pairs, fallback] as unknown as ExpressionSpecification;
}

const isPolygon: FilterSpecification = ['==', ['geometry-type'], 'Polygon'];
const isLine: FilterSpecification = ['==', ['geometry-type'], 'LineString'];
const isPoint: FilterSpecification = ['==', ['geometry-type'], 'Point'];

/** Levels hidden until the user opts in — `dog=yes` above all (§6). */
const levelEnabled: FilterSpecification = [
  '!',
  ['in', ['coalesce', ['get', 'level'], ''], ['literal', [...DEFAULT_DISABLED_FEATURE_LEVELS]]],
];

const all = (...filters: FilterSpecification[]): FilterSpecification =>
  ['all', ...filters] as unknown as FilterSpecification;

const OFF_LEASH_COLOURS: Partial<Record<FeatureLevel, string>> = {
  off_leash: safety.offLeash,
  off_leash_fenced: safety.offLeash,
  leashed: safety.leashed,
  prohibited: safety.prohibited,
  allowed_leash_unknown: safety.neutral,
};

const WASTE_COLOURS: Partial<Record<FeatureLevel, string>> = {
  general: palette.inkSoft,
  dog_bin: palette.terracottaDeep,
  bag_dispenser: palette.sageDeep,
};

const pointRadius = (base: number): DataDrivenPropertyValueSpecification<number> => [
  'interpolate',
  ['linear'],
  ['zoom'],
  13,
  base,
  18,
  base * 2.2,
];

/** Layers per toggle, bottom to top within each. */
function specsFor(key: LayerKey): LayerSpecification[] {
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
          filter: all(isPolygon, levelEnabled),
          paint: { 'fill-color': byLevel(OFF_LEASH_COLOURS, safety.neutral), 'fill-opacity': 0.28 },
        },
        {
          ...base,
          id: id('outline'),
          type: 'line',
          filter: all(isPolygon, levelEnabled),
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
          filter: all(isLine, levelEnabled),
          paint: { 'line-color': byLevel(OFF_LEASH_COLOURS, safety.neutral), 'line-width': 3 },
        },
        {
          ...base,
          id: id('points'),
          type: 'circle',
          filter: all(isPoint, levelEnabled),
          paint: {
            'circle-color': byLevel(OFF_LEASH_COLOURS, safety.neutral),
            'circle-radius': pointRadius(5),
            'circle-stroke-color': palette.cream,
            'circle-stroke-width': 2,
          },
        },
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
      return [circleLayer(id('points'), base, palette.goldenDeep, 4)];
    case 'waste':
      return [circleLayer(id('points'), base, byLevel(WASTE_COLOURS, palette.inkSoft), 4)];
    case 'drinkingWater':
      return [circleLayer(id('points'), base, '#3E8FA6', 5)];
  }
}

function circleLayer(
  id: string,
  base: { source: string; 'source-layer': string; minzoom: number },
  colour: Colour,
  radius: number,
): LayerSpecification {
  return {
    ...base,
    id,
    type: 'circle',
    paint: {
      'circle-color': colour,
      'circle-radius': pointRadius(radius),
      'circle-stroke-color': palette.cream,
      'circle-stroke-width': 2,
    },
  };
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

export function pawpathLayerSpecs(): { specs: LayerSpecification[]; idsByLayer: Record<LayerKey, string[]> } {
  const idsByLayer = Object.fromEntries(LAYER_KEYS.map((key) => [key, [] as string[]])) as Record<
    LayerKey,
    string[]
  >;
  const specs: LayerSpecification[] = [];
  for (const key of DRAW_ORDER) {
    for (const spec of specsFor(key)) {
      specs.push(spec);
      idsByLayer[key].push(spec.id);
    }
  }
  return { specs, idsByLayer };
}
