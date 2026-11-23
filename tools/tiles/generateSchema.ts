/**
 * Generates the Planetiler custom-map schema from `src/data/layers.ts`.
 *
 *   npx tsx tools/tiles/generateSchema.ts          → writes tools/tiles/pawpath.schema.yml
 *   npx tsx tools/tiles/generateSchema.ts --check  → exits 1 if the file is stale
 *
 * The schema is generated, never hand-edited: the layer table is the single
 * definition (CLAUDE.md §3), and `src/data/layerExamples.ts` is embedded as the
 * schema's `examples`, so `planetiler verify` checks the real build against the
 * same cases vitest checks the app against.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stringify } from 'yaml';

import { APP_NAME, LAYER_MIN_ZOOM, TILE_MAX_ZOOM } from '../../src/config';
import { LAYER_EXAMPLES, type LayerExample } from '../../src/data/layerExamples';
import {
  ALL_WALK_HIGHWAYS,
  WALK_GRAPH_ZOOM,
  WALK_LAYER,
  WALK_TAGS,
  isWalkable,
} from '../../src/data/walkGraph';
import {
  ALL_LAYERS,
  EXTERNAL_SOURCES,
  type LayerDefinition,
  type OutputGeometry,
  type TagCondition,
} from '../../src/data/layers';

type Expr = Record<string, unknown>;

/** One condition as a Planetiler structured boolean expression. */
function conditionExpr(condition: TagCondition): Expr {
  switch (condition.op) {
    case 'equals':
      return { [condition.key]: condition.value };
    case 'oneOf':
      return { [condition.key]: [...condition.values] };
    case 'prefix':
      return { [condition.key]: `${condition.prefix}%` };
    case 'exists':
      return { [condition.key]: '__any__' };
  }
}

/** AND of conditions. A single condition needs no wrapper. */
function allOf(conditions: readonly TagCondition[]): Expr {
  const [only] = conditions;
  if (conditions.length === 1 && only !== undefined) return conditionExpr(only);
  return { __all__: conditions.map(conditionExpr) };
}

/** OR of condition groups. */
function anyOf(groups: readonly (readonly TagCondition[])[]): Expr {
  const [only] = groups;
  if (groups.length === 1 && only !== undefined) return allOf(only);
  return { __any__: groups.map(allOf) };
}

const GEOMETRY_ORDER: readonly OutputGeometry[] = ['polygon', 'line', 'point', 'centroid'];

function layerFeatures(layer: LayerDefinition): Expr[] {
  const minZoom = Math.min(LAYER_MIN_ZOOM[layer.key], TILE_MAX_ZOOM);
  const external = layer.externalSource === undefined ? undefined : EXTERNAL_SOURCES[layer.externalSource];

  const attributes: Expr[] = [];
  if (layer.levels !== undefined) {
    // Ordered list → Planetiler match expression: first matching `if` wins,
    // exactly like `levelFor` in layers.ts. An empty `when` is the default.
    const value: Expr[] = [];
    for (const rule of layer.levels) {
      if (rule.when.length === 0) {
        value.push({ else: rule.level });
        break;
      }
      value.push({ if: allOf(rule.when), value: rule.level });
    }
    attributes.push({ key: 'level', value });
  }
  for (const tag of layer.keepTags) attributes.push({ key: tag, tag_value: tag });

  const osmFeatures = GEOMETRY_ORDER.flatMap((geometry) => {
    const selectors = layer.selectors.filter((s) => s.geometries.includes(geometry));
    if (selectors.length === 0) return [];
    return [
      {
        source: 'osm',
        geometry,
        min_zoom: minZoom,
        include_when: anyOf(selectors.map((s) => s.conditions)),
        attributes,
      },
    ];
  });
  // An external source contributes every one of its features to the layer.
  const externalFeatures =
    external === undefined
      ? []
      : [
          {
            source: external.id,
            geometry: 'point',
            min_zoom: minZoom,
            include_when: { [external.requiredProperty]: '__any__' },
            attributes,
          },
        ];
  return [...osmFeatures, ...externalFeatures];
}

/**
 * The routing graph: every walkable line, at z14 only, never simplified and
 * never dropped for being short — junctions must survive intact (Phase 9).
 */
function walkLayer(): Expr {
  return {
    id: WALK_LAYER,
    features: [
      {
        source: 'osm',
        geometry: 'line',
        min_zoom: WALK_GRAPH_ZOOM,
        include_when: { highway: [...ALL_WALK_HIGHWAYS] },
        tolerance_at_max_zoom: 0,
        min_size_at_max_zoom: 0,
        attributes: WALK_TAGS.map((tag) => ({ key: tag, tag_value: tag })),
      },
    ],
  };
}

/** Schema-only examples for the routing graph (checked by `planetiler verify`). */
const WALK_EXAMPLES: readonly LayerExample[] = [
  {
    name: 'an untagged footway is in the routing graph only',
    geometry: 'line',
    tags: { highway: 'footway' },
    expect: [],
  },
  {
    name: 'a motorway is never walkable',
    geometry: 'line',
    tags: { highway: 'motorway' },
    expect: [],
  },
];

export function buildSchema(): Expr {
  return {
    schema_name: APP_NAME,
    schema_description:
      'Dog-walk layers from OpenStreetMap. GENERATED from src/data/layers.ts by ' +
      'tools/tiles/generateSchema.ts — do not edit by hand.',
    attribution:
      '<a href="https://www.openstreetmap.org/copyright" target="_blank">&copy; OpenStreetMap contributors</a>',
    args: {
      osm_path: { description: 'Input .osm.pbf file', default: 'data/input.osm.pbf' },
      ...Object.fromEntries(
        Object.values(EXTERNAL_SOURCES).map((s) => [s.arg, { description: `GeoJSON for ${s.id}`, default: s.defaultPath }]),
      ),
      maxzoom: TILE_MAX_ZOOM,
    },
    sources: {
      osm: { type: 'osm', local_path: '${ args.osm_path }' },
      ...Object.fromEntries(
        Object.values(EXTERNAL_SOURCES).map((s) => [s.id, { type: 'geojson', local_path: `\${ args.${s.arg} }` }]),
      ),
    },
    layers: [
      ...ALL_LAYERS.map((layer) => ({ id: layer.key, features: layerFeatures(layer) })),
      walkLayer(),
    ],
    examples: [...LAYER_EXAMPLES, ...WALK_EXAMPLES].map((example) => {
      const expected = example.expect.map((feature) => ({
        layer: feature.layer,
        geometry: feature.geometry,
        ...(feature.level === undefined ? {} : { tags: { level: feature.level } }),
      }));
      // Every walkable OSM line also lands in the routing graph; adding that
      // here keeps each example's expected output complete and exact.
      const walk =
        (example.source ?? 'osm') === 'osm' && example.geometry === 'line' && isWalkable(example.tags)
          ? [{ layer: WALK_LAYER, geometry: 'line' }]
          : [];
      return {
        name: example.name,
        input: { source: example.source ?? 'osm', geometry: example.geometry, tags: { ...example.tags } },
        output: [...expected, ...walk],
      };
    }),
  };
}

const HEADER =
  '# GENERATED by tools/tiles/generateSchema.ts from src/data/layers.ts.\n' +
  '# Do not edit by hand: run `npm run tiles:schema`.\n';

/**
 * osmium `tags-filter` expressions: a SUPERSET of what the schema selects,
 * keyed on each selector's first condition. Filtering the raw extract to these
 * first shrinks ~80 GB of planet to ~1–2 GB before Planetiler sees it.
 * Referenced nodes and relation members are kept by osmium automatically.
 */
export function osmiumFilters(): string[] {
  const filters = new Set<string>();
  for (const layer of ALL_LAYERS) {
    for (const selector of layer.selectors) {
      const [first] = selector.conditions;
      if (first === undefined) continue;
      switch (first.op) {
        case 'equals':
          filters.add(`nwr/${first.key}=${first.value}`);
          break;
        case 'oneOf':
          filters.add(`nwr/${first.key}=${first.values.join(',')}`);
          break;
        case 'prefix':
          filters.add(`nwr/${first.key}=${first.prefix}*`);
          break;
        case 'exists':
          filters.add(`nwr/${first.key}`);
          break;
      }
    }
  }
  // The routing graph needs every walkable highway, tagged or not.
  filters.add(`nwr/highway=${ALL_WALK_HIGHWAYS.join(',')}`);
  return [...filters].sort();
}

export function renderSchema(): string {
  return HEADER + stringify(buildSchema(), { lineWidth: 0 });
}

export function renderOsmiumFilters(): string {
  return (
    '# GENERATED by tools/tiles/generateSchema.ts from src/data/layers.ts.\n' +
    '# osmium tags-filter expressions (a superset of the schema). Do not edit.\n' +
    osmiumFilters().join('\n') +
    '\n'
  );
}

const here = dirname(fileURLToPath(import.meta.url));

/** Generated files, committed so the tile build needs no Node at all. */
const OUTPUTS: readonly { file: string; render: () => string }[] = [
  { file: join(here, 'pawpath.schema.yml'), render: renderSchema },
  { file: join(here, 'osmium-filters.txt'), render: renderOsmiumFilters },
];

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--check')) {
    const stale = OUTPUTS.filter(({ file, render }) => readFileSync(file, 'utf8') !== render());
    if (stale.length > 0) {
      console.error(`stale: ${stale.map((o) => o.file).join(', ')} — run \`npm run tiles:schema\`.`);
      process.exit(1);
    }
    console.log('generated tile files are up to date.');
  } else {
    for (const { file, render } of OUTPUTS) {
      writeFileSync(file, render());
      console.log(`wrote ${file}`);
    }
  }
}
