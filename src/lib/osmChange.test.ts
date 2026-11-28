import { describe, expect, it } from 'vitest';

import {
  changesetTags,
  changesetXml,
  createNodeChange,
  deletableAs,
  deleteNodeChange,
  newNodeId,
  parseOsmUrl,
} from './osmChange';

describe('OSM change documents', () => {
  it('creates one tagged node, escaping text', () => {
    const xml = createNodeChange(42, 52.37123456, 5.2189, { amenity: 'waste_basket', note: 'by the "gate" & <bridge>' });
    expect(xml).toContain('<node id="-1" changeset="42" lat="52.3712346" lon="5.2189000">');
    expect(xml).toContain('<tag k="amenity" v="waste_basket"/>');
    expect(xml).toContain('v="by the &quot;gate&quot; &amp; &lt;bridge&gt;"');
  });

  it('builds the changeset with who and what', () => {
    const xml = changesetXml(changesetTags('Added a bench via PawPath', 'https://pawpath.example'));
    expect(xml).toContain('<tag k="created_by" v="PawPath"/>');
    expect(xml).toContain('<tag k="comment" v="Added a bench via PawPath"/>');
  });

  it('deletes a node at its version', () => {
    expect(deleteNodeChange(7, 123, 3, 52, 5)).toContain('<node id="123" version="3" changeset="7"');
  });

  it('reads the new node id from the diff result', () => {
    expect(newNodeId('<diffResult><node old_id="-1" new_id="9876" new_version="1"/></diffResult>')).toBe(9876);
    expect(newNodeId('<diffResult/>')).toBeUndefined();
  });

  it('parses OSM object links', () => {
    expect(parseOsmUrl('https://www.openstreetmap.org/node/123')).toEqual({ type: 'node', id: 123 });
    expect(parseOsmUrl('https://www.openstreetmap.org/way/5')).toEqual({ type: 'way', id: 5 });
    expect(parseOsmUrl(undefined)).toBeUndefined();
  });
});

describe('what "not there anymore" may delete', () => {
  it('a plain bench with descriptive tags', () => {
    expect(deletableAs({ amenity: 'bench' }, { amenity: 'bench', backrest: 'yes', material: 'wood' }, false)).toBe(true);
  });
  it('not a node with other features on it', () => {
    expect(deletableAs({ amenity: 'bench' }, { amenity: 'bench', shop: 'kiosk' }, false)).toBe(false);
    expect(deletableAs({ amenity: 'bench' }, { amenity: 'bench', name: 'Memorial bench' }, false)).toBe(false);
  });
  it('not a node of another kind', () => {
    expect(deletableAs({ amenity: 'bench' }, { amenity: 'waste_basket' }, false)).toBe(false);
  });
  it('a bag dispenser mapped without amenity=vending_machine', () => {
    expect(deletableAs({ amenity: 'vending_machine', vending: 'excrement_bags' }, { vending: 'excrement_bags' }, false)).toBe(true);
  });
  it('a named toilet', () => {
    expect(deletableAs({ amenity: 'toilets' }, { amenity: 'toilets', name: 'WC Stadhuis', fee: 'no' }, true)).toBe(true);
  });
});
