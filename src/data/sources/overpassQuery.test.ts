import { describe, expect, it } from 'vitest';

import { APP_CONTACT_URL, APP_CONTACT_URL_UNSET, WALKABLE_HIGHWAY_TYPES } from '../../config';
import { LAYERS, WALKABLE_HIGHWAY_PATTERN } from './layers';
import { buildOverpassQL, escapeOverpassString, renderBBox } from './overpassQuery';

const BBOX = { south: 52.33, west: 5.24, north: 52.37, east: 5.29 };

describe('buildOverpassQL', () => {
  it('emits a JSON union with a bbox filter per element kind', () => {
    const ql = buildOverpassQL({
      bbox: BBOX,
      selectors: LAYERS.benches.selectors,
      output: 'center',
    });

    expect(ql).toContain('[out:json][timeout:');
    expect(ql).toContain('node["amenity"="bench"](52.330000,5.240000,52.370000,5.290000);');
    expect(ql).toContain('way["amenity"="bench"](52.330000,5.240000,52.370000,5.290000);');
    expect(ql.trimEnd().endsWith(';')).toBe(true);
    expect(ql).toMatch(/out center \d+;/);
  });

  it('ANDs multiple conditions in one selector', () => {
    const ql = buildOverpassQL({
      bbox: BBOX,
      selectors: LAYERS.waste.selectors,
      output: 'center',
    });
    expect(ql).toContain('node["amenity"="waste_basket"]["waste"="dog_excrement"]');
  });

  it('queries vending=excrement_bags without requiring an amenity tag', () => {
    const ql = buildOverpassQL({
      bbox: BBOX,
      selectors: LAYERS.waste.selectors,
      output: 'center',
    });
    // Run 1's bug: pairing the two found almost nothing.
    expect(ql).toContain('node["vending"="excrement_bags"]');
    expect(ql).not.toContain('["amenity"="vending_machine"]');
    // ...on any element type, relations included.
    expect(ql).toContain('relation["vending"="excrement_bags"]');
  });

  it('renders exists conditions without a value', () => {
    const ql = buildOverpassQL({
      bbox: BBOX,
      selectors: LAYERS.surface.selectors,
      output: 'geom',
    });
    expect(ql).toContain('["surface"]');
    expect(ql).toMatch(/out geom \d+;/);
  });

  it('restricts surface to walkable highway types, anchored', () => {
    const ql = buildOverpassQL({
      bbox: BBOX,
      selectors: LAYERS.surface.selectors,
      output: 'geom',
    });
    expect(ql).toContain(`way["highway"~"${WALKABLE_HIGHWAY_PATTERN}"]["surface"]`);
    // Anchors keep `path` from also matching `footpath`.
    expect(WALKABLE_HIGHWAY_PATTERN.startsWith('^(')).toBe(true);
    expect(WALKABLE_HIGHWAY_PATTERN.endsWith(')$')).toBe(true);
    // Not a bare highway=* query — that measured ~2,800 ways per 2 km tile.
    expect(ql).not.toContain('way["highway"]["surface"]');
    for (const type of ['motorway', 'trunk', 'primary', 'secondary']) {
      expect(new RegExp(WALKABLE_HIGHWAY_PATTERN).test(type)).toBe(false);
    }
    for (const type of WALKABLE_HIGHWAY_TYPES) {
      expect(new RegExp(WALKABLE_HIGHWAY_PATTERN).test(type)).toBe(true);
    }
  });

  it('queries only real dog=* values', () => {
    const ql = buildOverpassQL({
      bbox: BBOX,
      selectors: LAYERS.offLeash.selectors,
      output: 'geom',
    });
    // dog=off_leash is not a valid OSM value; it returned 0 in all four Run 1
    // cities because it does not exist, not because the data is missing.
    expect(ql).not.toContain('off_leash');
    for (const value of ['unleashed', 'designated', 'leashed', 'no', 'yes']) {
      expect(ql).toContain(`["dog"="${value}"]`);
    }
    expect(ql).toContain('["leisure"="dog_park"]');
  });

  it('carries an identifying comment for instance operators', () => {
    const ql = buildOverpassQL({
      bbox: BBOX,
      selectors: LAYERS.benches.selectors,
      output: 'center',
      context: 'tile=2km:1:2',
    });
    expect(ql.startsWith('// PawPath')).toBe(true);
    expect(ql).toContain('tile=2km:1:2');
    expect(ql).toContain(
      APP_CONTACT_URL === APP_CONTACT_URL_UNSET ? 'contact URL not set' : APP_CONTACT_URL,
    );
  });

  it('never advertises the unset sentinel as if it were a URL', () => {
    const ql = buildOverpassQL({
      bbox: BBOX,
      selectors: LAYERS.benches.selectors,
      output: 'center',
    });
    expect(ql).not.toContain(`(${APP_CONTACT_URL_UNSET})`);
  });

  it('refuses to build an empty union', () => {
    expect(() => buildOverpassQL({ bbox: BBOX, selectors: [], output: 'center' })).toThrow();
  });

  it('escapes quotes and backslashes in tag values', () => {
    expect(escapeOverpassString('a"b\\c')).toBe('a\\"b\\\\c');
  });

  it('renders bboxes in Overpass order (S,W,N,E)', () => {
    expect(renderBBox(BBOX)).toBe('(52.330000,5.240000,52.370000,5.290000)');
  });
});
