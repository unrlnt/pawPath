import { describe, expect, it } from 'vitest';

import { DEFAULT_DISABLED_LEVELS, TILE_CACHE_SCHEMA_VERSION } from '../../config';
import { DEFAULT_DISABLED_FEATURE_LEVELS, LAYERS } from './layers';
import type { OverpassElement } from './overpassClient';
import { matchesSelector, normaliseElements, tileCacheKey } from './overpassTileSource';
import { SOURCE_ATTRIBUTION } from './tileSource';

/** Level of the single feature produced for `tags` on `layer`. */
function levelFor(layer: (typeof LAYERS)[keyof typeof LAYERS], tags: Record<string, string>) {
  const [feature] = normaliseElements(
    [{ type: 'node', id: 99, lat: 52.35, lon: 5.26, tags }],
    [layer],
    { includeGeometry: false },
  );
  return feature?.level;
}

const bench: OverpassElement = {
  type: 'node',
  id: 1,
  lat: 52.35,
  lon: 5.26,
  tags: { amenity: 'bench', backrest: 'yes' },
};

const dogParkWay: OverpassElement = {
  type: 'way',
  id: 2,
  center: { lat: 52.36, lon: 5.27 },
  geometry: [
    { lat: 52.36, lon: 5.27 },
    { lat: 52.361, lon: 5.27 },
    { lat: 52.361, lon: 5.271 },
    { lat: 52.36, lon: 5.27 },
  ],
  tags: { leisure: 'dog_park' },
};

const forestRelation: OverpassElement = {
  type: 'relation',
  id: 3,
  bounds: { minlat: 52.3, minlon: 5.2, maxlat: 52.4, maxlon: 5.3 },
  tags: { landuse: 'forest' },
};

const untaggedNode: OverpassElement = { type: 'node', id: 4, lat: 52.3, lon: 5.2 };

describe('normaliseElements', () => {
  it('flattens nodes into features', () => {
    const [feature] = normaliseElements([bench], [LAYERS.benches], { includeGeometry: false });
    expect(feature).toEqual({
      id: 'osm:node/1',
      source: 'osm',
      layer: 'benches',
      lat: 52.35,
      lng: 5.26,
      tags: { amenity: 'bench', backrest: 'yes' },
    });
  });

  it('stamps and namespaces provenance so a second source cannot collide', () => {
    const [feature] = normaliseElements([bench], [LAYERS.benches], { includeGeometry: false });
    expect(feature?.source).toBe('osm');
    expect(feature?.id.startsWith('osm:')).toBe(true);
    expect(SOURCE_ATTRIBUTION[feature?.source ?? 'osm'].licence).toBe('ODbL 1.0');
  });

  it('derives the level from tags', () => {
    const [dogPark] = normaliseElements([dogParkWay], [LAYERS.offLeash], {
      includeGeometry: false,
    });
    expect(dogPark?.level).toBe('off_leash_fenced');

    const [forest] = normaliseElements([forestRelation], [LAYERS.shade], {
      includeGeometry: false,
    });
    expect(forest?.level).toBe('dense');
  });

  it('closes rings into polygons only when geometry was requested', () => {
    const [withGeom] = normaliseElements([dogParkWay], [LAYERS.offLeash], {
      includeGeometry: true,
    });
    expect(withGeom?.geometry?.type).toBe('Polygon');
    expect(withGeom?.geometry?.coordinates[0]).toEqual([5.27, 52.36]);

    const [withoutGeom] = normaliseElements([dogParkWay], [LAYERS.offLeash], {
      includeGeometry: false,
    });
    expect(withoutGeom?.geometry).toBeUndefined();
  });

  it('falls back to the centre of bounds for relations', () => {
    const [feature] = normaliseElements([forestRelation], [LAYERS.shade], {
      includeGeometry: true,
    });
    expect(feature?.lat).toBeCloseTo(52.35, 6);
    expect(feature?.lng).toBeCloseTo(5.25, 6);
    // Relation ring assembly is Phase 5 work.
    expect(feature?.geometry).toBeUndefined();
  });

  it('drops elements it cannot place or attribute', () => {
    expect(normaliseElements([untaggedNode], [LAYERS.benches], { includeGeometry: false })).toEqual(
      [],
    );
    expect(normaliseElements([bench], [LAYERS.shade], { includeGeometry: false })).toEqual([]);
  });

  it('emits one feature per matching layer', () => {
    const scrubbyDogPark: OverpassElement = {
      ...dogParkWay,
      tags: { leisure: 'dog_park', natural: 'scrub' },
    };
    const features = normaliseElements(
      [scrubbyDogPark],
      [LAYERS.offLeash, LAYERS.shade],
      { includeGeometry: false },
    );
    expect(features.map((feature) => feature.layer).sort()).toEqual(['offLeash', 'shade']);
  });
});

describe('off-leash levels', () => {
  it('maps only real OSM values to off-leash', () => {
    expect(levelFor(LAYERS.offLeash, { dog: 'unleashed' })).toBe('off_leash');
    expect(levelFor(LAYERS.offLeash, { dog: 'designated' })).toBe('off_leash');
    expect(levelFor(LAYERS.offLeash, { leisure: 'dog_park' })).toBe('off_leash_fenced');
    expect(levelFor(LAYERS.offLeash, { dog: 'leashed' })).toBe('leashed');
    expect(levelFor(LAYERS.offLeash, { dog: 'no' })).toBe('prohibited');
  });

  /**
   * The single most consequential rule in the layer: reading dog=yes as
   * off-leash would tell someone their dog may run free where local law says
   * it may not.
   */
  it('NEVER treats dog=yes as off-leash', () => {
    expect(levelFor(LAYERS.offLeash, { dog: 'yes' })).toBe('allowed_leash_unknown');
    expect(levelFor(LAYERS.offLeash, { dog: 'yes', leisure: 'park' })).toBe(
      'allowed_leash_unknown',
    );
  });

  it('keeps dog=yes out of the filter by default', () => {
    expect(DEFAULT_DISABLED_FEATURE_LEVELS).toContain('allowed_leash_unknown');
    // A typo in config would silently drop the entry instead of disabling it.
    expect(DEFAULT_DISABLED_FEATURE_LEVELS).toHaveLength(DEFAULT_DISABLED_LEVELS.length);
  });

  it('ignores the invalid dog=off_leash value', () => {
    expect(levelFor(LAYERS.offLeash, { dog: 'off_leash' })).toBeUndefined();
  });

  it('lets an explicit dog=* tag win over a dog_park, except dog=yes', () => {
    expect(levelFor(LAYERS.offLeash, { leisure: 'dog_park', dog: 'leashed' })).toBe('leashed');
    expect(levelFor(LAYERS.offLeash, { leisure: 'dog_park', dog: 'no' })).toBe('prohibited');
    expect(levelFor(LAYERS.offLeash, { leisure: 'dog_park', dog: 'yes' })).toBe('off_leash_fenced');
  });
});

describe('waste levels', () => {
  it('recognises a bag dispenser with no amenity tag', () => {
    expect(levelFor(LAYERS.waste, { vending: 'excrement_bags' })).toBe('bag_dispenser');
    expect(
      levelFor(LAYERS.waste, { amenity: 'vending_machine', vending: 'excrement_bags' }),
    ).toBe('bag_dispenser');
  });

  it('separates dog bins from general ones', () => {
    expect(levelFor(LAYERS.waste, { amenity: 'waste_basket' })).toBe('general');
    expect(levelFor(LAYERS.waste, { amenity: 'waste_basket', waste: 'dog_excrement' })).toBe(
      'dog_bin',
    );
  });

  it('catches the long tail of dog-waste amenity values', () => {
    expect(levelFor(LAYERS.waste, { amenity: 'dog_waste_bin' })).toBe('dog_bin');
    expect(levelFor(LAYERS.waste, { amenity: 'dog_excrement' })).toBe('dog_bin');
    expect(levelFor(LAYERS.waste, { amenity: 'bench' })).toBeUndefined();
  });
});

describe('surface levels', () => {
  it('scores walkable surfaces by paw-heat risk', () => {
    expect(levelFor(LAYERS.surface, { highway: 'footway', surface: 'asphalt' })).toBe('high');
    expect(levelFor(LAYERS.surface, { highway: 'path', surface: 'compacted' })).toBe('mid');
    expect(levelFor(LAYERS.surface, { highway: 'track', surface: 'grass' })).toBe('low');
  });
});

describe('matchesSelector', () => {
  it('matches the same conditions Overpass filtered on', () => {
    const dispenser = LAYERS.waste.selectors.find((s) => s.id === 'waste.bagDispenser');
    expect(dispenser).toBeDefined();
    if (dispenser === undefined) return;
    expect(
      matchesSelector({ amenity: 'vending_machine', vending: 'excrement_bags' }, dispenser),
    ).toBe(true);
    expect(matchesSelector({ amenity: 'vending_machine', vending: 'drinks' }, dispenser)).toBe(
      false,
    );
  });
});

describe('tileCacheKey', () => {
  it('is one key per (tile, layer), independent of what else was requested', () => {
    expect(tileCacheKey('2km:1:2', 'shade')).toBe(tileCacheKey('2km:1:2', 'shade'));
    expect(tileCacheKey('2km:1:2', 'shade')).not.toBe(tileCacheKey('2km:1:2', 'water'));
    expect(tileCacheKey('2km:1:2', 'shade')).not.toBe(tileCacheKey('2km:1:3', 'shade'));
  });

  it('carries the schema version so normalisation changes invalidate cleanly', () => {
    expect(tileCacheKey('2km:1:2', 'shade')).toContain(`v${TILE_CACHE_SCHEMA_VERSION}`);
  });
});
