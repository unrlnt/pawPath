import { describe, expect, it } from 'vitest';

import { osmUrlFor, popupModel } from './popupModel';

describe('osmUrlFor', () => {
  it('decodes Planetiler ids (osmId × 10 + type)', () => {
    expect(osmUrlFor(70250062)).toBe('https://www.openstreetmap.org/way/7025006');
    expect(osmUrlFor(54571662931)).toBe('https://www.openstreetmap.org/node/5457166293');
    expect(osmUrlFor(1233)).toBe('https://www.openstreetmap.org/relation/123');
  });
  it('gives nothing for unusable ids', () => {
    expect(osmUrlFor(undefined)).toBeUndefined();
    expect(osmUrlFor(1230)).toBeUndefined();
    expect(osmUrlFor('12')).toBeUndefined();
  });
});

describe('popupModel', () => {
  it('names the exact level and the useful tags', () => {
    const model = popupModel('waste', { level: 'bag_dispenser', vending: 'excrement_bags' }, 54571662931);
    expect(model.title).toBe('Poop bag dispenser');
    expect(model.details).toContain('Dispenses poop bags');
    expect(model.icon?.glyph).toBe('bag');
  });

  it('explains dog=yes plainly — never as off-leash', () => {
    const model = popupModel('offLeash', { level: 'allowed_leash_unknown', dog: 'yes' }, 12);
    expect(model.title).toMatch(/leash rule unknown/);
    expect(model.note).toMatch(/usually means on a leash/);
    expect(model.icon?.glyph).toBe('question');
  });

  it('describes benches and surfaces in words', () => {
    expect(popupModel('benches', { backrest: 'yes', material: 'wood' }, 12).details).toEqual([
      'With a backrest',
      'Made of wood',
    ]);
    expect(popupModel('surface', { level: 'high', surface: 'paving_stones', highway: 'footway' }, 22).details).toEqual([
      'Surface: paving stones',
      'Path type: footway',
    ]);
  });

  it('ignores an unknown level instead of trusting it', () => {
    expect(popupModel('offLeash', { level: 'off_leash_please' }, 12).title).toBe('Dog rules');
    expect(popupModel('benches', {}, 12).title).toBe('Bench');
  });
});
