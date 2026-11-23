import { describe, expect, it } from 'vitest';

import { parseWaterWarnings } from '../data/sources/waterWarnings';
import { pawsByExposure } from '../lib/conditions/pawBySurface';
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

describe('live paw reading for paths (Phase 5)', () => {
  const hot = { paws: pawsByExposure({ airC: 30, shortwaveWm2: 900, windKmh: 3 }) };

  it('calls an asphalt path too hot and a grass path kind, under the same sun', () => {
    expect(popupModel('surface', { level: 'high', surface: 'asphalt' }, 22, hot).title).toBe('Too hot for paws right now');
    expect(popupModel('surface', { level: 'low', surface: 'grass' }, 22, hot).title).toBe('Kind to paws right now');
    expect(popupModel('surface', { level: 'high', surface: 'asphalt' }, 22, hot).details[0]).toMatch(/^Paws now: about \d+–\d+ °C/);
  });

  it('reads a path under trees as cooler, and says so', () => {
    const shaded = popupModel('surface', { level: 'high', surface: 'asphalt' }, 22, { ...hot, shade: 'dense' });
    expect(shaded.title).toBe('Kind to paws right now');
    expect(shaded.details[0]).toMatch(/in the shade of trees/);
  });

  it('falls back to the material when no weather is loaded', () => {
    expect(popupModel('surface', { level: 'high', surface: 'asphalt' }, 22).title).toBe('Hot surface (asphalt, concrete)');
  });
});


describe('bathing spots (Phase 6)', () => {
  const site = { bwid: 'NLBW07_VRL01', name: 'DE VROLIJK', category: 'Lake', quality: 'Excellent', quality_year: '2022', profile: 'https://www.zwemwater.nl/', level: 'monitored' };

  it('never says "safe", names the season of the class, and links the official source', () => {
    const model = popupModel('water', site, 99, { month: 7 });
    expect(model.title).toBe('Official bathing spot');
    expect(model.details).toContain('EU classification (2022 season): Excellent');
    expect(model.note).toMatch(/not a safety guarantee/);
    expect(model.sourceUrl).toBe('https://www.zwemwater.nl/');
    expect(JSON.stringify(model)).not.toMatch(/\bsafe to swim\b/i);
  });

  it('has no OpenStreetMap link: this is EEA data', () => {
    expect(popupModel('water', site, 1233, { month: 7 }).osmUrl).toBeUndefined();
  });

  it('says plainly when it is outside the bathing season', () => {
    expect(popupModel('water', site, 1, { month: 11 }).details).toContain(
      'Outside the bathing season: it is not being monitored right now.',
    );
  });

  it('turns into a warning when the runtime feed names the site', () => {
    const warnings = parseWaterWarnings({
      warnings: [{ bwid: 'NLBW07_VRL01', kind: 'bluegreen_algae', message: 'Blue-green algae present.', url: 'https://example.org/n' }],
    });
    const model = popupModel('water', site, 1, { month: 7, warnings });
    expect(model.title).toBe('Blue-green algae');
    expect(model.details[0]).toBe('Blue-green algae present.');
    expect(model.icon?.glyph).toBe('alert');
    expect(model.sourceUrl).toBe('https://example.org/n');
  });
});
