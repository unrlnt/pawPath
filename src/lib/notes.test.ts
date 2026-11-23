import { describe, expect, it } from 'vitest';

import { NOTE_MAX_LENGTH } from '../config';
import { noteText, reportKindFor } from './notes';

describe('OSM note text', () => {
  it('says what is missing, with suggested tags and a check request', () => {
    const text = noteText({ kind: 'bagDispenser', change: 'missing' }, 'https://pawpath.example');
    expect(text).toContain('Poop-bag dispenser here, not yet on the map');
    expect(text).toContain('vending=excrement_bags');
    expect(text).toContain('Please check on the ground');
    expect(text).toContain('https://pawpath.example');
  });

  it('links the mapped object when something is gone, and keeps the walker’s words', () => {
    const text = noteText(
      { kind: 'bench', change: 'gone', osmUrl: 'https://www.openstreetmap.org/node/1', comment: 'Removed in the park works.' },
      'https://p.example',
    );
    expect(text).toContain('The bench mapped here seems to be gone: https://www.openstreetmap.org/node/1.');
    expect(text).toContain('Removed in the park works.');
  });

  it('never exceeds what OSM accepts', () => {
    expect(noteText({ kind: 'bin', change: 'missing', comment: 'x'.repeat(5000) }, 'u').length).toBe(NOTE_MAX_LENGTH);
  });

  it('only offers permanent amenities', () => {
    expect(reportKindFor('benches', undefined)).toBe('bench');
    expect(reportKindFor('waste', 'dog_bin')).toBe('dogBin');
    expect(reportKindFor('waste', 'bag_dispenser')).toBe('bagDispenser');
    expect(reportKindFor('waste', 'general')).toBe('bin');
    expect(reportKindFor('water', 'monitored')).toBeUndefined();
    expect(reportKindFor('offLeash', 'off_leash')).toBeUndefined();
  });
});
