/**
 * Shared test cases for the layer table.
 *
 * Checked TWICE, against two independent implementations of the same rules:
 *  - `layers.test.ts` runs them through the TypeScript evaluator;
 *  - `generateSchema.ts` writes them into the Planetiler schema's `examples`,
 *    and `planetiler verify` runs them through the real tile build.
 *
 * If the two ever disagree, one of the tests fails. Add a case here whenever a
 * rule is added or a bug is found — especially anything about `dog=*`.
 */

import type { FeatureLevel, LayerKey } from './layers';

export type InputGeometry = 'point' | 'line' | 'polygon';

export interface ExpectedFeature {
  readonly layer: LayerKey;
  readonly geometry: 'point' | 'line' | 'polygon';
  readonly level?: FeatureLevel;
}

export interface LayerExample {
  readonly name: string;
  /** Build source; default OSM. Non-OSM examples run in `planetiler verify` only. */
  readonly source?: 'osm' | 'eea_bathing';
  readonly geometry: InputGeometry;
  readonly tags: Readonly<Record<string, string>>;
  /** Every feature the element must produce. `[]` means it must be dropped. */
  readonly expect: readonly ExpectedFeature[];
}

export const LAYER_EXAMPLES: readonly LayerExample[] = [
  /* -- Off-leash: the rules that matter most ----------------------------- */
  {
    name: 'dog=unleashed area is off-leash',
    geometry: 'polygon',
    tags: { leisure: 'park', dog: 'unleashed' },
    expect: [{ layer: 'offLeash', geometry: 'polygon', level: 'off_leash' }],
  },
  {
    name: 'dog=designated area is off-leash',
    geometry: 'polygon',
    tags: { dog: 'designated' },
    expect: [{ layer: 'offLeash', geometry: 'polygon', level: 'off_leash' }],
  },
  {
    name: 'dog park is fenced off-leash',
    geometry: 'polygon',
    tags: { leisure: 'dog_park' },
    expect: [{ layer: 'offLeash', geometry: 'polygon', level: 'off_leash_fenced' }],
  },
  {
    name: 'dog park mapped as a node',
    geometry: 'point',
    tags: { leisure: 'dog_park' },
    expect: [{ layer: 'offLeash', geometry: 'point', level: 'off_leash_fenced' }],
  },
  {
    name: 'dog=leashed',
    geometry: 'polygon',
    tags: { dog: 'leashed' },
    expect: [{ layer: 'offLeash', geometry: 'polygon', level: 'leashed' }],
  },
  {
    name: 'dog=no on a footpath is a line',
    geometry: 'line',
    tags: { highway: 'footway', dog: 'no' },
    expect: [{ layer: 'offLeash', geometry: 'line', level: 'prohibited' }],
  },
  {
    name: 'dog=yes is NEVER off-leash',
    geometry: 'polygon',
    tags: { leisure: 'park', dog: 'yes' },
    expect: [{ layer: 'offLeash', geometry: 'polygon', level: 'allowed_leash_unknown' }],
  },
  {
    name: 'explicit dog=leashed beats a dog park',
    geometry: 'polygon',
    tags: { leisure: 'dog_park', dog: 'leashed' },
    expect: [{ layer: 'offLeash', geometry: 'polygon', level: 'leashed' }],
  },
  {
    name: 'dog=no beats a dog park',
    geometry: 'polygon',
    tags: { leisure: 'dog_park', dog: 'no' },
    expect: [{ layer: 'offLeash', geometry: 'polygon', level: 'prohibited' }],
  },
  {
    name: 'a dog park beats dog=yes',
    geometry: 'polygon',
    tags: { leisure: 'dog_park', dog: 'yes' },
    expect: [{ layer: 'offLeash', geometry: 'polygon', level: 'off_leash_fenced' }],
  },
  {
    name: 'the invalid dog=off_leash value is ignored',
    geometry: 'polygon',
    tags: { dog: 'off_leash' },
    expect: [],
  },

  /* -- Shade --------------------------------------------------------------- */
  {
    name: 'forest is dense shade',
    geometry: 'polygon',
    tags: { landuse: 'forest' },
    expect: [{ layer: 'shade', geometry: 'polygon', level: 'dense' }],
  },
  {
    name: 'wood is dense shade',
    geometry: 'polygon',
    tags: { natural: 'wood' },
    expect: [{ layer: 'shade', geometry: 'polygon', level: 'dense' }],
  },
  {
    name: 'scrub is medium shade',
    geometry: 'polygon',
    tags: { natural: 'scrub' },
    expect: [{ layer: 'shade', geometry: 'polygon', level: 'medium' }],
  },
  {
    name: 'tree row is a light-shade line',
    geometry: 'line',
    tags: { natural: 'tree_row' },
    expect: [{ layer: 'shade', geometry: 'line', level: 'light' }],
  },
  {
    name: 'a forest that allows dogs off-leash is in both layers',
    geometry: 'polygon',
    tags: { landuse: 'forest', dog: 'unleashed' },
    expect: [
      { layer: 'shade', geometry: 'polygon', level: 'dense' },
      { layer: 'offLeash', geometry: 'polygon', level: 'off_leash' },
    ],
  },

  /* -- Surface ------------------------------------------------------------- */
  {
    name: 'asphalt footway is high paw risk',
    geometry: 'line',
    tags: { highway: 'footway', surface: 'asphalt' },
    expect: [{ layer: 'surface', geometry: 'line', level: 'high' }],
  },
  {
    name: 'compacted path is mid paw risk',
    geometry: 'line',
    tags: { highway: 'path', surface: 'compacted' },
    expect: [{ layer: 'surface', geometry: 'line', level: 'mid' }],
  },
  {
    name: 'grass track is low paw risk',
    geometry: 'line',
    tags: { highway: 'track', surface: 'grass' },
    expect: [{ layer: 'surface', geometry: 'line', level: 'low' }],
  },
  {
    name: 'a motorway surface is irrelevant',
    geometry: 'line',
    tags: { highway: 'motorway', surface: 'asphalt' },
    expect: [],
  },
  {
    name: 'an unscored surface value draws nothing',
    geometry: 'line',
    tags: { highway: 'path', surface: 'moon_dust' },
    expect: [],
  },
  {
    name: 'highway types are matched exactly (footpath is not path)',
    geometry: 'line',
    tags: { highway: 'footpath', surface: 'asphalt' },
    expect: [],
  },

  /* -- Water --------------------------------------------------------------- */
  {
    name: 'an ordinary pond is never drawn (unmonitored water, §6)',
    geometry: 'polygon',
    tags: { natural: 'water' },
    expect: [],
  },
  {
    name: 'an OSM swimming area is not an official bathing site',
    geometry: 'point',
    tags: { leisure: 'swimming_area' },
    expect: [],
  },
  {
    name: 'an official EU bathing site is "monitored", never "safe"',
    source: 'eea_bathing',
    geometry: 'point',
    tags: { bwid: 'NLBW07_VRL01', name: 'DE VROLIJK', category: 'Lake', quality: 'Excellent', quality_year: '2022' },
    expect: [{ layer: 'water', geometry: 'point', level: 'monitored' }],
  },
  {
    name: 'the placeholder written when the EEA is unreachable is never drawn',
    source: 'eea_bathing',
    geometry: 'point',
    tags: { placeholder: 'true' },
    expect: [],
  },

  /* -- Amenities ----------------------------------------------------------- */
  {
    name: 'bench node',
    geometry: 'point',
    tags: { amenity: 'bench', backrest: 'yes' },
    expect: [{ layer: 'benches', geometry: 'point' }],
  },
  {
    name: 'bench mapped as a way becomes a point',
    geometry: 'line',
    tags: { amenity: 'bench' },
    expect: [{ layer: 'benches', geometry: 'point' }],
  },
  {
    name: 'general bin',
    geometry: 'point',
    tags: { amenity: 'waste_basket' },
    expect: [{ layer: 'waste', geometry: 'point', level: 'general' }],
  },
  {
    name: 'dog bin',
    geometry: 'point',
    tags: { amenity: 'waste_basket', waste: 'dog_excrement' },
    expect: [{ layer: 'waste', geometry: 'point', level: 'dog_bin' }],
  },
  {
    name: 'bag dispenser with no amenity tag',
    geometry: 'point',
    tags: { vending: 'excrement_bags' },
    expect: [{ layer: 'waste', geometry: 'point', level: 'bag_dispenser' }],
  },
  {
    name: 'bag dispenser on a vending machine',
    geometry: 'point',
    tags: { amenity: 'vending_machine', vending: 'excrement_bags' },
    expect: [{ layer: 'waste', geometry: 'point', level: 'bag_dispenser' }],
  },
  {
    name: 'long-tail dog waste amenity',
    geometry: 'point',
    tags: { amenity: 'dog_waste_bin' },
    expect: [{ layer: 'waste', geometry: 'point', level: 'dog_bin' }],
  },
  {
    name: 'drinking water',
    geometry: 'point',
    tags: { amenity: 'drinking_water' },
    expect: [{ layer: 'drinkingWater', geometry: 'point' }],
  },
  {
    name: 'an unrelated shop is dropped',
    geometry: 'point',
    tags: { shop: 'bakery' },
    expect: [],
  },
];
